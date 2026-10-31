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

async function clearKeys(prefix: string): Promise<void> {
  const store = storage();
  if (store) {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) store.removeItem(key);
    }
  }
  if (typeof caches !== "undefined") await caches.delete("pl-pages").catch(() => {});
}

/**
 * Forget the pages kept on this device. For any way a session can end, not just
 * signing out: expiring, being revoked, or someone else arriving at the sign-in
 * page. Queued check-offs stay, because they answer to their owner (queue.ts).
 */
export const clearCopies = () => clearKeys(PREFIX);

/** Signing out: forget everything, and let no load still in flight put any of it back. */
export async function clearDeviceCopies(): Promise<void> {
  leaving = true;
  await clearKeys("pl:");
}

const IDENTITY = "pl:identity";

/** Who this device last showed. A change of person means the kept pages aren't theirs. */
export function noteIdentity(identity: string): void {
  const store = storage();
  try {
    const last = store?.getItem(IDENTITY);
    if (last && last !== identity) void clearCopies();
    store?.setItem(IDENTITY, identity);
  } catch {
    // Storage blocked: there are no copies to protect.
  }
}

/** Whoever this device last showed, for anything that has to wait on their behalf. */
export function currentIdentity(): string | null {
  try {
    return storage()?.getItem(IDENTITY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether an error means "couldn't reach the app" rather than "the app said no".
 * A proxy answering 502/503/504 counts: the box is up, the app isn't.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  const status = isRouteErrorResponse(err) ? err.status : err instanceof Response ? err.status : null;
  if (status != null) return status === 502 || status === 503 || status === 504;
  // A failed fetch is a TypeError, but so is every plain bug, so this has to read the text.
  return err instanceof Error && /failed to fetch|network|load failed/i.test(err.message);
}
