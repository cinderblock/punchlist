import { userActor } from "../actors.ts";
import { config } from "../config.server.ts";
import { db } from "../db.server.ts";
import { DomainError } from "../errors.ts";
import { type TaskView, getTask, listTasks } from "../tasks.ts";
import { addDays, clockToMinutes, dateOf, formatDue, minutesOfDay } from "../time.ts";
import { getUser } from "../users.ts";
import { installNotifierKick } from "./kick.ts";
import type { NotificationPrefs } from "./prefs-schema.ts";
import { type PushSender, pushConfigured, webPushSender } from "./send.ts";
import {
  type NotificationKind,
  type Queued,
  enqueue,
  eventCursor,
  getPrefs,
  liveSubscriptions,
  markSent,
  peopleWithDevices,
  recordDelivery,
  setEventCursor,
  unsent,
} from "./store.ts";

/**
 * The notifier. Two steps, so that nothing is lost to a crash or quiet hours:
 *
 *   decide  Read task_events past the cursor, and the calendar, and queue what
 *           each person should hear about in notification_log.
 *   send    For each person not in quiet hours, send what's queued.
 *
 * A notification is only ever queued after reading the task as the person it's
 * for, through the domain layer. A task they can't see produces nothing.
 */

/** How long a push service may hold a message for a device that's off. */
const TTL_SECONDS: Record<NotificationKind, number> = {
  assigned: 24 * 3600,
  comment: 24 * 3600,
  watch: 24 * 3600,
  due_soon: 12 * 3600,
  overdue: 12 * 3600,
  test: 300,
};

/** Queued this long ago and still not sent: it's old news, not a message. */
const STALE_MS = 24 * 3600_000;

interface EventRow {
  id: number;
  task_id: string;
  actor_id: string;
  actor_label: string;
  on_behalf_of: string | null;
  type: string;
  payload: string;
}

/** Read a task as a person. Null if they can't see it. */
function taskAs(userId: number, taskId: string): TaskView | null {
  const user = getUser(userId);
  if (!user?.active) return null;
  try {
    return getTask(userActor({ ...user, role: "member" }), taskId);
  } catch (err) {
    if (err instanceof DomainError) return null;
    throw err;
  }
}

const url = (taskId: string) => `/tasks/${taskId}`;

/** Neither your own hand nor your own agent should buzz your phone. */
const isOwnAction = (e: EventRow, userId: number) => e.actor_id === `user:${userId}` || e.on_behalf_of === `user:${userId}`;

function ownerOfTask(taskId: string): number | null {
  return db().query<{ owner_user_id: number | null }, [string]>("SELECT owner_user_id FROM tasks WHERE id = ?").get(taskId)?.owner_user_id ?? null;
}

function eventQueues(e: EventRow, watchers: { userId: number; prefs: NotificationPrefs }[], now: number): void {
  const payload = JSON.parse(e.payload) as {
    assignees?: number[];
    labels?: number[];
    body?: string;
    changes?: { assignees?: { from: number[]; to: number[] } };
  };

  // Assigned to me.
  const newlyAssigned =
    e.type === "created"
      ? (payload.assignees ?? [])
      : e.type === "updated" && payload.changes?.assignees
        ? payload.changes.assignees.to.filter((id) => !payload.changes!.assignees!.from.includes(id))
        : [];
  for (const userId of newlyAssigned) {
    if (isOwnAction(e, userId) || !getPrefs(userId).assigned) continue;
    const task = taskAs(userId, e.task_id);
    if (task) enqueue({ userId, kind: "assigned", key: `${e.id}`, title: `Assigned to you: ${task.title}`, body: `By ${e.actor_label}`, url: url(task.id), now });
  }

  // A comment on my task.
  if (e.type === "commented") {
    const assignees = db().query<{ user_id: number }, [string]>("SELECT user_id FROM task_assignees WHERE task_id = ?").all(e.task_id).map((r) => r.user_id);
    const owner = ownerOfTask(e.task_id);
    for (const userId of new Set([...assignees, ...(owner != null ? [owner] : [])])) {
      if (isOwnAction(e, userId) || !getPrefs(userId).comments) continue;
      const task = taskAs(userId, e.task_id);
      if (task) enqueue({ userId, kind: "comment", key: `${e.id}`, title: `${e.actor_label} on ${task.title}`, body: payload.body ?? "", url: url(task.id), now });
    }
  }

  // New in something I watch.
  if (e.type === "created") {
    for (const { userId, prefs } of watchers) {
      if (isOwnAction(e, userId) || newlyAssigned.includes(userId)) continue;
      if (prefs.watch.labels.length === 0 && prefs.watch.zones.length === 0) continue;
      const task = taskAs(userId, e.task_id);
      if (!task) continue;
      const label = task.labels.find((l) => prefs.watch.labels.includes(l.id))?.name;
      const zone = task.location?.zoneId && prefs.watch.zones.includes(task.location.zoneId) ? task.location.zoneName : null;
      if (label || zone) {
        enqueue({ userId, kind: "watch", key: task.id, title: `New in ${label ?? zone}: ${task.title}`, body: `Added by ${task.createdBy}`, url: url(task.id), now });
      }
    }
  }
}

/** Turn new events into queued notifications, moving the cursor in the same transaction. */
export function decideFromEvents(now: number): void {
  const database = db();
  database.transaction(() => {
    const cursor = eventCursor();
    const events = database
      .query<EventRow, [number]>("SELECT id, task_id, actor_id, actor_label, on_behalf_of, type, payload FROM task_events WHERE id > ? ORDER BY id LIMIT 500")
      .all(cursor);
    if (events.length === 0) return;
    const watchers = peopleWithDevices(now).map((p) => ({ userId: p.userId, prefs: getPrefs(p.userId) }));
    for (const e of events) eventQueues(e, watchers, now);
    setEventCursor(events[events.length - 1]!.id);
  })();
}

/** My tasks: on my plate, or private and mine. */
function myTasks(userId: number): TaskView[] {
  const user = getUser(userId);
  if (!user?.active) return [];
  const actor = userActor({ ...user, role: "member" });
  const assigned = listTasks(actor, { status: "open", assignee: userId });
  const owned = listTasks(actor, { status: "open", visibility: "private" }).filter((t) => t.assignees.length === 0 && ownerOfTask(t.id) === userId);
  return [...assigned, ...owned];
}

/** The daily ones, once their time of day has passed. */
export function decideFromCalendar(userId: number, prefs: NotificationPrefs, now: number, timeZone: string): void {
  const today = dateOf(now, timeZone);
  const minute = minutesOfDay(now, timeZone);
  const mine = () => myTasks(userId);

  if (prefs.dueSoon.on && minute >= clockToMinutes(prefs.dueSoon.at)) {
    const until = addDays(today, prefs.dueSoon.days);
    for (const task of mine()) {
      if (!task.dueDate || task.dueDate < today || task.dueDate > until) continue;
      enqueue({ userId, kind: "due_soon", key: `${task.id}:${task.dueDate}`, title: task.title, body: `Due ${formatDue(task.dueDate, today).toLowerCase()}`, url: url(task.id), now });
    }
  }

  if (prefs.overdueDigest.on && minute >= clockToMinutes(prefs.overdueDigest.at)) {
    const overdue = mine().filter((t) => t.dueDate && t.dueDate < today);
    if (overdue.length > 0) {
      const titles = overdue.slice(0, 3).map((t) => t.title).join(", ");
      const more = overdue.length > 3 ? `, and ${overdue.length - 3} more` : "";
      enqueue({ userId, kind: "overdue", key: today, title: overdue.length === 1 ? "1 overdue task" : `${overdue.length} overdue tasks`, body: `${titles}${more}`, url: "/?mine=1", now });
    }
  }
}

/** Is this minute inside the person's quiet window? It may cross midnight. */
export function inQuietHours(prefs: NotificationPrefs, now: number, timeZone: string): boolean {
  if (!prefs.quietHours.on) return false;
  const minute = minutesOfDay(now, timeZone);
  const from = clockToMinutes(prefs.quietHours.from);
  const until = clockToMinutes(prefs.quietHours.until);
  if (from === until) return false;
  return from < until ? minute >= from && minute < until : minute >= from || minute < until;
}

export function isPaused(prefs: NotificationPrefs, now: number, timeZone: string): boolean {
  return prefs.pausedThrough != null && dateOf(now, timeZone) <= prefs.pausedThrough;
}

/**
 * The payload, in Declarative Web Push form (iOS 18.4+ shows it with no service
 * worker involved). Everywhere else our service worker reads the same fields.
 * `navigate` has to be absolute.
 */
export function pushPayload(n: Pick<Queued, "title" | "body" | "url" | "kind">, id: number): string {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: n.title,
      body: n.body,
      navigate: `${config.publicBaseUrl}${n.url}`,
      lang: "en",
      // One digest on screen at a time; every task keeps its own.
      tag: n.kind === "overdue" ? "pl-overdue" : `pl-${n.kind}-${id}`,
      silent: false,
    },
  });
}

async function sendOne(n: Queued, sender: PushSender, now: number, endpoint?: string): Promise<{ devices: number; delivered: number; errors: string[] }> {
  const targets = liveSubscriptions(n.userId, now).filter((s) => !endpoint || s.endpoint === endpoint);
  const payload = pushPayload(n, n.id);
  let delivered = 0;
  const errors: string[] = [];
  for (const target of targets) {
    const result = await sender.send(target, payload, {
      ttl: TTL_SECONDS[n.kind],
      topic: `pl-${n.id}`.replaceAll("_", "-").slice(0, 32),
      urgency: n.kind === "test" ? "high" : "normal",
    });
    recordDelivery(target.id, result, now);
    if (result.ok) delivered++;
    else errors.push(`${target.label}: ${result.error}`);
  }
  markSent(n.id, delivered, now);
  return { devices: targets.length, delivered, errors };
}

/** One full pass. Returns how many notifications went out. */
export async function runNotifications(args: { sender: PushSender; now?: number; timeZone?: string }): Promise<number> {
  const now = args.now ?? Date.now();
  const timeZone = args.timeZone ?? config.timezone;
  decideFromEvents(now);

  let sent = 0;
  for (const person of peopleWithDevices(now)) {
    const prefs = getPrefs(person.userId);
    if (isPaused(prefs, now, timeZone)) {
      // Paused means not sent at all, not sent later.
      for (const n of unsent(person.userId)) markSent(n.id, 0, now);
      continue;
    }
    decideFromCalendar(person.userId, prefs, now, timeZone);
    if (inQuietHours(prefs, now, timeZone)) continue;
    for (const n of unsent(person.userId)) {
      if (now - n.createdAt > STALE_MS) {
        markSent(n.id, 0, now);
        continue;
      }
      await sendOne(n, args.sender, now);
      sent++;
    }
  }
  return sent;
}

export async function sendTest(args: { userId: number; sender: PushSender; endpoint?: string; now?: number }) {
  const now = args.now ?? Date.now();
  const key = `test:${now}`;
  enqueue({ userId: args.userId, kind: "test", key, title: "Notifications are working", body: "This device will get the alerts you've chosen.", url: "/settings/notifications", now });
  const n = unsent(args.userId).find((q) => q.key === key)!;
  return sendOne(n, args.sender, now, args.endpoint);
}

let senderOverride: PushSender | null = null;

/** The sender the app uses: the real one, unless a test put a fake in. */
export function appSender(): PushSender {
  return senderOverride ?? webPushSender();
}

export function setSenderForTests(sender: PushSender | null): void {
  senderOverride = sender;
}

const TIMER_KEY = "__punchlistNotifyTimer__";
type GlobalWithTimer = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** Start the loop, once per process, when push is configured. */
export function startNotificationWorker(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[TIMER_KEY]) return;
  if (!pushConfigured()) return;
  const every = config.push.checkEverySeconds * 1000;
  if (every === 0) {
    console.log("[notify] reminders are off (NOTIFY_EVERY_SECONDS=0); test notifications still send");
    return;
  }
  let running = false;
  let again = false;
  const tick = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    runNotifications({ sender: appSender() })
      .then((n) => {
        if (n) console.log(`[notify] sent ${n} notification${n === 1 ? "" : "s"}`);
      })
      .catch((err) => console.error("[notify] pass failed:", err))
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          tick();
        }
      });
  };
  g[TIMER_KEY] = setInterval(tick, every);
  g[TIMER_KEY].unref?.();
  // Someone just assigned a task: don't make them wait out the minute.
  let soon: ReturnType<typeof setTimeout> | null = null;
  installNotifierKick(() => {
    soon ??= setTimeout(() => {
      soon = null;
      tick();
    }, 500);
  });
  setTimeout(tick, 10_000).unref?.();
  console.log(`[notify] checking every ${every / 1000}s`);
}
