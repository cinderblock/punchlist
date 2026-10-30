import { audit } from "./audit.ts";
import { randomToken } from "./crypto.ts";
import { db } from "./db.server.ts";
import { UserInputError } from "./errors.ts";
import { NAME_MAX_LENGTH } from "./limits.ts";

export { UserInputError };

export type Role = "admin" | "member";

export interface User {
  id: number;
  name: string;
  role: Role;
  webauthnUserId: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: number;
  name: string;
  role: Role;
  webauthn_user_id: string;
  active: number;
  created_at: number;
  updated_at: number;
}

const COLUMNS = "id, name, role, webauthn_user_id, active, created_at, updated_at";

function toUser(r: UserRow): User {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    webauthnUserId: r.webauthn_user_id,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export { NAME_MAX_LENGTH };

/** Trim and validate a display name. Throws with a user-presentable message. */
export function normalizeName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new UserInputError("Enter a name.");
  if (name.length > NAME_MAX_LENGTH) throw new UserInputError(`Names are limited to ${NAME_MAX_LENGTH} characters.`);
  return name;
}

/** A fresh WebAuthn user handle: 32 random bytes, base64url. */
export function newWebauthnUserId(): string {
  return randomToken(32);
}

export function createUser(args: {
  name: string;
  role: Role;
  webauthnUserId?: string;
  actorUserId: number | null;
  now?: number;
}): User {
  const now = args.now ?? Date.now();
  const name = normalizeName(args.name);
  const row = db()
    .query<UserRow, [string, Role, string, number, number]>(
      `INSERT INTO users (name, role, webauthn_user_id, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(name, args.role, args.webauthnUserId ?? newWebauthnUserId(), now, now)!;
  const user = toUser(row);
  audit({ actorUserId: args.actorUserId, entity: "user", entityId: user.id, action: "create", after: { name: user.name, role: user.role }, at: now });
  return user;
}

export function getUser(id: number): User | null {
  const row = db().query<UserRow, [number]>(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
  return row ? toUser(row) : null;
}

export function countActiveAdmins(): number {
  return db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get()!.n;
}

export interface UserSummary extends User {
  passkeyCount: number;
  lastSeenAt: number | null;
}

/** Everyone, for the admin people list: active first, then by name. */
export function listUsers(): UserSummary[] {
  const rows = db()
    .query<UserRow & { passkey_count: number; last_seen_at: number | null }, []>(
      `SELECT ${COLUMNS.split(", ")
        .map((c) => `u.${c}`)
        .join(", ")},
              (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkey_count,
              (SELECT MAX(s.last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
         FROM users u
        ORDER BY u.active DESC, u.name COLLATE NOCASE`,
    )
    .all();
  return rows.map((r) => ({ ...toUser(r), passkeyCount: r.passkey_count, lastSeenAt: r.last_seen_at }));
}

/** Names of the active people, for assigning and sharing. No roles or anything else. */
export function listPeople(): { id: number; name: string }[] {
  return db().query<{ id: number; name: string }, []>("SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE").all();
}

export function renameUser(args: { userId: number; name: string; actorUserId: number }): User {
  const user = mustGet(args.userId);
  const name = normalizeName(args.name);
  if (name === user.name) return user;
  db().query("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), user.id);
  audit({ actorUserId: args.actorUserId, entity: "user", entityId: user.id, action: "rename", before: { name: user.name }, after: { name } });
  return mustGet(user.id);
}

/**
 * Change role and/or active state.
 *
 * Refuses anything that would leave the space with no active admin: that state
 * can only be escaped from a shell on the server, so the UI must never be able
 * to reach it.
 *
 * Deactivating ends everything the person holds at once: sessions here, and
 * their agents and feeds because those re-check the owner on every use.
 */
export function updateUserAccess(args: { userId: number; role?: Role; active?: boolean; actorUserId: number }): User {
  const database = db();
  return database.transaction(() => {
    const user = mustGet(args.userId);
    const role = args.role ?? user.role;
    const active = args.active ?? user.active;
    if (role === user.role && active === user.active) return user;

    const losesAdmin = user.role === "admin" && user.active && (role !== "admin" || !active);
    if (losesAdmin && countActiveAdmins() <= 1) {
      throw new UserInputError("This is the only active admin. Make someone else an admin first.");
    }

    database.query("UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?").run(role, active ? 1 : 0, Date.now(), user.id);

    // A link carries its maker's standing, so it goes when the standing does.
    if (losesAdmin || (!active && user.active)) {
      for (const r of database.query<{ id: number }, [number]>("SELECT id FROM registrations WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL").all(user.id)) {
        database.query("UPDATE registrations SET revoked_at = ? WHERE id = ?").run(Date.now(), r.id);
        audit({ actorUserId: args.actorUserId, entity: "registration", entityId: r.id, action: "revoke", after: { reason: "maker lost access" } });
      }
    }

    if (!active && user.active) {
      // A deactivated person must not stay signed in anywhere.
      database.query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), user.id);
    }

    audit({
      actorUserId: args.actorUserId,
      entity: "user",
      entityId: user.id,
      action: "access",
      before: { role: user.role, active: user.active },
      after: { role, active },
    });
    return mustGet(user.id);
  })();
}

function mustGet(id: number): User {
  const user = getUser(id);
  if (!user) throw new UserInputError("That person no longer exists.");
  return user;
}
