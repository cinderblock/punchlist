import { randomBytes } from "node:crypto";

import { userActor } from "./actors.ts";
import { audit } from "./audit.ts";
import { config, site } from "./config.server.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import { NotFoundError, UserInputError } from "./errors.ts";
import { calendar } from "./ics.ts";
import { FEED_NAME_MAX_LENGTH, TASK_LIST_MAX_LIMIT } from "./limits.ts";
import { listTasks } from "./tasks.ts";
import { type User, getUser } from "./users.ts";

/**
 * Calendar feeds. A calendar client can't present a passkey, so a feed is a
 * capability URL, /feeds/<random>.ics: hashed at rest, revocable, named, with
 * last-used shown. It's bound to a user and re-checked on every fetch, so
 * deactivating a person kills their feeds.
 *
 * A feed reads through the domain layer as its owner, so it can never show more
 * than they could, and then filters down. Reading is all it can do. It never
 * carries attachment URLs.
 */

export type FeedScope = "public" | "public_and_mine" | "labels";
export type PrivateMode = "off" | "titles" | "full";

export interface Feed {
  id: string;
  ownerUserId: number;
  name: string;
  scope: FeedScope;
  labelIds: number[];
  privateMode: PrivateMode;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface FeedRow {
  id: string;
  owner_user_id: number;
  name: string;
  token_hash: string;
  scope: FeedScope;
  label_ids: string;
  private_mode: PrivateMode;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toFeed = (r: FeedRow): Feed => ({
  id: r.id,
  ownerUserId: r.owner_user_id,
  name: r.name,
  scope: r.scope,
  labelIds: JSON.parse(r.label_ids) as number[],
  privateMode: r.private_mode,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const SCOPES: readonly FeedScope[] = ["public", "public_and_mine", "labels"];
const MODES: readonly PrivateMode[] = ["off", "titles", "full"];

export function feedUrl(token: string): string {
  return `${config.publicBaseUrl}/feeds/${token}.ics`;
}

/** Make a feed. The URL is returned here and never again. */
export function createFeed(args: { ownerUserId: number; name: string; scope: FeedScope; labelIds?: number[]; privateMode?: PrivateMode; now?: number }): { feed: Feed; url: string } {
  const now = args.now ?? Date.now();
  const name = args.name?.trim().replace(/\s+/g, " ");
  if (!name) throw new UserInputError("Give the feed a name, like Work calendar.");
  if (name.length > FEED_NAME_MAX_LENGTH) throw new UserInputError(`Feed names are limited to ${FEED_NAME_MAX_LENGTH} characters.`);
  if (!SCOPES.includes(args.scope)) throw new UserInputError("Pick what the feed covers.");
  const privateMode = args.privateMode ?? "off";
  if (!MODES.includes(privateMode)) throw new UserInputError("Pick how private tasks appear.");
  const labelIds = args.scope === "labels" ? [...new Set(args.labelIds ?? [])] : [];
  if (args.scope === "labels" && labelIds.length === 0) throw new UserInputError("Pick at least one label.");

  const id = randomBytes(6).toString("hex");
  const token = randomToken(32);
  db()
    .query("INSERT INTO feeds (id, owner_user_id, name, token_hash, scope, label_ids, private_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, args.ownerUserId, name, sha256Hex(token), args.scope, JSON.stringify(labelIds), privateMode, now);
  audit({ actorUserId: args.ownerUserId, entity: "feed", entityId: id, action: "create", after: { name, scope: args.scope, privateMode }, at: now });
  const row = db().query<FeedRow, [string]>("SELECT * FROM feeds WHERE id = ?").get(id)!;
  return { feed: toFeed(row), url: feedUrl(token) };
}

export function listFeeds(ownerUserId: number): Feed[] {
  return db()
    .query<FeedRow, [number]>("SELECT * FROM feeds WHERE owner_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .all(ownerUserId)
    .map(toFeed);
}

export function revokeFeed(args: { id: string; ownerUserId: number; now?: number }): void {
  const now = args.now ?? Date.now();
  const changed = db().query("UPDATE feeds SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL").run(now, args.id, args.ownerUserId).changes;
  if (!changed) throw new NotFoundError("That feed doesn't exist.");
  audit({ actorUserId: args.ownerUserId, entity: "feed", entityId: args.id, action: "revoke", at: now });
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LAST_USED_EVERY_MS = 60_000;

/** The live feed and active owner this token names, or null. */
function resolveFeed(token: string): { feed: Feed; owner: User } | null {
  if (!TOKEN.test(token)) return null;
  const row = db().query<FeedRow, [string]>("SELECT * FROM feeds WHERE token_hash = ? AND revoked_at IS NULL").get(sha256Hex(token));
  if (!row) return null;
  const owner = getUser(row.owner_user_id);
  if (!owner?.active) return null;
  return { feed: toFeed(row), owner };
}

/** The .ics text for a token, or null if the token is no good. */
export function renderFeed(token: string, now: number = Date.now()): string | null {
  const resolved = resolveFeed(token);
  if (!resolved) return null;
  const { feed, owner } = resolved;
  // The person, as a plain member: a feed gets nothing from its owner being an admin.
  const actor = userActor({ ...owner, role: "member" });
  const labelIds = new Set(feed.labelIds);

  const tasks = listTasks(actor, { status: "open", limit: TASK_LIST_MAX_LIMIT })
    // All-day events need a day: tasks with no due date stay out.
    .filter((t) => t.dueDate != null)
    .filter((t) => (t.visibility === "private" ? feed.privateMode !== "off" : true))
    .filter((t) => {
      if (feed.scope === "labels") return t.labels.some((l) => labelIds.has(l.id));
      return true;
    });

  if (now - (feed.lastUsedAt ?? 0) >= LAST_USED_EVERY_MS) {
    db().query("UPDATE feeds SET last_used_at = ? WHERE id = ?").run(now, feed.id);
  }

  return calendar({
    name: `${site().name}: ${feed.name}`,
    host: new URL(config.publicBaseUrl).hostname,
    now,
    events: tasks.map((t) => {
      const titleOnly = t.visibility === "private" && feed.privateMode === "titles";
      return {
        uid: t.id,
        title: t.title,
        date: t.dueDate!,
        updatedAt: t.updatedAt,
        description: titleOnly ? null : [t.details, `Added by ${t.createdBy}`].filter(Boolean).join("\n\n"),
        location: titleOnly ? null : [t.location?.zoneName, t.location?.note].filter(Boolean).join(", ") || null,
      };
    }),
  });
}
