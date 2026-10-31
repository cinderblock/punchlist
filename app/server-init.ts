import type { MiddlewareFunction } from "react-router";

import { integrationProblems } from "../src/agents.ts";
import { ensureBootstrapLink } from "../src/bootstrap.ts";
import { describeConfig } from "../src/config.server.ts";
import { initDb } from "../src/db.server.ts";
import { reportServerError } from "../src/error-reports.ts";
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
  watchProcess();
  g[KEY] = true;
}

/**
 * What nothing else caught. A stray rejection is one request's problem, so the server
 * carries on. An uncaught exception leaves the process in a state nobody chose: it's
 * written down, and then the process goes, for the container to restart.
 */
function watchProcess(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandled rejection:", reason);
    reportServerError("rejection", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaught exception:", err);
    reportServerError("exception", err);
    process.exit(1);
  });
}

export const initMiddleware: MiddlewareFunction<Response> = (_args, next) => {
  ensureServerInit();
  return next();
};
