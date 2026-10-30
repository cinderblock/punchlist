import { describe, expect, test } from "bun:test";

import { type QueuedCheck, type SendResult, createCheckQueue } from "./queue.ts";

const check = (id: string, taskId = "t1", action: QueuedCheck["action"] = "complete"): QueuedCheck => ({ id, taskId, action, title: "Fix it", at: 1 });

function setup(answers: SendResult[] = []) {
  let saved: QueuedCheck[] = [];
  const sent: string[] = [];
  const rejected: string[] = [];
  const queue = createCheckQueue({
    storage: { load: () => saved, save: (items) => (saved = items) },
    send: async (item) => {
      sent.push(item.id);
      return answers.shift() ?? { kind: "done" };
    },
    onRejected: (item) => rejected.push(item.id),
  });
  return { queue, sent, rejected, saved: () => saved };
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
    expect(sent).toEqual(["a"]);
  });
});
