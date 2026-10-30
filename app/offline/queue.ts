/**
 * Queued check-offs. Warehouse Wi-Fi drops out, and a tick has to stick anyway,
 * so every check-off is written here first and sent from here, online or not.
 *
 * Each entry has a client-made id that goes to the server as its Idempotency-Key,
 * so a send that succeeded but whose answer was lost can safely go again. The
 * logic is free of the browser so it can be tested; the wiring is in
 * check-queue.ts.
 */

export type CheckAction = "complete" | "reopen";

export interface QueuedCheck {
  id: string;
  taskId: string;
  action: CheckAction;
  title: string;
  /** When it really happened, on this device's clock. The server bounds it. */
  at: number;
}

/**
 * What became of one send.
 *   done      the server has it
 *   wait      offline, or the server is down: try the whole queue later
 *   signin    the session ended: hold on until they're back
 *   rejected  the server said no and always will: drop it, and say so
 */
export type SendResult = { kind: "done" } | { kind: "wait" } | { kind: "signin" } | { kind: "rejected"; message: string };

export interface QueueStorage {
  load(): QueuedCheck[];
  save(items: QueuedCheck[]): void;
}

export interface CheckQueue {
  add(item: QueuedCheck): void;
  flush(): Promise<void>;
  pending(): QueuedCheck[];
  subscribe(listener: () => void): () => void;
}

export function createCheckQueue(args: {
  storage: QueueStorage;
  send: (item: QueuedCheck) => Promise<SendResult>;
  onRejected?: (item: QueuedCheck, message: string) => void;
}): CheckQueue {
  let items = args.storage.load();
  let flushing = false;
  let again = false;
  const listeners = new Set<() => void>();

  const commit = (next: QueuedCheck[]) => {
    items = next;
    args.storage.save(items);
    for (const l of listeners) l();
  };

  return {
    /**
     * Add one. The opposite of something still unsent cancels it instead: a tap
     * and an undo that never left the device never happened.
     */
    add(item) {
      const unsent = items.find((i) => i.taskId === item.taskId);
      if (unsent && unsent.action !== item.action && !flushing) commit(items.filter((i) => i !== unsent));
      else commit([...items, item]);
    },

    async flush() {
      if (flushing) {
        again = true;
        return;
      }
      flushing = true;
      try {
        // In order: a tick and its undo must arrive as they happened.
        while (items.length > 0) {
          const item = items[0]!;
          const result = await args.send(item);
          if (result.kind === "wait" || result.kind === "signin") break;
          commit(items.filter((i) => i.id !== item.id));
          if (result.kind === "rejected") args.onRejected?.(item, result.message);
        }
      } finally {
        flushing = false;
      }
      if (again) {
        again = false;
        await this.flush();
      }
    },

    pending: () => items,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
