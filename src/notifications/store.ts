import { audit } from "../audit.ts";
import { config } from "../config.server.ts";
import { db } from "../db.server.ts";
import { UserInputError } from "../errors.ts";
import { describeUserAgent } from "../user-agent.ts";
import { type NotificationPrefs, parsePrefs } from "./prefs-schema.ts";

// ---- subscriptions ------------------------------------------------------------------

export interface Subscription {
  id: number;
  userId: number;
  sessionId: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  createdAt: number;
  lastSentAt: number | null;
  lastError: string | null;
  failures: number;
}

interface SubscriptionRow {
  id: number;
  user_id: number;
  session_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
  last_sent_at: number | null;
  last_error: string | null;
  failures: number;
}

const SUB_COLUMNS = "id, user_id, session_id, endpoint, p256dh, auth, label, created_at, last_sent_at, last_error, failures";

const toSubscription = (r: SubscriptionRow): Subscription => ({
  id: r.id,
  userId: r.user_id,
  sessionId: r.session_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  label: r.label,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
  lastError: r.last_error,
  failures: r.failures,
});

/** The browser's PushSubscription.toJSON(), as posted by the settings page. */
export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const BASE64URL = /^[A-Za-z0-9_-]+=*$/;

/** A known push service. The server itself makes this request, so where it goes can't be up to the client. */
export function pushHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return config.push.endpointHosts.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
}

export function parseBrowserSubscription(value: unknown): BrowserSubscription {
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof v?.endpoint === "string" ? v.endpoint : "";
  const p256dh = typeof v?.keys?.p256dh === "string" ? v.keys.p256dh : "";
  const auth = typeof v?.keys?.auth === "string" ? v.keys.auth : "";
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  // Push services are always https. Anything else is not a browser's
  // subscription, and the server would be the one making the request.
  if (!url || url.protocol !== "https:" || endpoint.length > 1000 || !pushHostAllowed(url.hostname)) {
    throw new UserInputError("This browser's notification subscription didn't look right.");
  }
  if (!BASE64URL.test(p256dh) || !BASE64URL.test(auth) || p256dh.length > 200 || auth.length > 100) {
    throw new UserInputError("This browser's notification subscription didn't look right.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Turn notifications on for one browser. Re-subscribing the same browser (same
 * endpoint) takes it over: it now belongs to whoever is signed in there. Only
 * signed-in people get here, so an on-site visitor can never subscribe.
 */
export function addSubscription(args: { userId: number; sessionId: string; subscription: BrowserSubscription; userAgent: string | null; now?: number }): Subscription {
  const now = args.now ?? Date.now();
  const { endpoint, keys } = args.subscription;
  const label = describeUserAgent(args.userAgent);
  const row = db()
    .query<SubscriptionRow, [number, string, string, string, string, string, number]>(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, p256dh, auth, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, session_id = excluded.session_id,
         p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
         failures = 0, last_error = NULL
       RETURNING ${SUB_COLUMNS}`,
    )
    .get(args.userId, args.sessionId, endpoint, keys.p256dh, keys.auth, label, now)!;
  audit({ actorUserId: args.userId, entity: "push_subscription", entityId: row.id, action: "add", after: { label }, at: now });
  return toSubscription(row);
}

/** Turn one device off: the person's own, by id or by this browser's endpoint. */
export function removeSubscription(args: { userId: number; id?: number; endpoint?: string }): boolean {
  const row =
    args.id != null
      ? db().query<{ id: number; label: string }, [number, number]>("SELECT id, label FROM push_subscriptions WHERE id = ? AND user_id = ?").get(args.id, args.userId)
      : db().query<{ id: number; label: string }, [string, number]>("SELECT id, label FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").get(args.endpoint ?? "", args.userId);
  if (!row) return false;
  db().query("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
  audit({ actorUserId: args.userId, entity: "push_subscription", entityId: row.id, action: "remove", before: { label: row.label } });
  return true;
}

/** Devices that should receive a person's notifications: the session they were turned on from is still signed in. */
export function liveSubscriptions(userId: number, now: number = Date.now()): Subscription[] {
  return db()
    .query<SubscriptionRow, [number, number]>(
      `SELECT ${SUB_COLUMNS.split(", ")
        .map((c) => `p.${c}`)
        .join(", ")}
         FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id
        WHERE p.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY p.created_at`,
    )
    .all(userId, now)
    .map(toSubscription);
}

export function listSubscriptions(userId: number): Subscription[] {
  return db().query<SubscriptionRow, [number]>(`SELECT ${SUB_COLUMNS} FROM push_subscriptions WHERE user_id = ? ORDER BY created_at`).all(userId).map(toSubscription);
}

/** People with at least one device that can receive notifications. */
export function peopleWithDevices(now: number = Date.now()): { userId: number; name: string }[] {
  return db()
    .query<{ user_id: number; name: string }, [number]>(
      `SELECT DISTINCT p.user_id, u.name
         FROM push_subscriptions p
         JOIN sessions s ON s.id = p.session_id
         JOIN users u ON u.id = p.user_id
        WHERE u.active = 1 AND s.revoked_at IS NULL AND s.expires_at > ?
        ORDER BY p.user_id`,
    )
    .all(now)
    .map((r) => ({ userId: r.user_id, name: r.name }));
}

/** After a send: a success clears the failure count; "gone" means the browser dropped it. */
export function recordDelivery(id: number, result: { ok: true } | { ok: false; gone: boolean; error: string }, now: number): void {
  if (result.ok) {
    db().query("UPDATE push_subscriptions SET last_sent_at = ?, failures = 0, last_error = NULL WHERE id = ?").run(now, id);
  } else if (result.gone) {
    db().query("DELETE FROM push_subscriptions WHERE id = ?").run(id);
  } else {
    db().query("UPDATE push_subscriptions SET failures = failures + 1, last_error = ? WHERE id = ?").run(result.error.slice(0, 300), id);
  }
}

// ---- preferences --------------------------------------------------------------------

export function getPrefs(userId: number): NotificationPrefs {
  const row = db().query<{ prefs: string }, [number]>("SELECT prefs FROM notification_prefs WHERE user_id = ?").get(userId);
  if (!row) return parsePrefs(undefined);
  try {
    return parsePrefs(JSON.parse(row.prefs));
  } catch {
    return parsePrefs(undefined);
  }
}

export function setPrefs(userId: number, value: unknown, now: number = Date.now()): NotificationPrefs {
  const prefs = parsePrefs(value);
  db()
    .query("INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at")
    .run(userId, JSON.stringify(prefs), now);
  return prefs;
}

// ---- what is to be sent, and what was -------------------------------------------------

export type NotificationKind = "assigned" | "comment" | "watch" | "due_soon" | "overdue" | "test";

export interface Queued {
  id: number;
  userId: number;
  kind: NotificationKind;
  key: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  taskId: string | null;
}

interface LogRow {
  id: number;
  user_id: number;
  kind: NotificationKind;
  key: string;
  title: string;
  body: string;
  url: string;
  created_at: number;
  sent_at: number | null;
  delivered: number;
  task_id: string | null;
}

const toQueued = (r: LogRow): Queued => ({ id: r.id, userId: r.user_id, kind: r.kind, key: r.key, title: r.title, body: r.body, url: r.url, createdAt: r.created_at, taskId: r.task_id });

/** Queue a notification. Each (person, kind, key) exists once, ever: that's the dedupe. */
export function enqueue(args: { userId: number; kind: NotificationKind; key: string; title: string; body: string; url: string; now: number; taskId?: string | null }): boolean {
  return (
    db()
      .query("INSERT OR IGNORE INTO notification_log (user_id, kind, key, title, body, url, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(args.userId, args.kind, args.key, args.title, args.body, args.url, args.now, args.taskId ?? null).changes > 0
  );
}

export function unsent(userId: number): Queued[] {
  return db().query<LogRow, [number]>("SELECT * FROM notification_log WHERE user_id = ? AND sent_at IS NULL ORDER BY id").all(userId).map(toQueued);
}

export function markSent(id: number, delivered: number, now: number): void {
  db().query("UPDATE notification_log SET sent_at = ?, delivered = ? WHERE id = ?").run(now, delivered, id);
}

export interface RecentNotification {
  id: number;
  title: string;
  body: string;
  url: string;
  at: number;
  delivered: number;
  waiting: boolean;
}

export function recentNotifications(userId: number, limit = 10): RecentNotification[] {
  return db()
    .query<LogRow, [number, number]>("SELECT * FROM notification_log WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit)
    .map((r) => ({ id: r.id, title: r.title, body: r.body, url: r.url, at: r.sent_at ?? r.created_at, delivered: r.delivered, waiting: r.sent_at == null }));
}

// ---- the notifier's place in task_events -----------------------------------------------

const CURSOR = "notifier_event_cursor";

export function eventCursor(): number {
  const row = db().query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(CURSOR);
  if (row) return Number(row.value);
  // First run: start from now, so an upgrade doesn't replay all of history.
  const { id } = db().query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM task_events").get()!;
  setEventCursor(id);
  return id;
}

export function setEventCursor(id: number): void {
  db().query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CURSOR, String(id));
}
