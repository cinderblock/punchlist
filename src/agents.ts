import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { type Actor, type IntegrationActor, type Scope, type AgentActor, isScope } from "./actors.ts";
import { audit } from "./audit.ts";
import { site } from "./config.server.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import { ForbiddenError, NotFoundError, UserInputError } from "./errors.ts";
import { AGENT_NAME_MAX_LENGTH } from "./limits.ts";
import { getUser } from "./users.ts";

/**
 * Agents and integrations: everything that authenticates with a bearer token.
 *
 * An agent is a row owned by one user, with a name, scopes and its own token
 * `pl_<agentid>_<secret>`. The token is shown once and only its hash is kept.
 * Its rights are worked out afresh on every request, against its owner's
 * current state: revoking it, or deactivating the owner, ends it at once.
 *
 * An integration is declared in the config file with the name of an environment
 * variable holding its token. It has no owner and never sees a private task.
 */

export interface Agent {
  id: string;
  ownerUserId: number;
  ownerName: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface AgentRow {
  id: string;
  owner_user_id: number;
  owner_name: string;
  name: string;
  scopes: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const SELECT = `SELECT a.id, a.owner_user_id, u.name AS owner_name, a.name, a.scopes, a.token_hash, a.created_at, a.last_used_at, a.revoked_at
                  FROM agents a JOIN users u ON u.id = a.owner_user_id`;

function parseScopes(raw: string): Scope[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isScope) : [];
  } catch {
    return [];
  }
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  name: r.name,
  scopes: parseScopes(r.scopes),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

/** Create an agent. The token is returned here and never again. */
export function createAgent(args: { ownerUserId: number; name: string; scopes: readonly unknown[]; actorUserId: number; now?: number }): { agent: Agent; token: string } {
  const now = args.now ?? Date.now();
  const name = typeof args.name === "string" ? args.name.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new UserInputError("Give the agent a name, like Claude Code.");
  if (name.length > AGENT_NAME_MAX_LENGTH) throw new UserInputError(`Agent names are limited to ${AGENT_NAME_MAX_LENGTH} characters.`);
  const scopes = [...new Set(args.scopes)].filter(isScope);
  if (scopes.length === 0) throw new UserInputError("Pick at least one thing this agent may do.");
  if (scopes.length !== new Set(args.scopes).size) throw new UserInputError("One of those scopes doesn't exist.");
  const owner = getUser(args.ownerUserId);
  if (!owner?.active) throw new UserInputError("That person isn't active.");

  const id = randomBytes(6).toString("hex");
  const token = `pl_${id}_${randomToken(32)}`;
  db()
    .query("INSERT INTO agents (id, owner_user_id, name, scopes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, owner.id, name, JSON.stringify(scopes), sha256Hex(token), now);
  audit({ actorUserId: args.actorUserId, entity: "agent", entityId: id, action: "create", after: { owner: owner.id, name, scopes }, at: now });
  return { agent: getAgent(id)!, token };
}

export function getAgent(id: string): Agent | null {
  const row = db().query<AgentRow, [string]>(`${SELECT} WHERE a.id = ?`).get(id);
  return row ? toAgent(row) : null;
}

/** A person's agents, live ones first, newest first. Hashes never leave this module. */
export function listAgents(ownerUserId: number): Agent[] {
  return db()
    .query<AgentRow, [number]>(`${SELECT} WHERE a.owner_user_id = ? ORDER BY a.revoked_at IS NOT NULL, a.created_at DESC`)
    .all(ownerUserId)
    .map(toAgent);
}

/** Every live agent, for admins. */
export function listAllAgents(): Agent[] {
  return db().query<AgentRow, []>(`${SELECT} WHERE a.revoked_at IS NULL ORDER BY u.name COLLATE NOCASE, a.created_at DESC`).all().map(toAgent);
}

/** Revoked by its owner or an admin. It stops working on its next request. */
export function revokeAgent(args: { id: string; actor: Actor; now?: number }): void {
  const agent = getAgent(args.id);
  const actor = args.actor;
  if (actor.kind !== "user") throw new ForbiddenError("Agents are revoked by their owner or an admin.");
  if (!agent || (agent.ownerUserId !== actor.userId && actor.role !== "admin")) throw new NotFoundError("That agent doesn't exist.");
  const now = args.now ?? Date.now();
  const changed = db().query("UPDATE agents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL").run(now, actor.userId, args.id).changes;
  if (changed) audit({ actorUserId: actor.userId, entity: "agent", entityId: args.id, action: "revoke", at: now });
}

const TOKEN = /^pl_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const LAST_USED_EVERY_MS = 60_000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function equalHash(given: string, stored: string): boolean {
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The agent this token belongs to, if the token, the agent and its owner are all good right now. */
function authenticateAgent(token: string, now: number): AgentActor | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const row = db().query<AgentRow, [string]>(`${SELECT} WHERE a.id = ?`).get(match[1]!);
  if (!row || row.revoked_at != null) return null;
  if (!equalHash(sha256Hex(token), row.token_hash)) return null;
  const owner = getUser(row.owner_user_id);
  if (!owner?.active) return null;
  if (now - (row.last_used_at ?? 0) >= LAST_USED_EVERY_MS) {
    db().query("UPDATE agents SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return { kind: "agent", agentId: row.id, name: row.name, ownerUserId: owner.id, ownerName: owner.name, scopes: parseScopes(row.scopes) };
}

/** Long enough that a guessed or leftover short value can't open an integration. */
export const INTEGRATION_TOKEN_MIN_LENGTH = 32;

function authenticateIntegration(token: string): IntegrationActor | null {
  const given = digest(token);
  let found: IntegrationActor | null = null;
  // Every entry is compared, so the time taken doesn't say which one matched.
  for (const entry of site().integrations) {
    const secret = process.env[entry.tokenEnv];
    if (!secret || secret.length < INTEGRATION_TOKEN_MIN_LENGTH) continue;
    if (timingSafeEqual(given, digest(secret))) {
      found = { kind: "integration", integrationId: entry.id, name: entry.name, scopes: entry.scopes, via: entry.via };
    }
  }
  return found;
}

/** Turn a bearer token into an actor, or null. There is no third case. */
export function authenticateBearer(token: string, now: number = Date.now()): AgentActor | IntegrationActor | null {
  return authenticateAgent(token, now) ?? authenticateIntegration(token);
}

/** Integrations declared but not usable, for the startup log. */
export function integrationProblems(): string[] {
  return site()
    .integrations.filter((i) => (process.env[i.tokenEnv]?.length ?? 0) < INTEGRATION_TOKEN_MIN_LENGTH)
    .map((i) => `[config] integration ${i.id} is off: ${i.tokenEnv} is unset or under ${INTEGRATION_TOKEN_MIN_LENGTH} characters`);
}
