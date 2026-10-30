import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfigForTests } from "./config.server.ts";
import { createFeed, renderFeed } from "./feeds.ts";
import { calendar, escapeText, foldLine } from "./ics.ts";
import { agentFor, freshWorld } from "./testing/fixtures.ts";
import { createTask } from "./tasks.ts";

const event = { uid: "abc", title: "Oil the press", date: "2026-11-02", updatedAt: Date.UTC(2026, 9, 30, 20, 54, 1), description: null, location: null };

describe("the file format", () => {
  test("an all-day VEVENT, never a VTODO", () => {
    const ics = calendar({ name: "Test", host: "example.test", now: 0, events: [event] });
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).not.toContain("VTODO");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261103\r\n");
    expect(ics).toContain("UID:abc@example.test\r\n");
    expect(ics).toContain("DTSTAMP:20261030T205401Z\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  test("the year rolls over", () => {
    expect(calendar({ name: "x", host: "h", now: 0, events: [{ ...event, date: "2026-12-31" }] })).toContain("DTEND;VALUE=DATE:20270101");
  });

  test("text is escaped", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  test("long lines fold at 75 octets, on character boundaries", () => {
    const folded = foldLine(`SUMMARY:${"é".repeat(100)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(100)}`);
  });
});

describe("what a feed says", () => {
  afterEach(() => setConfigForTests(undefined));
  let world: ReturnType<typeof freshWorld>;
  beforeEach(() => {
    world = freshWorld();
  });
  const render = () => renderFeed(createFeed({ ownerUserId: world.alice.userId, name: "All", scope: "public" }).url.split("/feeds/")[1]!.replace(".ics", ""))!;

  test("tasks with no due date stay out", () => {
    createTask(world.alice, { title: "Dated", dueDate: "2030-01-01" });
    createTask(world.alice, { title: "Undated" });
    const ics = render();
    expect(ics).toContain("Dated");
    expect(ics).not.toContain("Undated");
  });

  test("done tasks stay out", async () => {
    const { completeTask } = await import("./tasks.ts");
    completeTask(world.alice, createTask(world.alice, { title: "Finished", dueDate: "2030-01-01" }).task.id);
    expect(render()).not.toContain("Finished");
  });

  test("an agent's task names the agent", () => {
    createTask(agentFor(world.alice).actor, { title: "From an agent", dueDate: "2030-01-01" });
    expect(render().replace(/\r\n /g, "")).toContain("Added by Helper\\, for Alice Member");
  });
});
