import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { ConflictError, ForbiddenError, UserInputError } from "./errors.ts";
import { describeRecurrence, nextDueDate, nextScheduled, parseRrule, validateSchedule } from "./recurrence.ts";
import { completeTask, createTask, deleteTask, getTask, listTasks, reopenTask, taskHistory, updateTask } from "./tasks.ts";
import { type World, freshWorld } from "./testing/fixtures.ts";

describe("the rules", () => {
  const firstMonday = { kind: "schedule" as const, rrule: "FREQ=MONTHLY;BYDAY=1MO", anchorDate: "2026-01-05" };

  test("first Monday of the month", () => {
    expect(nextScheduled(firstMonday.rrule, firstMonday.anchorDate, "2026-01-05")).toBe("2026-02-02");
    expect(nextScheduled(firstMonday.rrule, firstMonday.anchorDate, "2026-02-01")).toBe("2026-02-02");
  });

  test("a schedule's next date doesn't depend on when it was done", () => {
    // Due Mar 2. Done a day early, on time and a day late: all give Apr 6.
    for (const done of ["2026-03-01", "2026-03-02", "2026-03-03"]) {
      expect(nextDueDate(firstMonday, done, "2026-03-02")).toBe("2026-04-06");
    }
  });

  test("a schedule that's fallen behind skips to its next date ahead, not the one it missed", () => {
    expect(nextDueDate(firstMonday, "2026-05-20", "2026-01-05")).toBe("2026-06-01");
  });

  test("after-completion counts from the day it was done", () => {
    const every30 = { kind: "after_completion" as const, intervalDays: 30 };
    expect(nextDueDate(every30, "2026-03-01", "2026-01-01")).toBe("2026-03-31");
    expect(nextDueDate(every30, "2026-03-15", "2026-01-01")).toBe("2026-04-14");
  });

  test("dates don't drift across a daylight saving change", () => {
    const weekly = { kind: "schedule" as const, rrule: "FREQ=WEEKLY", anchorDate: "2026-03-01" };
    expect(nextDueDate(weekly, "2026-03-08", "2026-03-08")).toBe("2026-03-15");
    expect(nextDueDate(weekly, "2026-11-01", "2026-11-01")).toBe("2026-11-08");
  });

  test("a rule that has ended gives nothing", () => {
    expect(nextScheduled("FREQ=DAILY;COUNT=2", "2026-01-01", "2026-01-02")).toBeNull();
  });

  test("an impossible rule is caught, quickly", () => {
    const started = Date.now();
    expect(() => validateSchedule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "2026-01-01")).toThrow(/never lands/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("only calendar-day rules are allowed", () => {
    expect(parseRrule("rrule:freq=weekly;byday=mo")).toBe("FREQ=WEEKLY;BYDAY=MO");
    for (const bad of ["FREQ=HOURLY", "FREQ=SECONDLY", "FREQ=DAILY;BYHOUR=9", "BYDAY=MO", "", "FREQ=WEEKLY;FREQ=DAILY", "DTSTART=20260101;FREQ=DAILY"]) {
      expect(() => parseRrule(bad)).toThrow(UserInputError);
    }
  });

  test("reads as a person would say it", () => {
    expect(describeRecurrence(firstMonday)).toContain("month");
    expect(describeRecurrence({ kind: "after_completion", intervalDays: 30 })).toBe("30 days after it's done");
  });
});

describe("occurrences", () => {
  let w: World;
  beforeEach(() => {
    w = freshWorld();
  });
  afterEach(() => setConfigForTests(undefined));

  const open = () => listTasks(w.alice, { status: "open" });

  test("completing makes the next one, carrying everything forward", () => {
    const { task } = createTask(w.alice, {
      title: "Change the filter",
      details: "16x25",
      dueDate: "2026-11-02",
      labels: ["maintenance"],
      assignees: [w.bob.userId],
      location: { zoneId: "bay-1" },
      recurrence: { kind: "schedule", rrule: "FREQ=MONTHLY;BYDAY=1MO" },
    });
    completeTask(w.bob, task.id);

    const [next] = open();
    expect(next!.id).not.toBe(task.id);
    expect(next!.title).toBe("Change the filter");
    expect(next!.details).toBe("16x25");
    expect(next!.dueDate! > "2026-11-02").toBe(true);
    expect(next!.labels.map((l) => l.name)).toEqual(["maintenance"]);
    expect(next!.assignees.map((a) => a.id)).toEqual([w.bob.userId]);
    expect(next!.location?.zoneId).toBe("bay-1");
    expect(next!.createdBy).toBe("Recurring schedule");
    expect(taskHistory(w.alice, next!.id)[0]).toMatchObject({ actor: "Recurring schedule", via: "schedule" });
  });

  test("occurrences are kept for history", () => {
    const { task } = createTask(w.alice, { title: "Weekly", dueDate: "2026-11-02", recurrence: { kind: "schedule", rrule: "FREQ=WEEKLY" } });
    completeTask(w.alice, task.id);
    expect(getTask(w.alice, task.id).status).toBe("done");
    expect(listTasks(w.alice, { status: "all" })).toHaveLength(2);
  });

  test("only one is ever open, and the database insists", () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2020-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    expect(open()).toHaveLength(1);
    const row = db().query<{ recurrence_id: string }, [string]>("SELECT recurrence_id FROM tasks WHERE id = ?").get(task.id)!;
    expect(() =>
      db()
        .query(
          "INSERT INTO tasks (id, title, visibility, created_by, created_by_label, recurrence_id, created_at, updated_at) VALUES ('dup', 'x', 'public', 'system', 'x', ?, 0, 0)",
        )
        .run(row.recurrence_id),
    ).toThrow(/UNIQUE/);
  });

  test("after-completion: the next due date is counted from the day it was done", () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2026-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    const done = Date.UTC(2026, 2, 1, 20); // Mar 1, midday in Los Angeles
    completeTask(w.alice, task.id, {}, { now: done });
    expect(open()[0]!.dueDate).toBe("2026-03-31");
  });

  test("starting with no due date picks the rule's first day, or the interval's", () => {
    const now = Date.UTC(2026, 10, 3, 20); // Tue Nov 3 2026
    expect(createTask(w.alice, { title: "A", recurrence: { kind: "schedule", rrule: "FREQ=WEEKLY;BYDAY=MO" } }, { now }).task.dueDate).toBe("2026-11-09");
    expect(createTask(w.alice, { title: "B", recurrence: { kind: "after_completion", intervalDays: 10 } }, { now }).task.dueDate).toBe("2026-11-13");
  });

  test("undoing a check-off takes the next occurrence back", () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2026-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    completeTask(w.alice, task.id);
    expect(open()[0]!.id).not.toBe(task.id);
    reopenTask(w.alice, task.id);
    expect(open().map((t) => t.id)).toEqual([task.id]);
    completeTask(w.alice, task.id);
    expect(open()).toHaveLength(1);
  });

  test("but not if someone has since changed it", () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2026-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    completeTask(w.alice, task.id);
    updateTask(w.alice, open()[0]!.id, { details: "Use the good ones" });
    expect(() => reopenTask(w.alice, task.id)).toThrow(ConflictError);
  });

  test("stopping the repeat means no next one", () => {
    const { task } = createTask(w.alice, { title: "Filter", dueDate: "2026-01-01", recurrence: { kind: "after_completion", intervalDays: 30 } });
    expect(updateTask(w.alice, task.id, { recurrence: null }).recurrence).toBeNull();
    completeTask(w.alice, task.id);
    expect(open()).toHaveLength(0);
  });

  test("deleting the open occurrence ends it without a successor", () => {
    const { task } = createTask(w.alice, { title: "Filter", recurrence: { kind: "after_completion", intervalDays: 30 } });
    deleteTask(w.alice, task.id);
    expect(open()).toHaveLength(0);
  });

  test("a private repeating task stays private, and shared the same way", () => {
    const { task } = createTask(w.alice, { title: "Mine", visibility: "private", sharedWith: [w.bob.userId], recurrence: { kind: "after_completion", intervalDays: 1 } });
    completeTask(w.alice, task.id);
    const [next] = listTasks(w.bob, { status: "open" });
    expect(next!.visibility).toBe("private");
    expect(listTasks(w.admin, { status: "open" })).toHaveLength(0);
    expect(listTasks(w.lan, { status: "open" })).toHaveLength(0);
  });

  test("an on-site visitor can complete one, but not set one up", () => {
    const { task } = createTask(w.alice, { title: "Public", recurrence: { kind: "after_completion", intervalDays: 7 } });
    expect(completeTask(w.lan, task.id).status).toBe("done");
    expect(() => updateTask(w.lan, task.id, { recurrence: null })).toThrow(ForbiddenError);
  });
});
