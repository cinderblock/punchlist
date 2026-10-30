import type { Actor } from "../actors.ts";
import { type LiveEvent, subscribe } from "../live.ts";
import { canSeeTask } from "../tasks.ts";
import { NO_STORE } from "./guard.ts";

/**
 * Server-sent events, so a wall tablet refreshes itself.
 *
 * Each event is a hint: an id at most, and the client fetches what it may see
 * through the normal paths. Who may hear about what is decided per event, as
 * the actor stands at that moment, so a stream opened before someone was
 * deactivated doesn't outlive them: `reauthenticate` runs for every event and
 * every heartbeat, and the stream closes as soon as it fails.
 */

const HEARTBEAT_MS = 25_000;

export function eventStream(args: {
  request: Request;
  actor: Actor;
  /** The actor this request would resolve to now, or null if it no longer does. */
  reauthenticate: () => Actor | null;
  heartbeatMs?: number;
}): Response {
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };

      const unsubscribe = subscribe((event: LiveEvent) => {
        const actor = args.reauthenticate();
        if (!actor) {
          stop();
          return;
        }
        if (event.resync) send(`event: resync\ndata: {}\n\n`);
        else if (canSeeTask(actor, event.taskId)) send(`event: task\ndata: ${JSON.stringify({ id: event.taskId })}\n\n`);
      });

      const heartbeat = setInterval(() => {
        if (!args.reauthenticate()) stop();
        else send(": still here\n\n");
      }, args.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref?.();

      stop = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      args.request.signal.addEventListener("abort", () => stop());
      // Comment first, so proxies flush the headers now and not at the first event.
      send(": connected\n\n");
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform: the compression middleware honours it, and a compressed
      // stream would sit in a buffer until it filled.
      "Cache-Control": `${NO_STORE}, no-transform`,
      "X-Accel-Buffering": "no",
    },
  });
}
