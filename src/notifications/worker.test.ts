import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { UserActor } from "../actors.ts";
import { setConfigForTests } from "../config.server.ts";
import { db } from "../db.server.ts";
import { createSession } from "../sessions.ts";
import { addComment, completeTask, createTask, updateTask } from "../tasks.ts";
import { type World, agentFor, freshWorld } from "../testing/fixtures.ts";
import { parsePrefs } from "./prefs-schema.ts";
import { fakeSender } from "./send.ts";
import { addSubscription, parseBrowserSubscription, recentNotifications, removeSubscription, setPrefs, unsent } from "./store.ts";
import { inQuietHours, pushPayload, runNotifications, sendTest } from "./worker.ts";

const ZONE = "America/Los_Angeles";
/** Noon in Los Angeles: past every reminder time and outside default quiet hours. */
const NOON = Date.UTC(2026, 10, 3, 20);

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

function device(user: UserActor, name: string, now = NOON) {
  const { session } = createSession({ userId: user.userId, credentialId: null, userAgent: null, now });
  return addSubscription({ userId: user.userId, sessionId: session.id, subscription: { endpoint: `https://push.example.test/${name}`, keys: { p256dh: "abc", auth: "def" } }, userAgent: null, now });
}

async function pass(now = NOON) {
  const { sender, sent } = fakeSender();
  await runNotifications({ sender, now, timeZone: ZONE });
  return sent;
}

/** Past the first pass, which sets the cursor to now. */
async function ready(now = NOON) {
  await pass(now);
}

const titles = (sent: { payload: Record<string, unknown> }[]) => sent.map((s) => (s.payload.notification as { title: string }).title);

describe("triggers", () => {
  test("assigned to me", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(w.alice, { title: "Oil the press", assignees: [w.bob.userId] });
    expect(titles(await pass())).toEqual(["Assigned to you: Oil the press"]);
  });

  test("not when I assigned it to myself, or my agent did", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(w.bob, { title: "Mine", assignees: [w.bob.userId] });
    createTask(agentFor(w.bob).actor, { title: "Also mine", assignees: [w.bob.userId] });
    expect(await pass()).toEqual([]);
  });

  test("assigned later, by an edit, once", async () => {
    device(w.bob, "bob");
    await ready();
    const { task } = createTask(w.alice, { title: "Oil the press" });
    updateTask(w.alice, task.id, { assignees: [w.bob.userId] });
    updateTask(w.alice, task.id, { details: "with the good oil" });
    expect(titles(await pass())).toEqual(["Assigned to you: Oil the press"]);
  });

  test("names an agent as the agent", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(agentFor(w.alice).actor, { title: "From an agent", assignees: [w.bob.userId] });
    const [message] = await pass();
    expect((message!.payload.notification as { body: string }).body).toBe("By Helper, for Alice Member");
  });

  test("a comment on my task", async () => {
    device(w.alice, "alice");
    await ready();
    const { task } = createTask(w.alice, { title: "Mine" });
    addComment(w.bob, task.id, { body: "On it" });
    addComment(w.alice, task.id, { body: "Thanks" });
    expect(titles(await pass())).toEqual(["Bob Member on Mine"]);
  });

  test("new tasks in a watched label or zone", async () => {
    device(w.bob, "bob");
    const { id: labelId } = db().query<{ id: number }, []>("SELECT id FROM labels WHERE name = 'safety'").get()!;
    setPrefs(w.bob.userId, { watch: { labels: [labelId], zones: ["bay-2"] } });
    await ready();
    createTask(w.alice, { title: "Guard is loose", labels: ["safety"] });
    createTask(w.alice, { title: "Light out", location: { zoneId: "bay-2" } });
    createTask(w.alice, { title: "Unwatched" });
    expect(titles(await pass()).sort()).toEqual(["New in Bay 2: Light out", "New in safety: Guard is loose"]);
  });

  test("due soon, once, after its time of day", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(w.alice, { title: "Tomorrow's", dueDate: "2026-11-04", assignees: [w.alice.userId] });
    const early = Date.UTC(2026, 10, 3, 15); // 7 AM, past quiet hours but before 8
    db().exec("INSERT INTO task_assignees (task_id, user_id) SELECT id, " + w.bob.userId + " FROM tasks");
    expect(titles(await pass(early))).toEqual([]);
    expect(titles(await pass(NOON))).toEqual(["Tomorrow's"]);
    expect(titles(await pass(NOON + 3_600_000))).toEqual([]);
  });

  test("the overdue digest is one message a day", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(w.alice, { title: "Late one", dueDate: "2026-10-01", assignees: [w.bob.userId] });
    createTask(w.alice, { title: "Late two", dueDate: "2026-10-02", assignees: [w.bob.userId] });
    const sent = titles(await pass());
    expect(sent.filter((t) => t === "2 overdue tasks")).toHaveLength(1);
    expect(titles(await pass(NOON + 60_000))).toEqual([]);
    expect(titles(await pass(NOON + 86_400_000))).toContain("2 overdue tasks");
  });
});

describe("visibility", () => {
  test("a notification is only ever about a task its reader can see", async () => {
    device(w.bob, "bob");
    device(w.admin, "admin");
    const { id: labelId } = db().query<{ id: number }, []>("SELECT id FROM labels WHERE name = 'safety'").get()!;
    setPrefs(w.bob.userId, { watch: { labels: [labelId], zones: [] } });
    setPrefs(w.admin.userId, { watch: { labels: [labelId], zones: [] } });
    await ready();
    createTask(w.alice, { title: "SECRET", labels: ["safety"], visibility: "private", assignees: [] });
    expect(await pass()).toEqual([]);
  });

  test("being assigned a private task is how you come to see it", async () => {
    device(w.bob, "bob");
    await ready();
    createTask(w.alice, { title: "Private one", visibility: "private", assignees: [w.bob.userId] });
    expect(titles(await pass())).toEqual(["Assigned to you: Private one"]);
  });

  test("a task gone private before the send doesn't reach someone who lost sight of it", async () => {
    device(w.bob, "bob");
    await ready();
    const { task } = createTask(w.alice, { title: "Going private", assignees: [w.bob.userId] });
    updateTask(w.alice, task.id, { assignees: [], visibility: "private" });
    expect(await pass()).toEqual([]);
  });
});

describe("delivery", () => {
  test("quiet hours hold a message, and the end of them sends it", async () => {
    device(w.bob, "bob");
    await ready();
    const night = Date.UTC(2026, 10, 4, 7); // 11 PM
    createTask(w.alice, { title: "Late night", assignees: [w.bob.userId] }, { now: night });
    expect(await pass(night)).toEqual([]);
    expect(unsent(w.bob.userId)).toHaveLength(1);
    expect(recentNotifications(w.bob.userId)[0]!.waiting).toBe(true);
    const morning = Date.UTC(2026, 10, 4, 16); // 8 AM
    expect(titles(await pass(morning))).toContain("Assigned to you: Late night");
  });

  test("the window can cross midnight, or not", () => {
    const prefs = parsePrefs({ quietHours: { on: true, from: "21:00", until: "07:00" } });
    expect(inQuietHours(prefs, Date.UTC(2026, 10, 4, 7), ZONE)).toBe(true); // 11 PM
    expect(inQuietHours(prefs, Date.UTC(2026, 10, 4, 12), ZONE)).toBe(true); // 4 AM
    expect(inQuietHours(prefs, NOON, ZONE)).toBe(false);
    const day = parsePrefs({ quietHours: { on: true, from: "09:00", until: "17:00" } });
    expect(inQuietHours(day, NOON, ZONE)).toBe(true);
    expect(inQuietHours(parsePrefs({ quietHours: { on: false } }), NOON, ZONE)).toBe(false);
  });

  test("paused means not sent at all, not sent later", async () => {
    device(w.bob, "bob");
    setPrefs(w.bob.userId, { pausedThrough: "2026-11-03" });
    await ready();
    createTask(w.alice, { title: "While away", assignees: [w.bob.userId] });
    expect(await pass()).toEqual([]);
    setPrefs(w.bob.userId, { pausedThrough: null });
    expect(await pass(NOON + 1000)).toEqual([]);
  });

  test("a choice turned off stays off", async () => {
    device(w.bob, "bob");
    setPrefs(w.bob.userId, { assigned: false });
    await ready();
    createTask(w.alice, { title: "Quietly", assignees: [w.bob.userId] });
    expect(await pass()).toEqual([]);
  });

  test("a subscription that's gone is forgotten", async () => {
    const sub = device(w.bob, "bob");
    await ready();
    createTask(w.alice, { title: "x", assignees: [w.bob.userId] });
    const { sender } = fakeSender(() => ({ ok: false, gone: true, error: "410" }));
    await runNotifications({ sender, now: NOON, timeZone: ZONE });
    expect(db().query("SELECT 1 FROM push_subscriptions WHERE id = ?").get(sub.id)).toBeNull();
  });

  test("signing out stops a device getting anything", async () => {
    const { session } = createSession({ userId: w.bob.userId, credentialId: null, userAgent: null, now: NOON });
    addSubscription({ userId: w.bob.userId, sessionId: session.id, subscription: { endpoint: "https://push.example.test/x", keys: { p256dh: "a", auth: "b" } }, userAgent: null });
    db().query("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(NOON, session.id);
    await ready();
    createTask(w.alice, { title: "x", assignees: [w.bob.userId] });
    expect(await pass()).toEqual([]);
  });

  test("the cursor means nothing goes twice, or from before it started", async () => {
    createTask(w.alice, { title: "Old news", assignees: [w.bob.userId] });
    device(w.bob, "bob");
    expect(await pass()).toEqual([]);
    expect(await pass()).toEqual([]);
  });

  test("a test goes to the one device asked for", async () => {
    device(w.bob, "one");
    device(w.bob, "two");
    const { sender, sent } = fakeSender();
    await sendTest({ userId: w.bob.userId, sender, endpoint: "https://push.example.test/two", now: NOON });
    expect(sent.map((s) => s.target.endpoint)).toEqual(["https://push.example.test/two"]);
  });

  test("a device can be turned off", () => {
    const sub = device(w.bob, "bob");
    expect(removeSubscription({ userId: w.alice.userId, id: sub.id })).toBe(false);
    expect(removeSubscription({ userId: w.bob.userId, id: sub.id })).toBe(true);
  });
});

test("the payload is Declarative Web Push, with an absolute navigate", () => {
  const payload = JSON.parse(pushPayload({ title: "T", body: "B", url: "/tasks/1", kind: "assigned" }, 7));
  expect(payload.web_push).toBe(8030);
  expect(payload.notification.title).toBe("T");
  expect(payload.notification.navigate).toMatch(/^https?:\/\/[^/]+\/tasks\/1$/);
});

test("only a browser's real subscription is accepted", () => {
  const keys = { p256dh: "abc", auth: "def" };
  expect(parseBrowserSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/1", keys }).endpoint).toBeTruthy();
  expect(() => parseBrowserSubscription({ endpoint: "http://push.example.test/1", keys })).toThrow();
  expect(() => parseBrowserSubscription({ endpoint: "file:///etc/passwd", keys })).toThrow();
  expect(() => parseBrowserSubscription(null)).toThrow();
});

test("prefs read from anything", () => {
  expect(parsePrefs({ dueSoon: { days: 99, at: "nonsense" } }).dueSoon).toMatchObject({ days: 1, at: "08:00" });
  expect(parsePrefs("nonsense").assigned).toBe(true);
  expect(completeTask).toBeTruthy();
});
