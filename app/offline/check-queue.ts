import { notifications } from "@mantine/notifications";
import { useEffect, useSyncExternalStore } from "react";

import { noteIdentity } from "./copies.ts";
import { type CheckQueue, type QueuedCheck, type SendResult, createCheckQueue } from "./queue.ts";

/** The queue, wired to localStorage and the REST API. One per page. */

const KEY = "pl:queue";

function load(): QueuedCheck[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as QueuedCheck[]) : [];
  } catch {
    return [];
  }
}

function save(items: QueuedCheck[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage full or blocked: the queue still works while this page is open.
  }
}

async function send(item: QueuedCheck): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/tasks/${item.taskId}/${item.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": item.id },
      body: JSON.stringify(item.action === "complete" ? { at: item.at } : {}),
      credentials: "same-origin",
    });
  } catch {
    return { kind: "wait" };
  }
  if (response.ok) return { kind: "done" };
  if (response.status === 401) return { kind: "signin" };
  if (response.status === 429 || response.status >= 500) return { kind: "wait" };
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { kind: "rejected", message: body.error ?? "The server refused that." };
}

let queue: CheckQueue | null = null;

export function checkQueue(): CheckQueue {
  queue ??= createCheckQueue({
    storage: { load, save },
    send,
    onRejected: (item, message) => notifications.show({ color: "red", title: `Couldn't save: ${item.title}`, message, autoClose: false }),
    onDropped: (count) =>
      notifications.show({ color: "yellow", message: `${count} check-off${count === 1 ? "" : "s"} made by someone else on this device weren't sent.`, autoClose: false }),
  });
  return queue;
}

const empty: QueuedCheck[] = [];

/** What's waiting to send, live. */
export function usePendingChecks(): QueuedCheck[] {
  return useSyncExternalStore(
    (listener) => checkQueue().subscribe(listener),
    () => checkQueue().pending(),
    () => empty,
  );
}

/** Keep trying: on reconnect, on coming back to the app, and on a slow timer. */
export function useQueueFlusher(identity: string, afterFlush: () => void): void {
  useEffect(() => {
    noteIdentity(identity);
    checkQueue().setOwner(identity);
    const flush = () => {
      const q = checkQueue();
      if (q.pending().length === 0) return;
      void q.flush().then(afterFlush);
    };
    flush();
    const timer = window.setInterval(flush, 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [identity, afterFlush]);
}
