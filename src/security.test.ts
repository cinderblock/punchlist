import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import webpush from "web-push";
import { RRule } from "rrule";

import { actorId, userActor } from "./actors.ts";
import { authenticateBearer } from "./agents.ts";
import { startEnrollment } from "./auth-flows.ts";
import { addCredential, listCredentials, removeCredential } from "./credentials.ts";
import { config, setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, UserInputError } from "./errors.ts";
import { ceremonyRateKey, checkCeremonyRate } from "./http/ceremony-rate.ts";
import { hostAllowed } from "./http/host.ts";
import { resolveRequest } from "./http/resolve-actor.ts";
import { acknowledgeNotices, activeNotices, noticeHistory, noticeText } from "./notices.ts";
import { fakeSender, webPushSender } from "./notifications/send.ts";
import { addSubscription, parseBrowserSubscription, setPrefs, unsent } from "./notifications/store.ts";
import { runNotifications } from "./notifications/worker.ts";
import { findUsableRegistration, mintRegistration } from "./registrations.ts";
import { nextScheduled, validateSchedule } from "./recurrence.ts";
import { resolveSession } from "./sessions.ts";
import { createSession, listSessions } from "./sessions.ts";
import { addComment, activity, canSeeTask, completeTask, createTask, getTask, listAttachments, listTasks, removeAttachment, reopenTask, taskHistory, updateTask, addAttachment } from "./tasks.ts";
import { INTEGRATION_TOKEN, ORIGIN, type World, agentFor, freshWorld } from "./testing/fixtures.ts";
import { getUser, updateUserAccess } from "./users.ts";

/**
 * One regression test or more for each finding of an independent security review.
 * Each is named for what used to go wrong.
 */

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

const person = (a: World["alice"]) => getUser(a.userId)!;

function passkey(user: World["alice"], name: string) {
  return addCredential({ userId: user.userId, credentialId: name, publicKey: new Uint8Array(4), counter: 0, transports: [], deviceType: "singleDevice", backedUp: false, nickname: name });
}

describe("finding 1: an admin's recovery link can't be quiet", () => {
  test("making one for someone else signs them out everywhere at once", () => {
    const { token } = createSession({ userId: w.alice.userId, credentialId: null, userAgent: null });
    expect(resolveSession(token)).not.toBeNull();
    mintRegistration({ purpose: "add_device", userId: w.alice.userId, createdBy: w.admin.userId });
    expect(resolveSession(token)).toBeNull();
    expect(listSessions(w.alice.userId)).toEqual([]);
  });

  test("the owner is told who and when, and it stays in their history", () => {
    mintRegistration({ purpose: "add_device", userId: w.alice.userId, createdBy: w.admin.userId, now: 5000 });
    const [notice] = activeNotices(w.alice.userId, null);
    expect(notice).toMatchObject({ kind: "recovery_link", byName: "Addie Admin", at: 5000 });
    expect(noticeText(notice!, "Monday")).toContain("Addie Admin made a recovery link for your account on Monday");
    acknowledgeNotices({ userId: w.alice.userId, credentialId: null });
    expect(activeNotices(w.alice.userId, null)).toEqual([]);
    expect(noticeHistory(w.alice.userId)).toHaveLength(1);
  });

  test("someone's own add-a-device link is none of this", () => {
    const { token } = createSession({ userId: w.alice.userId, credentialId: null, userAgent: null });
    mintRegistration({ purpose: "add_device", userId: w.alice.userId, createdBy: w.alice.userId });
    expect(resolveSession(token)).not.toBeNull();
    expect(noticeHistory(w.alice.userId)).toEqual([]);
  });

  test("whoever used the link can't hide it from the owner's other passkeys", () => {
    const old = passkey(w.alice, "old-phone");
    const recovered = passkey(w.alice, "recovery-phone");
    db().query("INSERT INTO account_notices (user_id, kind, by_name, credential_id, created_at) VALUES (?, 'recovery_used', 'Addie Admin', ?, 1)").run(w.alice.userId, recovered.id);
    acknowledgeNotices({ userId: w.alice.userId, credentialId: recovered.id });
    expect(activeNotices(w.alice.userId, recovered.id)).toEqual([]);
    expect(activeNotices(w.alice.userId, old.id)).toHaveLength(1);
    acknowledgeNotices({ userId: w.alice.userId, credentialId: old.id });
    expect(activeNotices(w.alice.userId, old.id)).toEqual([]);
  });

  test("there's no code path that deletes a notice", async () => {
    const source = await Bun.file("src/notices.ts").text();
    expect(source).not.toMatch(/DELETE FROM account_notices/i);
  });
});

describe("finding 2: dedupe respects the task it matches", () => {
  test("an agent with no private scopes can't touch, or read, a task since made private", () => {
    const { actor } = agentFor(w.alice, ["tasks:read", "tasks:write"]);
    const { task } = createTask(actor, { title: "Sensor offline", details: "public text", dedupeKey: "k" });
    updateTask(w.alice, task.id, { title: "PRIVATE TITLE", visibility: "private" });

    let message = "";
    try {
      createTask(actor, { title: "overwrite", dedupeKey: "k" });
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("PRIVATE");
    expect(getTask(w.alice, task.id).title).toBe("PRIVATE TITLE");
  });

  test("an integration likewise", () => {
    const monitor = authenticateBearer(INTEGRATION_TOKEN)!;
    const { task } = createTask(monitor, { title: "Door offline", dedupeKey: "door" });
    updateTask(w.admin, task.id, { title: "Hidden", visibility: "private" });
    expect(() => createTask(monitor, { title: "again", dedupeKey: "door" })).toThrow(ConflictError);
    expect(getTask(w.admin, task.id).title).toBe("Hidden");
  });

  test("private text can't land on a public task through a key", () => {
    const { actor } = agentFor(w.alice);
    const { task } = createTask(actor, { title: "Public title", dedupeKey: "k" });
    expect(() => createTask(actor, { title: "SECRET", details: "SECRET", visibility: "private", dedupeKey: "k" })).toThrow(ConflictError);
    expect(getTask(w.lan, task.id).title).toBe("Public title");
    expect(getTask(w.lan, task.id).details).toBe("");
  });

  test("the same visibility still dedupes, in both", () => {
    const { actor } = agentFor(w.alice);
    expect(createTask(actor, { title: "a", visibility: "private", dedupeKey: "p" }).deduped).toBe(false);
    expect(createTask(actor, { title: "b", visibility: "private", dedupeKey: "p" }).deduped).toBe(true);
  });
});

describe("finding 3: a repeat rule can't stall the process", () => {
  const worst = [
    "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    "FREQ=DAILY;BYSETPOS=2",
    "FREQ=DAILY;INTERVAL=7;BYDAY=MO",
    "FREQ=WEEKLY;BYMONTH=2;BYMONTHDAY=31",
    "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=6",
    "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31",
    "FREQ=YEARLY;BYSETPOS=366;BYMONTH=2",
  ];
  for (const rule of worst) {
    test(`${rule} is refused in milliseconds`, () => {
      // 2026-01-06 is a Tuesday, so the INTERVAL=7 rule never meets a Monday.
      const started = performance.now();
      expect(() => validateSchedule(rule, "2026-01-06")).toThrow(/never lands/);
      expect(performance.now() - started).toBeLessThan(100);
    });
  }

  test("through createTask, as it was reported", () => {
    const started = performance.now();
    expect(() => createTask(w.alice, { title: "x", recurrence: { kind: "schedule", rrule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30" } })).toThrow(UserInputError);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a walk with COUNT from an ancient start stays bounded", () => {
    const started = performance.now();
    nextScheduled("FREQ=DAILY;COUNT=9999;BYSETPOS=2", "0100-01-01", "2026-01-01");
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("nonsense in a rule's values is a clear refusal", () => {
    const { parseRrule } = require("./recurrence.ts") as typeof import("./recurrence.ts");
    for (const bad of ["FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=x", "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=WEEKLY;BYDAY=XX", "FREQ=DAILY;UNTIL=soon", "FREQ=YEARLY;BYMONTH=13"]) {
      expect(() => parseRrule(bad)).toThrow(UserInputError);
    }
  });

  // The evaluator replaces the library's search, so it's held to the library's answers.
  const rules = [
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=3",
    "FREQ=DAILY;BYDAY=MO,FR",
    "FREQ=DAILY;BYMONTH=3",
    "FREQ=WEEKLY",
    "FREQ=WEEKLY;INTERVAL=2",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU",
    "FREQ=MONTHLY",
    "FREQ=MONTHLY;INTERVAL=3",
    "FREQ=MONTHLY;BYMONTHDAY=31",
    "FREQ=MONTHLY;BYMONTHDAY=-1",
    "FREQ=MONTHLY;BYDAY=1MO",
    "FREQ=MONTHLY;BYDAY=-1FR",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=MONTHLY;BYDAY=2TU,4TU",
    "FREQ=YEARLY",
    "FREQ=YEARLY;BYMONTH=3,9",
    "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "FREQ=YEARLY;BYDAY=20MO",
    "FREQ=DAILY;COUNT=5",
    "FREQ=WEEKLY;COUNT=3;BYDAY=TU",
    "FREQ=MONTHLY;UNTIL=20260601",
  ];
  const anchors = ["2026-01-05", "2026-01-31", "2024-02-29"];
  for (const rule of rules) {
    test(`agrees with the rrule library on ${rule}`, () => {
      for (const anchor of anchors) {
        const dtstart = new Date(`${anchor}T00:00:00Z`);
        const lib = new RRule({ ...RRule.parseString(rule), dtstart });
        let after = anchor;
        for (let i = 0; i < 12; i++) {
          const expected = lib.after(new Date(`${after}T00:00:00Z`), false)?.toISOString().slice(0, 10) ?? null;
          expect(nextScheduled(rule, anchor, after)).toBe(expected);
          if (!expected) break;
          after = expected;
        }
      }
    });
  }
});

describe("finding 4: one caller can't block everyone's sign-in", () => {
  const signin = (ip?: string) => new Request(`${ORIGIN}/api/passkey/signin-options`, { method: "POST", headers: ip ? { "X-Client-Ip": ip } : {} });
  const ipHeader = { site: undefined, perimeterHeader: null, clientIpHeader: "x-client-ip" };

  test("with the header unset it's ignored, and there's one shared bucket", () => {
    expect(ceremonyRateKey(signin("203.0.113.9"))).toBeNull();
    for (let i = 0; i < 300; i++) checkCeremonyRate(signin("203.0.113.9"), 1000);
    expect(() => checkCeremonyRate(signin("198.51.100.1"), 1000)).toThrow(RateLimitedError);
  });

  test("with it set, each address has its own limit, and a flood from one blocks only that one", () => {
    setConfigForTests(ipHeader);
    for (let i = 0; i < 30; i++) checkCeremonyRate(signin("203.0.113.9"), 1000);
    expect(() => checkCeremonyRate(signin("203.0.113.9"), 1000)).toThrow(RateLimitedError);
    expect(() => checkCeremonyRate(signin("198.51.100.1"), 1000)).not.toThrow();
  });

  test("a value that isn't one plain address falls back to the shared bucket", () => {
    setConfigForTests(ipHeader);
    expect(ceremonyRateKey(signin("1.2.3.4, 5.6.7.8"))).toBeNull();
    expect(ceremonyRateKey(signin("not an address"))).toBeNull();
    expect(ceremonyRateKey(signin())).toBeNull();
    expect(ceremonyRateKey(signin("2001:DB8::1"))).toBe("2001:db8::1");
  });

  test("it never feeds a permission", async () => {
    setConfigForTests(ipHeader);
    const resolved = await resolveRequest(new Request(`${ORIGIN}/api/v1/tasks`, { headers: { "X-Client-Ip": "10.0.0.1" } }));
    expect(resolved.actor.kind).toBe("nobody");
  });
});

describe("finding 5: links don't outlive their maker's standing", () => {
  test("a demoted admin's open invites die", () => {
    const { token } = mintRegistration({ purpose: "invite", role: "admin", createdBy: w.admin.userId });
    expect(findUsableRegistration(token)).not.toBeNull();
    const second = person(w.alice);
    updateUserAccess({ userId: second.id, role: "admin", actorUserId: w.admin.userId });
    updateUserAccess({ userId: w.admin.userId, role: "member", actorUserId: second.id });
    expect(findUsableRegistration(token)).toBeNull();
  });

  test("a deactivated person's open links die, and stay dead after reactivation", () => {
    updateUserAccess({ userId: w.alice.userId, role: "admin", actorUserId: w.admin.userId });
    const { token } = mintRegistration({ purpose: "invite", createdBy: w.alice.userId });
    updateUserAccess({ userId: w.alice.userId, active: false, actorUserId: w.admin.userId });
    updateUserAccess({ userId: w.alice.userId, active: true, actorUserId: w.admin.userId });
    expect(findUsableRegistration(token)).toBeNull();
  });

  test("anyone else's links are untouched", () => {
    const { token } = mintRegistration({ purpose: "invite", createdBy: w.admin.userId });
    updateUserAccess({ userId: w.bob.userId, active: false, actorUserId: w.admin.userId });
    expect(findUsableRegistration(token)).not.toBeNull();
  });
});

describe("finding 6: removing a passkey cuts off what it signed in", () => {
  test("its sessions die in the same step, and others live", () => {
    const lost = passkey(w.alice, "lost");
    const kept = passkey(w.alice, "kept");
    const onLost = createSession({ userId: w.alice.userId, credentialId: lost.id, userAgent: null });
    const onKept = createSession({ userId: w.alice.userId, credentialId: kept.id, userAgent: null });
    removeCredential({ id: lost.id, userId: w.alice.userId, actorUserId: w.admin.userId });
    expect(resolveSession(onLost.token)).toBeNull();
    expect(resolveSession(onKept.token)).not.toBeNull();
    expect(listCredentials(w.alice.userId).map((c) => c.id)).toEqual([kept.id]);
  });
});

describe("finding 7: a stray link can't swap accounts", () => {
  test("Add a passkey in Settings ignores a join cookie, and enrols the signed-in person", async () => {
    const attackers = mintRegistration({ purpose: "add_device", userId: w.bob.userId, createdBy: w.bob.userId });
    const { options } = await startEnrollment({ intent: "self", joinToken: attackers.token, currentUser: person(w.alice), name: null });
    expect(options.user.name).toBe("Alice Member");
    expect(findUsableRegistration(attackers.token)).not.toBeNull();
  });

  test("a link for another account does nothing until the person says so", async () => {
    const attackers = mintRegistration({ purpose: "add_device", userId: w.bob.userId, createdBy: w.bob.userId });
    await expect(startEnrollment({ intent: "link", joinToken: attackers.token, currentUser: person(w.alice), name: null })).rejects.toThrow(/different account/);
    const { options } = await startEnrollment({ intent: "link", confirmedSwitch: true, joinToken: attackers.token, currentUser: person(w.alice), name: null });
    expect(options.user.name).toBe("Bob Member");
  });

  test("an invite while signed in asks too", async () => {
    const invite = mintRegistration({ purpose: "invite", createdBy: w.admin.userId });
    await expect(startEnrollment({ intent: "link", joinToken: invite.token, currentUser: person(w.alice), name: "New" })).rejects.toThrow(/different account/);
  });

  test("your own link needs no confirmation", async () => {
    const mine = mintRegistration({ purpose: "add_device", userId: w.alice.userId, createdBy: w.alice.userId });
    const { options } = await startEnrollment({ intent: "link", joinToken: mine.token, currentUser: person(w.alice), name: null });
    expect(options.user.name).toBe("Alice Member");
  });

  test("a link page with no link in hand is refused, not treated as self", async () => {
    await expect(startEnrollment({ intent: "link", joinToken: null, currentUser: person(w.alice), name: null })).rejects.toThrow(/expired/);
  });
});

describe("finding 8: only a person destroys anything", () => {
  const file = (id: string) => ({ id, filename: "f", mime: "application/octet-stream", size: 1, sha256: "x", width: null, height: null, hasThumb: false });

  test("an agent can't remove an attachment, even its own", () => {
    const { actor } = agentFor(w.alice);
    const { task } = createTask(w.alice, { title: "A" });
    const view = addAttachment(actor, task.id, file("01900000-0000-7000-8000-0000000000aa"));
    expect(view.canDelete).toBe(false);
    expect(() => removeAttachment(actor, view.id)).toThrow(ForbiddenError);
    expect(listAttachments(w.alice, task.id)).toHaveLength(1);
    removeAttachment(w.alice, view.id);
  });

  const series = () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2026-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    completeTask(w.alice, task.id);
    const next = listTasks(w.alice, { status: "open" })[0]!;
    return { task, next };
  };

  test("an on-site visitor's reopen leaves the next occurrence in place", () => {
    const { task, next } = series();
    expect(reopenTask(w.lan, task.id).status).toBe("open");
    expect(listTasks(w.alice).map((t) => t.id).sort()).toEqual([task.id, next.id].sort());
    expect(taskHistory(w.alice, next.id).map((e) => e.type)).not.toContain("superseded");
  });

  test("an agent's too, and the reopened one has left the series", () => {
    const { task, next } = series();
    const reopened = reopenTask(agentFor(w.alice).actor, task.id);
    expect(reopened.recurrence).toBeNull();
    expect(getTask(w.alice, next.id).recurrence).not.toBeNull();
    // Completing the stray makes no third occurrence.
    completeTask(w.alice, task.id);
    expect(listTasks(w.alice).map((t) => t.id)).toEqual([next.id]);
  });

  test("a person's undo still takes the next one back", () => {
    const { task, next } = series();
    reopenTask(w.alice, task.id);
    expect(listTasks(w.alice).map((t) => t.id)).toEqual([task.id]);
    expect(taskHistory(w.alice, task.id).map((e) => e.type)).toContain("reopened");
    expect(() => getTask(w.alice, next.id)).toThrow(NotFoundError);
  });
});

describe("finding 9: past occurrences follow the series", () => {
  const twoOccurrences = (extra = {}) => {
    const { task } = createTask(w.alice, { title: "Weekly round", dueDate: "2026-01-05", recurrence: { kind: "schedule", rrule: "FREQ=WEEKLY" }, ...extra });
    completeTask(w.alice, task.id);
    return { past: task, live: listTasks(w.alice, { status: "open" })[0]! };
  };

  test("going private takes the history private too", () => {
    const { past, live } = twoOccurrences();
    updateTask(w.alice, live.id, { visibility: "private" });
    expect(getTask(w.alice, past.id).visibility).toBe("private");
    expect(() => getTask(w.lan, past.id)).toThrow(NotFoundError);
    expect(() => getTask(w.bob, past.id)).toThrow(NotFoundError);
    expect(listTasks(w.lan, { status: "all" })).toEqual([]);
  });

  test("shares apply across the series, both ways", () => {
    const { past, live } = twoOccurrences({ visibility: "private" });
    updateTask(w.alice, live.id, { sharedWith: [w.bob.userId] });
    expect(getTask(w.bob, past.id).id).toBe(past.id);
    updateTask(w.alice, live.id, { sharedWith: [] });
    expect(() => getTask(w.bob, past.id)).toThrow(NotFoundError);
  });

  test("someone assigned an old occurrence loses sight of it when the series goes private", () => {
    const { past, live } = twoOccurrences({ assignees: [w.bob.userId] });
    updateTask(w.alice, live.id, { visibility: "private", assignees: [] });
    expect(() => getTask(w.bob, past.id)).toThrow(NotFoundError);
  });

  test("going public again brings them back", () => {
    const { past, live } = twoOccurrences({ visibility: "private" });
    updateTask(w.alice, live.id, { visibility: "public" });
    expect(getTask(w.lan, past.id).visibility).toBe("public");
  });

  test("a series keeps its link through a stopped or changed rule", () => {
    const { past, live } = twoOccurrences();
    updateTask(w.alice, live.id, { recurrence: { kind: "after_completion", intervalDays: 7 } });
    updateTask(w.alice, live.id, { recurrence: null });
    updateTask(w.alice, live.id, { visibility: "private" });
    expect(() => getTask(w.lan, past.id)).toThrow(NotFoundError);
  });
});

describe("finding 10: push can't be pointed at anything", () => {
  const keys = { p256dh: "abc", auth: "def" };

  test("only known push services are accepted", () => {
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/w/x"]) {
      expect(parseBrowserSubscription({ endpoint, keys }).endpoint).toBe(endpoint);
    }
    for (const endpoint of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://internal.example/x", "https://evilfcm.googleapis.com.example/x", "https://notapush.apple.com/x"]) {
      expect(() => parseBrowserSubscription({ endpoint, keys })).toThrow(UserInputError);
    }
  });

  test("config can replace the list, which is how a test service gets in", () => {
    const hosts = config.push.endpointHosts;
    config.push.endpointHosts = ["127.0.0.1"];
    expect(parseBrowserSubscription({ endpoint: "https://127.0.0.1:9443/push/x", keys }).endpoint).toContain("127.0.0.1");
    expect(() => parseBrowserSubscription({ endpoint: "https://fcm.googleapis.com/x", keys })).toThrow(UserInputError);
    config.push.endpointHosts = hosts;
  });

  test("a response body never comes back out", async () => {
    const saved = { ...config.push };
    Object.assign(config.push, { vapidPublicKey: "p", vapidPrivateKey: "k", vapidSubject: "mailto:x@example.invalid" });
    const send = spyOn(webpush, "sendNotification").mockRejectedValue({ statusCode: 500, body: "INTERNAL SECRET PAGE" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = await webPushSender().send({ endpoint: "https://fcm.googleapis.com/x", p256dh: "a", auth: "b" }, "{}", { ttl: 1, topic: "t", urgency: "low" });
    send.mockRestore();
    warn.mockRestore();
    Object.assign(config.push, saved);
    expect(result).toEqual({ ok: false, gone: false, error: "The push service answered 500." });
  });
});

describe("finding 12: a queued push is re-read before it goes", () => {
  const NIGHT = Date.UTC(2026, 10, 4, 7); // 11 PM in Los Angeles
  const MORNING = Date.UTC(2026, 10, 4, 16); // 8 AM

  function device() {
    const { session } = createSession({ userId: w.bob.userId, credentialId: null, userAgent: null, now: NIGHT });
    addSubscription({ userId: w.bob.userId, sessionId: session.id, subscription: { endpoint: "https://push.example.test/b", keys: { p256dh: "a", auth: "b" } }, userAgent: null, now: NIGHT });
  }
  const pass = async (now: number) => {
    const { sender, sent } = fakeSender();
    await runNotifications({ sender, now, timeZone: "America/Los_Angeles" });
    return sent.map((s) => (s.payload.notification as { title: string; body: string }));
  };

  test("a task that went private during quiet hours never reaches them", async () => {
    device();
    await pass(NIGHT);
    const { task } = createTask(w.alice, { title: "SECRET later", assignees: [w.bob.userId] }, { now: NIGHT });
    expect(await pass(NIGHT)).toEqual([]);
    expect(unsent(w.bob.userId)).toHaveLength(1);
    updateTask(w.alice, task.id, { visibility: "private", assignees: [] });
    const sent = await pass(MORNING);
    expect(JSON.stringify(sent)).not.toContain("SECRET");
    expect(unsent(w.bob.userId)).toEqual([]);
  });

  test("a queued digest says what's true when it goes, not when it was queued", async () => {
    device();
    setPrefs(w.bob.userId, { assigned: false, overdueDigest: { on: true, at: "00:00" }, dueSoon: { on: false } });
    await pass(NIGHT);
    const secret = createTask(w.alice, { title: "SECRET overdue", dueDate: "2026-01-01", assignees: [w.bob.userId] }).task;
    createTask(w.alice, { title: "Plain overdue", dueDate: "2026-01-01", assignees: [w.bob.userId] });
    await pass(NIGHT);
    updateTask(w.alice, secret.id, { assignees: [] });
    const digest = (await pass(MORNING)).find((n) => /^\d+ overdue/.test(n.title))!;
    expect(digest.title).toBe("1 overdue task");
    expect(digest.body).not.toContain("SECRET");
  });
});

describe("finding 13: only the public host is served", () => {
  const PUBLIC = "todo.example.test";

  test("the public host, in any case", () => {
    expect(hostAllowed(PUBLIC, "/", PUBLIC)).toBe(true);
    expect(hostAllowed("TODO.Example.TEST", "/api/v1/tasks", PUBLIC)).toBe(true);
  });

  test("anything else is refused, on every path but one", () => {
    for (const host of ["evil.example", "localhost", "127.0.0.1:3000", "", undefined]) {
      expect(hostAllowed(host, "/", PUBLIC)).toBe(false);
      expect(hostAllowed(host, "/api/v1/tasks", PUBLIC)).toBe(false);
      expect(hostAllowed(host, "/healthz/", PUBLIC)).toBe(false);
    }
  });

  test("the container's own health check gets through", () => {
    expect(hostAllowed("127.0.0.1:3000", "/healthz", PUBLIC)).toBe(true);
    expect(hostAllowed("localhost", "/healthz", PUBLIC)).toBe(true);
  });
});

describe("finding 14: history doesn't reveal who a task is shared with", () => {
  const setup = () => {
    const { task } = createTask(w.alice, { title: "Mine", visibility: "private", assignees: [w.bob.userId] });
    updateTask(w.alice, task.id, { sharedWith: [w.admin.userId] });
    return task.id;
  };
  const sharesIn = (events: { payload: Record<string, unknown> }[]) => events.filter((e) => (e.payload.changes as Record<string, unknown> | undefined)?.sharedWith);

  test("someone assigned, who can't manage access, doesn't get it", () => {
    expect(sharesIn(taskHistory(w.bob, setup()))).toEqual([]);
  });

  test("the owner does", () => {
    expect(sharesIn(taskHistory(w.alice, setup()))).toHaveLength(1);
  });

  test("activity never carries it", () => {
    setup();
    expect(sharesIn(activity(w.alice))).toEqual([]);
    expect(sharesIn(activity(w.bob))).toEqual([]);
  });
});

test("the actors are real, for the record", () => {
  expect(actorId(userActor(person(w.alice)))).toBe(`user:${w.alice.userId}`);
  expect(canSeeTask(w.lan, "nothing")).toBe(false);
  expect(addComment).toBeTruthy();
});
