/**
 * Reports waiting to go. Wi-Fi in a big building drops out, and that's when things go
 * wrong, so everything is written here first and sent from here.
 *
 * Like the check-off queue, each entry remembers who was here, and is dropped rather
 * than sent as anyone else. The logic is free of the browser so it can be tested; the
 * wiring is in report.ts.
 */

export interface OutboxEntry {
  id: string;
  /** Who was here. Null: nobody's been seen on this device. */
  owner: string | null;
  path: string;
  body: unknown;
}

/**
 * What became of one send.
 *   done  the server has it
 *   wait  offline, or the server is down: try the rest later too
 *   drop  it will never be accepted
 */
export type OutboxResult = "done" | "wait" | "drop";

/** A dead network shouldn't fill the device. The oldest goes first. */
const MAX_ENTRIES = 30;

export interface Outbox {
  add(entry: OutboxEntry): void;
  /** Send what can go. While a flush is running, this is that flush. */
  flush(owner: string | null): Promise<void>;
  pending(): OutboxEntry[];
}

export function createOutbox(args: { load: () => OutboxEntry[]; save: (entries: OutboxEntry[]) => void; send: (entry: OutboxEntry) => Promise<OutboxResult> }): Outbox {
  let entries = args.load();
  let running: Promise<void> | null = null;

  const commit = (next: OutboxEntry[]) => {
    entries = next;
    args.save(entries);
  };

  return {
    add(entry) {
      commit([...entries, entry].slice(-MAX_ENTRIES));
    },

    flush(owner) {
      const pass = async () => {
        for (const entry of entries.filter((e) => e.owner !== owner)) commit(entries.filter((e) => e !== entry));
        for (;;) {
          const entry = entries[0];
          if (!entry) break;
          const result = await args.send(entry);
          if (result === "wait") break;
          commit(entries.filter((e) => e !== entry));
        }
      };
      running ??= pass().finally(() => {
        running = null;
      });
      return running;
    },

    pending: () => entries,
  };
}
