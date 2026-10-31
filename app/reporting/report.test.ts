import { describe, expect, test } from "bun:test";
import { UNSAFE_ErrorResponseImpl as ErrorResponse } from "react-router";

import { isOfflineError } from "../offline/copies.ts";
import { type OutboxEntry, type OutboxResult, createOutbox } from "./outbox.ts";
import { describeError, isConnectionFailure } from "./report.ts";

describe("isOfflineError", () => {
  test("a failed fetch is offline in each browser's words, and a plain bug isn't", () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) expect(isOfflineError(new TypeError(message))).toBe(true);
    expect(isOfflineError(new TypeError("Cannot read properties of undefined (reading 'title')"))).toBe(false);
  });
});

describe("what counts as an error", () => {
  test("a real TypeError does, and a failed fetch doesn't", () => {
    expect(describeError(new TypeError("x is not a function"))).toMatchObject({ name: "TypeError", message: "x is not a function" });
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(isConnectionFailure(new TypeError(message))).toBe(true);
      expect(describeError(new TypeError(message))).toBeNull();
    }
  });

  test("deliberate refusals aren't, and a 500 is the server's to report", () => {
    for (const status of [401, 403, 404, 409, 429, 500]) expect(describeError(new ErrorResponse(status, "", null))).toBeNull();
    expect(describeError(new Response(null, { status: 404 }))).toBeNull();
  });

  test("the proxy answering for an app that's down is, since the server never saw it", () => {
    expect(describeError(new ErrorResponse(502, "", null))).toMatchObject({ message: "The server answered 502" });
  });

  test("browsers' noise and other people's code aren't", () => {
    expect(describeError(new Error("ResizeObserver loop completed with undelivered notifications."))).toBeNull();
    expect(describeError("Script error.")).toBeNull();
    const extension = new Error("Nope");
    extension.stack = "Error: Nope\n    at x (chrome-extension://abc/content.js:1:1)";
    expect(describeError(extension)).toBeNull();
  });

  test("anything thrown is readable, and redacted before it leaves", () => {
    expect(describeError("a string")).toMatchObject({ name: "Thrown value", message: "a string" });
    expect(describeError(new Error("GET /join/sekrit?x=1"))!.message).toBe("GET /join/[redacted]");
  });
});

describe("the outbox", () => {
  const entry = (id: string, owner: string | null = "user:1"): OutboxEntry => ({ id, owner, path: "/x", body: {} });

  function make(answer: (e: OutboxEntry) => OutboxResult, initial: OutboxEntry[] = []) {
    const stored = { entries: initial };
    const sent: string[] = [];
    const outbox = createOutbox({
      load: () => stored.entries,
      save: (entries) => (stored.entries = entries),
      send: async (e) => {
        sent.push(e.id);
        return answer(e);
      },
    });
    return { outbox, stored, sent };
  }

  test("sends in order, and keeps what it couldn't", async () => {
    const { outbox, stored, sent } = make((e) => (e.id === "b" ? "wait" : "done"));
    for (const id of ["a", "b", "c"]) outbox.add(entry(id));
    await outbox.flush("user:1");
    expect(sent).toEqual(["a", "b"]);
    expect(stored.entries.map((e) => e.id)).toEqual(["b", "c"]);
  });

  test("gives up on what will never be accepted, and carries on", async () => {
    const { outbox, stored } = make((e) => (e.id === "a" ? "drop" : "done"));
    for (const id of ["a", "b"]) outbox.add(entry(id));
    await outbox.flush("user:1");
    expect(stored.entries).toEqual([]);
  });

  test("survives a reload", async () => {
    const { outbox, sent } = make(() => "done", [entry("left-over")]);
    await outbox.flush("user:1");
    expect(sent).toEqual(["left-over"]);
  });

  test("never sends one person's report as someone else", async () => {
    const { outbox, stored, sent } = make(() => "done", [entry("theirs", "user:2"), entry("mine", "user:1")]);
    await outbox.flush("user:1");
    expect(sent).toEqual(["mine"]);
    expect(stored.entries).toEqual([]);
  });

  test("a second flush is the one already running, so it can be waited on", async () => {
    let finish = (_: OutboxResult) => {};
    const stored = { entries: [entry("a")] };
    const sent: string[] = [];
    const outbox = createOutbox({
      load: () => stored.entries,
      save: (entries) => (stored.entries = entries),
      send: (e) => {
        sent.push(e.id);
        return new Promise((resolve) => (finish = resolve));
      },
    });
    const first = outbox.flush("user:1");
    const second = outbox.flush("user:1");
    let waited = false;
    void second.then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    finish("done");
    await first;
    await second;
    expect(waited).toBe(true);
    expect(sent).toEqual(["a"]);
  });

  test("a dead network can't fill the device", () => {
    const { outbox, stored } = make(() => "wait");
    for (let i = 0; i < 100; i++) outbox.add(entry(String(i)));
    expect(stored.entries).toHaveLength(30);
    expect(stored.entries.at(-1)!.id).toBe("99");
  });
});
