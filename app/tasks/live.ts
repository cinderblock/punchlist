import { useEffect } from "react";

/**
 * Follow server-sent events and refresh what's on screen, so a wall tablet keeps
 * itself current. Events are hints with no content: a refresh goes through the
 * loaders like any other read. EventSource reconnects by itself; coming back
 * from a sleep refreshes once as well, since anything may have been missed.
 */
export function useLiveUpdates(refresh: () => void): void {
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A burst of changes is one refresh.
    const soon = () => {
      timer ??= setTimeout(() => {
        timer = null;
        refresh();
      }, 200);
    };
    const source = new EventSource("/api/v1/events");
    source.addEventListener("task", soon);
    source.addEventListener("resync", soon);
    const onVisible = () => {
      if (document.visibilityState === "visible") soon();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
}
