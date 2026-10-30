import type { MiddlewareFunction } from "react-router";

import { integrationProblems } from "../src/agents.ts";
import { ensureBootstrapLink } from "../src/bootstrap.ts";
import { describeConfig } from "../src/config.server.ts";
import { initDb } from "../src/db.server.ts";
import { startNotificationWorker } from "../src/notifications/worker.ts";
import { pruneIdempotency, seedLabels } from "../src/tasks.ts";

/**
 * One-shot startup: log the settings, open (and migrate) the database, seed
 * labels, print the first-run setup link if no admin exists yet, and start the
 * reminder loop if Web Push is configured.
 *
 * There is no "server started" hook in a React Router app, so this runs from the
 * first middleware on the first request, and from entry.server at import. The
 * flag lives on globalThis because Vite's SSR re-evaluates modules in
 * development, so a module-level boolean can exist several times over in one
 * process.
 */
const KEY = "__punchlistInitialized__";
type GlobalWithFlag = typeof globalThis & { [KEY]?: boolean };

export function ensureServerInit(): void {
  const g = globalThis as GlobalWithFlag;
  if (g[KEY]) return;
  console.log(describeConfig());
  for (const line of integrationProblems()) console.warn(line);
  initDb();
  seedLabels();
  pruneIdempotency();
  ensureBootstrapLink();
  startNotificationWorker();
  g[KEY] = true;
}

export const initMiddleware: MiddlewareFunction<Response> = (_args, next) => {
  ensureServerInit();
  return next();
};
