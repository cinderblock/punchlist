import { reportServerError } from "./error-reports.ts";

/**
 * The in-process bus behind live updates. The domain layer publishes after a
 * transaction commits; the SSE handler subscribes.
 *
 * What travels here is deliberately nothing but an id: each subscriber decides
 * afresh, as its own actor, whether it may even know that id changed.
 *
 * On globalThis so that a re-evaluated module (Vite's SSR in development) still
 * reaches the same subscribers.
 */

export interface LiveEvent {
  taskId: string;
  /**
   * Some readers may have just lost sight of this task (deleted, gone private).
   * They can't be told which, since they may not be allowed to know, so
   * everyone gets an id-free "look again".
   */
  resync: boolean;
}

type Listener = (event: LiveEvent) => void;
type GlobalWithBus = typeof globalThis & { __punchlistLive__?: Set<Listener> };

function listeners(): Set<Listener> {
  const g = globalThis as GlobalWithBus;
  g.__punchlistLive__ ??= new Set();
  return g.__punchlistLive__;
}

export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function publish(event: LiveEvent): void {
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch (err) {
      console.error("[live] listener failed:", err);
      reportServerError("live", err);
    }
  }
}

export function subscriberCount(): number {
  return listeners().size;
}
