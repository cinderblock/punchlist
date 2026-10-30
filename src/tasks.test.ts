import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { config, setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { ConflictError, RateLimitedError, UserInputError } from "./errors.ts";
import { subscribe } from "./live.ts";
import { addComment, completeByDedupeKey, completeTask, createLabel, createTask, deleteTask, getTask, listLabels, listTasks, listZones, reopenTask, seedLabels, taskHistory, updateTask } from "./tasks.ts";
import { type World, TEST_SITE, agentFor, freshWorld } from "./testing/fixtures.ts";
import { dateOf } from "./time.ts";

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

const events = (id: string) => taskHistory(w.alice, id).map((e) => e.type);

describe("every change is an event", () => {
  test("in order, with who, how and what", () => {
    const { task } = createTask(w.alice, { title: "A" }, { via: "ui" });
    updateTask(w.bob, task.id, { title: "B" }, { via: "api" });
    addComment(w.bob, task.id, { body: "On it" });
    completeTask(w.lan, task.id);
    reopenTask(w.alice, task.id);
    deleteTask(w.alice, task.id);

    const rows = db().query<{ type: string; actor_label: string; via: string; payload: string }, [string]>("SELECT type, actor_label, via, payload FROM task_events WHERE task_id = ? ORDER BY id").all(task.id);
    expect(rows.map((r) => r.type)).toEqual(["created", "updated", "commented", "completed", "reopened", "deleted"]);
    expect(rows[1]!.actor_label).toBe("Bob Member");
    expect(rows[1]!.via).toBe("api");
    expect(JSON.parse(rows[1]!.payload)).toEqual({ changes: { title: { from: "A", to: "B" } } });
  });

  test("the table is append-only, enforced by the database", () => {
    createTask(w.alice, { title: "A" });
    expect(() => db().exec("UPDATE task_events SET actor_label = 'someone else'")).toThrow(/append-only/);
    expect(() => db().exec("DELETE FROM task_events")).toThrow(/append-only/);
  });

  test("a change that fails leaves no event and no change", () => {
    const { task } = createTask(w.alice, { title: "A" });
    const before = events(task.id).length;
    expect(() => updateTask(w.alice, task.id, { title: "B", labels: ["no such label"] })).toThrow(UserInputError);
    expect(getTask(w.alice, task.id).title).toBe("A");
    expect(events(task.id).length).toBe(before);
  });

  test("an edit that changes nothing records nothing", () => {
    const { task } = createTask(w.alice, { title: "A" });
    const rev = getTask(w.alice, task.id).rev;
    updateTask(w.alice, task.id, { title: "A" });
    expect(events(task.id)).toEqual(["created"]);
    expect(getTask(w.alice, task.id).rev).toBe(rev);
  });

  test("the live bus hears only after the commit", () => {
    const heard: string[] = [];
    const off = subscribe((e) => heard.push(e.taskId));
    const { task } = createTask(w.alice, { title: "A" });
    expect(() => updateTask(w.alice, task.id, { labels: ["no such label"] })).toThrow();
    off();
    expect(heard).toEqual([task.id]);
  });
});

describe("check-off", () => {
  test("two people tapping is one check-off", () => {
    const { task } = createTask(w.alice, { title: "A" });
    completeTask(w.lan, task.id);
    const again = completeTask(w.bob, task.id);
    expect(again.completedBy).toBe("On-site device");
    expect(events(task.id)).toEqual(["created", "completed"]);
  });

  test("a queued check-off keeps the time it happened, within reason", () => {
    const { task } = createTask(w.alice, { title: "A" });
    const now = Date.now();
    expect(completeTask(w.alice, task.id, { at: now - 3_600_000 }, { now }).completedAt).toBe(now - 3_600_000);
    const second = createTask(w.alice, { title: "B" }).task;
    expect(completeTask(w.alice, second.id, { at: now + 3_600_000 }, { now }).completedAt).toBe(now);
    const third = createTask(w.alice, { title: "C" }).task;
    expect(completeTask(w.alice, third.id, { at: 1 }, { now }).completedAt).toBe(now - 30 * 86_400_000);
  });

  test("a note is kept with it", () => {
    const { task } = createTask(w.alice, { title: "A" });
    completeTask(w.bob, task.id, { note: "Replaced the battery" });
    const history = taskHistory(w.alice, task.id);
    expect(history.find((e) => e.type === "completed")?.payload.note).toBe("Replaced the battery");
    expect(getTask(w.alice, task.id).commentCount).toBe(1);
  });
});

describe("idempotency", () => {
  test("a retry gets the first answer, and changes nothing", () => {
    const first = createTask(w.alice, { title: "A" }, { idempotencyKey: "k1" });
    const second = createTask(w.alice, { title: "A" }, { idempotencyKey: "k1" });
    expect(second.task.id).toBe(first.task.id);
    expect(listTasks(w.alice)).toHaveLength(1);
  });

  test("a key belongs to its actor", () => {
    createTask(w.alice, { title: "A" }, { idempotencyKey: "k1" });
    createTask(w.bob, { title: "B" }, { idempotencyKey: "k1" });
    expect(listTasks(w.alice)).toHaveLength(2);
  });

  test("a refused mutation isn't remembered: it can be tried again", () => {
    expect(() => createTask(w.alice, { title: "A", labels: ["nope"] }, { idempotencyKey: "k1" })).toThrow();
    createTask(w.alice, { title: "A" }, { idempotencyKey: "k1" });
    expect(listTasks(w.alice)).toHaveLength(1);
  });

  test("a client's id survives offline creation, and can't overwrite another", () => {
    const id = "01900000-0000-7000-8000-00000000abcd";
    expect(createTask(w.alice, { id, title: "A" }).task.id).toBe(id);
    expect(() => createTask(w.alice, { id, title: "B" })).toThrow(ConflictError);
  });
});

describe("dedupe keys", () => {
  test("a second report updates the open task rather than adding one", () => {
    const agent = agentFor(w.alice).actor;
    const first = createTask(agent, { title: "Sensor offline", dedupeKey: "sensor:1" });
    const second = createTask(agent, { title: "Sensor still offline", details: "Day 2", dedupeKey: "sensor:1" });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.title).toBe("Sensor still offline");
    expect(listTasks(w.alice)).toHaveLength(1);
    expect(events(first.task.id)).toEqual(["created", "deduped"]);
  });

  test("once it's closed, the next report opens a new one", () => {
    const agent = agentFor(w.alice).actor;
    const first = createTask(agent, { title: "Sensor offline", dedupeKey: "sensor:1" });
    const closed = completeByDedupeKey(agent, "sensor:1", { note: "Came back" });
    expect(closed?.id).toBe(first.task.id);
    expect(createTask(agent, { title: "Offline again", dedupeKey: "sensor:1" }).task.id).not.toBe(first.task.id);
  });

  test("closing a key with nothing open is fine, and does nothing", () => {
    expect(completeByDedupeKey(agentFor(w.alice).actor, "nothing:open")).toBeNull();
  });

  test("keys belong to the actor that made them", () => {
    const one = agentFor(w.alice).actor;
    const two = agentFor(w.bob).actor;
    createTask(one, { title: "One's", dedupeKey: "k" });
    expect(createTask(two, { title: "Two's", dedupeKey: "k" }).deduped).toBe(false);
    expect(completeByDedupeKey(two, "k")?.title).toBe("Two's");
  });

  test("reopening can't make two open tasks with one key", () => {
    const agent = agentFor(w.alice).actor;
    const first = createTask(agent, { title: "First", dedupeKey: "k" }).task;
    completeTask(agent, first.id);
    createTask(agent, { title: "Second", dedupeKey: "k" });
    expect(() => reopenTask(agent, first.id)).toThrow(ConflictError);
  });
});

describe("locations", () => {
  test("a tapped point takes its zone from the map", () => {
    const { task } = createTask(w.alice, { title: "A", location: { mapId: "shop", x: 75, y: 25 } });
    expect(task.location).toMatchObject({ mapId: "shop", mapName: "Shop", x: 75, y: 25, zoneId: "bay-2", zoneName: "Bay 2" });
  });

  test("a client can't claim a point in one zone and the name of another", () => {
    const { task } = createTask(w.alice, { title: "A", location: { mapId: "shop", x: 75, y: 25, zoneId: "bay-1" } });
    expect(task.location?.zoneId).toBe("bay-2");
  });

  test("the only map can go unsaid", () => {
    expect(createTask(w.alice, { title: "A", location: { x: 10, y: 10 } }).task.location?.mapId).toBe("shop");
  });

  test("a zone alone is enough, with or without a map behind it", () => {
    expect(createTask(w.alice, { title: "A", location: { zoneId: "yard" } }).task.location).toMatchObject({ mapId: null, zoneName: "Yard" });
    expect(createTask(w.alice, { title: "B", location: { zoneId: "bay-1" } }).task.location).toMatchObject({ mapId: "shop", x: null });
  });

  test("nonsense is refused", () => {
    expect(() => createTask(w.alice, { title: "A", location: { mapId: "shop", x: 500, y: 25 } })).toThrow(/outside the map/);
    expect(() => createTask(w.alice, { title: "A", location: { mapId: "nope", x: 5, y: 5 } })).toThrow(/no map/);
    expect(() => createTask(w.alice, { title: "A", location: { zoneId: "nope" } })).toThrow(/no zone/);
    expect(() => createTask(w.alice, { title: "A", location: { mapId: "shop", x: 5 } })).toThrow(/both x and y/);
  });

  test("a note on its own is a location", () => {
    expect(createTask(w.alice, { title: "A", location: { note: "Behind the door" } }).task.location?.note).toBe("Behind the door");
  });
});

describe("edits", () => {
  test("a stale revision is refused, not silently overwritten", () => {
    const { task } = createTask(w.alice, { title: "A" });
    updateTask(w.bob, task.id, { title: "B" });
    expect(() => updateTask(w.alice, task.id, { title: "C", expectedRev: task.rev })).toThrow(ConflictError);
    expect(getTask(w.alice, task.id).title).toBe("B");
  });

  test("labels go by name, in any case, or by id", () => {
    const [maintenance] = listLabels(w.alice);
    const { task } = createTask(w.alice, { title: "A", labels: ["SAFETY", maintenance!.id] });
    expect(task.labels.map((l) => l.name).sort()).toEqual(["maintenance", "safety"]);
  });

  test("assignees must be active people", () => {
    expect(() => createTask(w.alice, { title: "A", assignees: [9999] })).toThrow(UserInputError);
  });
});

describe("filters", () => {
  test("by label, zone, assignee, text and status", () => {
    const a = createTask(w.alice, { title: "Oil the press", labels: ["maintenance"], location: { zoneId: "bay-1" }, assignees: [w.bob.userId] }).task;
    const b = createTask(w.alice, { title: "Mop", details: "Under the bench" }).task;
    completeTask(w.alice, b.id);
    expect(listTasks(w.alice, { label: "maintenance" }).map((t) => t.id)).toEqual([a.id]);
    expect(listTasks(w.alice, { zone: "bay-1" }).map((t) => t.id)).toEqual([a.id]);
    expect(listTasks(w.alice, { assignee: w.bob.userId }).map((t) => t.id)).toEqual([a.id]);
    expect(listTasks(w.alice, { unassigned: true })).toHaveLength(0);
    expect(listTasks(w.alice, { status: "done" }).map((t) => t.id)).toEqual([b.id]);
    expect(listTasks(w.alice, { status: "all", q: "bench" }).map((t) => t.id)).toEqual([b.id]);
    expect(listTasks(w.alice, { status: "all", q: "%" })).toHaveLength(0);
  });

  test("open tasks sort by date, with undated last", () => {
    createTask(w.alice, { title: "Undated" });
    createTask(w.alice, { title: "Later", dueDate: "2030-02-01" });
    createTask(w.alice, { title: "Sooner", dueDate: "2030-01-01" });
    expect(listTasks(w.alice).map((t) => t.title)).toEqual(["Sooner", "Later", "Undated"]);
  });
});

describe("labels", () => {
  test("seed from config once, and an admin's change sticks", () => {
    setConfigForTests({ site: { ...TEST_SITE, labels: [{ name: "from config", color: undefined }] }, perimeterHeader: null });
    seedLabels();
    const label = listLabels(w.admin).find((l) => l.name === "from config")!;
    db().query("DELETE FROM labels WHERE id = ?").run(label.id);
    seedLabels();
    expect(listLabels(w.admin).some((l) => l.name === "from config")).toBe(false);
  });

  test("only admins manage them", () => {
    expect(() => createLabel(w.bob, { name: "x" })).toThrow(/admins/);
    expect(createLabel(w.admin, { name: "new" }).name).toBe("new");
    expect(() => createLabel(w.admin, { name: "NEW" })).toThrow(/already/);
  });
});

describe("reading zones", () => {
  test("combines flat zones and map zones", () => {
    expect(listZones(w.lan).map((z) => z.id)).toEqual(["yard", "bay-1", "bay-2"]);
  });
});

describe("rate limits", () => {
  test("are by actor: an anonymous device hits its limit and nobody else notices", () => {
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) createTask(w.lan, { title: `Task ${i}` }, { now });
    expect(() => createTask(w.lan, { title: "One too many" }, { now })).toThrow(RateLimitedError);
    expect(createTask(w.alice, { title: "Unaffected" }, { now }).task.title).toBe("Unaffected");
    expect(createTask(w.lan, { title: "A minute later" }, { now: now + 60_001 }).task.title).toBe("A minute later");
  });

  test("every anonymous device together has a ceiling, since a device id is only a cookie", () => {
    const now = 2_000_000;
    let hit = false;
    for (let i = 0; i < 250 && !hit; i++) {
      const device = { kind: "lan_device" as const, deviceId: `d${i}`, deviceName: null };
      try {
        createTask(device, { title: "x" }, { now });
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitedError);
        hit = true;
      }
    }
    expect(hit).toBe(true);
  });

  test("agent writes are limited too", () => {
    const agent = agentFor(w.alice).actor;
    const now = 3_000_000;
    for (let i = 0; i < 60; i++) createTask(agent, { title: `Task ${i}` }, { now });
    expect(() => createTask(agent, { title: "x" }, { now })).toThrow(RateLimitedError);
  });
});

test("due dates are wall-clock dates: the zone decides what today is", () => {
  // 11 PM on Oct 30 in Los Angeles is already Oct 31 in UTC.
  const lateEvening = Date.UTC(2026, 9, 31, 6, 0, 0);
  expect(dateOf(lateEvening, "America/Los_Angeles")).toBe("2026-10-30");
  expect(dateOf(lateEvening, "UTC")).toBe("2026-10-31");
  expect(config.timezone).toBeTruthy();
});
