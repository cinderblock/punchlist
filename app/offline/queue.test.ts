import { describe, expect, test } from "bun:test";

import { type QueuedCheck, type SendResult, createCheckQueue } from "./queue.ts";

const check = (id: string, taskId = "t1", action: QueuedCheck["action"] = "complete") => ({ id, taskId, action, title: "Fix it", at: 1 });

function setup(answers: SendResult[] = []) {
  let saved: QueuedCheck[] = [];
  const sent: string[] = [];
  const rejected: string[] = [];
  const dropped: number[] = [];
  const queue = createCheckQueue({
    storage: { load: () => saved, save: (items) => (saved = items) },
    send: async (item) => {
      sent.push(item.id);
      return answers.shift() ?? { kind: "done" };
    },
    onRejected: (item) => rejected.push(item.id),
    onDropped: (n) => dropped.push(n),
  });
  queue.setOwner("user:1");
  return { queue, sent, rejected, dropped, saved: () => saved };
}

describe("the check-off queue", () => {
  test("sends in order and empties", async () => {
    const { queue, sent, saved } = setup();
    queue.add(check("a", "t1"));
    queue.add(check("b", "t2"));
    await queue.flush();
    expect(sent).toEqual(["a", "b"]);
    expect(saved()).toEqual([]);
  });

  test("stops at the first failure to reach the server, keeping everything for later", async () => {
    const { queue, sent, saved } = setup([{ kind: "wait" }]);
    queue.add(check("a", "t1"));
    queue.add(check("b", "t2"));
    await queue.flush();
    expect(sent).toEqual(["a"]);
    expect(saved().map((i) => i.id)).toEqual(["a", "b"]);
    await queue.flush();
    expect(sent).toEqual(["a", "a", "b"]);
    expect(saved()).toEqual([]);
  });

  test("holds on through a lapsed session", async () => {
    const { queue, saved } = setup([{ kind: "signin" }]);
    queue.add(check("a"));
    await queue.flush();
    expect(saved()).toHaveLength(1);
  });

  test("a rejection drops that one, reports it, and carries on", async () => {
    const { queue, sent, rejected, saved } = setup([{ kind: "rejected", message: "gone" }]);
    queue.add(check("a", "t1"));
    queue.add(check("b", "t2"));
    await queue.flush();
    expect(sent).toEqual(["a", "b"]);
    expect(rejected).toEqual(["a"]);
    expect(saved()).toEqual([]);
  });

  test("an undo of something unsent cancels it, and nothing is sent", async () => {
    const { queue, sent } = setup();
    queue.add(check("a", "t1", "complete"));
    queue.add(check("b", "t1", "reopen"));
    expect(queue.pending()).toEqual([]);
    await queue.flush();
    expect(sent).toEqual([]);
  });

  test("survives a reload: a new queue picks up what the last one saved", async () => {
    const first = setup([{ kind: "wait" }]);
    first.queue.add(check("a"));
    await first.queue.flush();
    const sent: string[] = [];
    const reloaded = createCheckQueue({
      storage: { load: first.saved, save: () => {} },
      send: async (item) => {
        sent.push(item.id);
        return { kind: "done" };
      },
    });
    await reloaded.flush();
    expect(sent).toEqual([]);
    reloaded.setOwner("user:1");
    await reloaded.flush();
    expect(sent).toEqual(["a"]);
  });

  test("finding 11: nothing is sent until it's known who's here", async () => {
    const sent: string[] = [];
    let saved: QueuedCheck[] = [{ ...check("a"), owner: "user:1" }];
    const queue = createCheckQueue({
      storage: { load: () => saved, save: (items) => (saved = items) },
      send: async (item) => {
        sent.push(item.id);
        return { kind: "done" };
      },
    });
    await queue.flush();
    expect(sent).toEqual([]);
  });

  test("finding 11: check-offs queued by one person are dropped, not sent as the next", async () => {
    const { queue, sent, saved, dropped } = setup([{ kind: "signin" }]);
    queue.add(check("a"));
    await queue.flush();
    sent.length = 0;
    queue.setOwner("user:2");
    expect(saved()).toEqual([]);
    expect(dropped).toEqual([1]);
    await queue.flush();
    expect(sent).toEqual([]);
  });

  test("finding 11: the same person coming back keeps theirs", async () => {
    const { queue, sent, dropped } = setup([{ kind: "signin" }]);
    queue.add(check("a"));
    await queue.flush();
    queue.setOwner("user:1");
    await queue.flush();
    expect(sent).toEqual(["a", "a"]);
    expect(dropped).toEqual([]);
  });

  test("finding 11: each item records who queued it", () => {
    const { queue, saved } = setup();
    queue.add(check("a"));
    expect(saved()[0]?.owner).toBe("user:1");
  });
});
