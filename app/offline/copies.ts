import { isRouteErrorResponse } from "react-router";

/**
 * The last-read copies of pages, on the device. Loaders write them after a
 * successful fetch and read them when the server can't be reached. All of it is
 * cleared on sign-out, and the kept page in the service worker's cache with it,
 * so a shared device doesn't keep someone's private list.
 */

const PREFIX = "pl:copy:";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

let leaving = false;

export function writeCopy(key: string, value: unknown): void {
  // Signing out: a load still in flight mustn't put back what was just cleared.
  if (leaving) return;
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: there just won't be an offline copy.
  }
}

export function readCopy<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Forget everything kept on this device, in storage and in the worker's page cache. */
export async function clearDeviceCopies(): Promise<void> {
  leaving = true;
  const store = storage();
  if (store) {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith("pl:")) store.removeItem(key);
    }
  }
  if (typeof caches !== "undefined") await caches.delete("pl-pages").catch(() => {});
}

/**
 * Whether an error means "couldn't reach the app" rather than "the app said no".
 * A proxy answering 502/503/504 counts: the box is up, the app isn't.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch itself failed
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  const status = isRouteErrorResponse(err) ? err.status : err instanceof Response ? err.status : null;
  if (status != null) return status === 502 || status === 503 || status === 504;
  return err instanceof Error && /failed to fetch|network|load failed/i.test(err.message);
}
