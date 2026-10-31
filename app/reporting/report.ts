import { isRouteErrorResponse } from "react-router";

import type { ClientErrorSource } from "../../src/feedback-kinds.ts";
import { redactPath, redactText } from "../../src/redact.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { currentIdentity } from "../offline/copies.ts";
import { type OutboxEntry, type OutboxResult, createOutbox } from "./outbox.ts";

/**
 * Sends the server every error the browser sees. See plans/feedback.md for what counts.
 *
 * Nothing here may make things worse: it never throws, never shows anything, and
 * doesn't report its own failures. What it sends is an error's own text and a path,
 * never the page: admins don't get private tasks, and this mustn't be how they would.
 */

declare const __APP_REVISION__: string;
const REVISION = typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "dev";

const KEY = "pl:outbox";
const REPEAT_AFTER_MS = 60_000;
const MAX_PER_PAGE = 25;
const NAME_MAX = 200;
const MESSAGE_MAX = 2_000;
const STACK_MAX = 8_000;
const TRAIL_LENGTH = 10;
/** How recent an error has to be for a note to mention it. */
const RELATED_MS = 10 * 60_000;
const REPORTS_WAIT_MS = 2_000;

/** Refusals the app gives on purpose. A 500 is left out because the server already reported it. */
const QUIET_STATUSES = new Set([0, 401, 403, 404, 409, 413, 429, 500]);

function load(): OutboxEntry[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: OutboxEntry[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked: they still go while this page is open.
  }
}

const recent: { id: number; at: number }[] = [];

async function send(entry: OutboxEntry): Promise<OutboxResult> {
  let response: Response;
  try {
    response = await fetch(entry.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry.body), credentials: "same-origin", keepalive: true });
  } catch {
    return "wait";
  }
  if (response.ok) {
    const { id } = (await response.json().catch(() => ({}))) as { id?: unknown };
    if (typeof id === "number" && entry.path === ERRORS_PATH) recent.push({ id, at: Date.now() });
    return "done";
  }
  // A note waits for its author to sign back in. An error isn't worth holding on to.
  if (response.status === 429 || response.status >= 500 || (response.status === 401 && entry.path !== ERRORS_PATH)) return "wait";
  return "drop";
}

const ERRORS_PATH = "/api/v1/errors";
const FEEDBACK_PATH = "/api/v1/feedback";

const outbox = typeof window === "undefined" ? null : createOutbox({ load, save, send });

function flush(): void {
  void outbox?.flush(currentIdentity()).catch(() => {});
}

// ---- where someone is ----------------------------------------------------------------

const trail: string[] = [];

/** The pages leading up to an error are how anyone gets to reproduce it. */
export function noteVisit(path: string): void {
  const clean = redactPath(path);
  if (trail.at(-1) === clean) return;
  trail.push(clean);
  if (trail.length > TRAIL_LENGTH) trail.shift();
}

export function currentContext() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return {
    path: redactPath(window.location.pathname),
    revision: REVISION,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    standalone,
    online: navigator.onLine,
    colorScheme: document.documentElement.getAttribute("data-mantine-color-scheme") ?? undefined,
    trail: [...trail],
  };
}

/**
 * Let reports on their way arrive, so a note written straight after an error can name
 * it. Bounded: a slow network is no reason to hold up what someone wants to say.
 */
export async function reportsSent(): Promise<void> {
  const sent = outbox?.flush(currentIdentity()).catch(() => {});
  await Promise.race([sent, new Promise((resolve) => setTimeout(resolve, REPORTS_WAIT_MS))]);
}

/** Errors the server has from this page in the last few minutes, for a note to point at. */
export function recentErrorIds(now: number = Date.now()): number[] {
  return [...new Set(recent.filter((r) => now - r.at < RELATED_MS).map((r) => r.id))].slice(-10);
}

// ---- what counts ---------------------------------------------------------------------

/** Couldn't reach the server, which isn't a bug. A real TypeError is, so this reads the text. */
export function isConnectionFailure(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  return err instanceof Error && /failed to fetch|load failed|networkerror|network request failed/i.test(err.message);
}

export interface Described {
  name: string;
  message: string;
  stack?: string;
}

/** An error as text, or null if it's nothing to report. */
export function describeError(err: unknown): Described | null {
  if (isConnectionFailure(err)) return null;
  if (isRouteErrorResponse(err)) return QUIET_STATUSES.has(err.status) || err.status < 500 ? null : { name: "ErrorResponse", message: `The server answered ${err.status}` };
  if (err instanceof Response) return QUIET_STATUSES.has(err.status) || err.status < 500 ? null : { name: "Response", message: `The server answered ${err.status}` };

  const e = err instanceof Error ? err : null;
  const described: Described = { name: e?.name || "Thrown value", message: e?.message ?? String(err), stack: e?.stack };
  // Browsers' own noise, and other people's code.
  if (/^ResizeObserver loop/.test(described.message) || described.message === "Script error.") return null;
  if (described.stack && /^\s*(at .*)?[a-z]+-extension:\/\//m.test(described.stack.split("\n").slice(0, 3).join("\n"))) return null;
  return {
    name: redactText(described.name).slice(0, NAME_MAX),
    message: redactText(described.message).slice(0, MESSAGE_MAX),
    stack: described.stack ? redactText(described.stack).slice(0, STACK_MAX) : undefined,
  };
}

// ---- sending ---------------------------------------------------------------------------

const lastSent = new Map<string, number>();
const seen = new WeakSet<object>();
let sentFromThisPage = 0;

/** One error surfaces in several places: React, the router, a rejection. It's one report. */
function alreadySeen(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if (seen.has(err)) return true;
  seen.add(err);
  return false;
}

export function reportError(where: ClientErrorSource, err: unknown): void {
  try {
    if (!outbox || alreadySeen(err)) return;
    const described = describeError(err);
    if (!described) return;
    const key = `${where}|${described.name}|${described.message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? -Infinity) < REPEAT_AFTER_MS || sentFromThisPage >= MAX_PER_PAGE) return;
    lastSent.set(key, now);
    sentFromThisPage++;
    outbox.add({ id: uuidv7(), owner: currentIdentity(), path: ERRORS_PATH, body: { where, ...described, context: currentContext() } });
    flush();
  } catch {
    // Reporting a failure must never be a second failure.
  }
}

/** The app answered something it shouldn't have, or a proxy answered for it. */
export function reportHttpFailure(method: string, path: string, status: number, detail?: string): void {
  if (QUIET_STATUSES.has(status)) return;
  const error = new Error(`${method} ${redactPath(path)} answered ${status}${detail ? `: ${detail}` : ""}`);
  error.name = "HttpError";
  // No stack: the place that noticed tells nobody anything, and it would split the group.
  error.stack = undefined;
  reportError("api", error);
}

/** Queue a note that couldn't go now. It carries its id, so sending it twice is harmless. */
export function queueFeedback(note: unknown): void {
  outbox?.add({ id: uuidv7(), owner: currentIdentity(), path: FEEDBACK_PATH, body: note });
}

/** From the first line of the browser's code: nothing should go unseen. */
export function installErrorReporting(): void {
  window.addEventListener("error", (event) => reportError("window", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError("promise", event.reason));
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  flush();
}
