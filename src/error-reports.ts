import { createHash } from "node:crypto";

import { isRouteErrorResponse } from "react-router";
import { z } from "zod";

import { type Actor, actorLabel } from "./actors.ts";
import { audit } from "./audit.ts";
import { db } from "./db.server.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { CLIENT_ERROR_SOURCES, ERROR_STATUSES, type ErrorStatus } from "./feedback-kinds.ts";
import { requestNotifierPass } from "./notifications/kick.ts";
import { enqueueForAdmins } from "./notifications/store.ts";
import { canTriageReports } from "./permissions.ts";
import { checkErrorReportRate } from "./rate-limit.ts";
import { redactPath, redactText } from "./redact.ts";
import { mapStack } from "./source-maps.ts";
import { describeUserAgent } from "./user-agent.ts";

/**
 * Everything that went wrong, from the browser and the server, grouped by what it was
 * rather than listed by when. One group has a count and the latest sample, so a render
 * loop costs one row.
 *
 * A report holds a path and an error's own text, never a page or a request. Admins
 * don't see private tasks, and this mustn't become a way to. What a browser sends is
 * only a claim: it's redacted again here, and shown as text.
 */

const NAME_MAX = 200;
const MESSAGE_MAX = 2_000;
const STACK_MAX = 8_000;
const PATH_MAX = 300;
const USER_AGENT_MAX = 300;
/** Identical text is one group however it arrived; past these, a flood only evicts itself. */
const GROUPS_MAX = 2_000;
const SIGNED_OUT_GROUPS_MAX = 200;
/** A body bigger than this is no error report. */
export const ERROR_REPORT_MAX_BYTES = 32 * 1024;
/** An hour's worth of errors is one buzz. The inbox has the rest. */
const PUSH_EVERY_MS = 3600_000;

export const INBOX_URL = "/admin/feedback";

/** Cut rather than refuse: a long error is still an error. */
const clipped = (max: number) => z.string().transform((s) => s.slice(0, max));

/** Where a report came from, for whoever has to reproduce it. Shared with feedback. */
export const clientContextSchema = z
  .object({
    path: clipped(PATH_MAX).optional(),
    revision: clipped(64).optional(),
    viewport: clipped(20).optional(),
    standalone: z.boolean().optional(),
    online: z.boolean().optional(),
    colorScheme: clipped(10).optional(),
    trail: z.array(clipped(PATH_MAX)).max(10).optional(),
  })
  .default({});

export type ClientContext = z.infer<typeof clientContextSchema>;

export function cleanContext(context: ClientContext): ClientContext {
  return {
    ...context,
    path: context.path === undefined ? undefined : redactPath(context.path),
    trail: context.trail?.map(redactPath),
  };
}

const reportSchema = z.object({
  where: z.enum(CLIENT_ERROR_SOURCES),
  name: clipped(NAME_MAX).default("Error"),
  message: clipped(MESSAGE_MAX),
  stack: clipped(STACK_MAX).optional(),
  context: clientContextSchema,
});

/** Runs of digits and ids differ between occurrences of one bug. */
const normalise = (message: string) => message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{22}/gi, ":id").replace(/\d+/g, "N");

/** The top frames' files: no lines, which move, and no content hash, which every release changes. */
function topFiles(stack: string | null): string[] {
  if (!stack) return [];
  const files: string[] = [];
  for (const line of stack.split("\n")) {
    const file = /([\w@.-]+\.(?:[cm]?[jt]sx?))(?::\d+|\?|\)|$)/.exec(line)?.[1];
    if (file) files.push(file.replace(/-[\w-]{8}(?=\.js$)/, ""));
    if (files.length === 3) break;
  }
  return files;
}

/** Signed-out reports are their own groups, so one can't touch a group that matters. */
export function fingerprintOf(e: { source: string; name: string; message: string; stack: string | null; anonymous: boolean }): string {
  const parts = [e.source, e.anonymous ? "anonymous" : "known", e.name, normalise(e.message), ...topFiles(e.stack)];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

interface Occurrence {
  source: string;
  name: string;
  message: string;
  stack: string | null;
  anonymous: boolean;
  actorLabel: string | null;
  path: string | null;
  userAgent: string | null;
  revision: string | null;
  context: ClientContext | null;
}

function evict(limit: number, where: string): void {
  db()
    .query(`DELETE FROM error_groups WHERE id IN (SELECT id FROM error_groups WHERE ${where} ORDER BY last_at DESC, id DESC LIMIT -1 OFFSET ?)`)
    .run(limit);
}

/** Add to a group, or start one. Returns its id, and whether it's news to anyone. */
function record(o: Occurrence, now: number): { id: number; news: boolean } {
  const fingerprint = fingerprintOf(o);
  const database = db();
  const context = o.context ? JSON.stringify(o.context) : null;
  return database.transaction(() => {
    const row = database.query<{ id: number; status: ErrorStatus }, [string]>("SELECT id, status FROM error_groups WHERE fingerprint = ?").get(fingerprint);
    if (row) {
      database
        .query(
          `UPDATE error_groups SET count = count + 1, last_at = ?, stack = COALESCE(?, stack), last_revision = ?, last_actor_label = ?,
             last_path = ?, last_user_agent = ?, last_context = ?, status = CASE status WHEN 'resolved' THEN 'open' ELSE status END
           WHERE id = ?`,
        )
        .run(now, o.stack, o.revision, o.actorLabel, o.path, o.userAgent, context, row.id);
      return { id: row.id, news: row.status === "resolved" };
    }
    const { id } = database
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO error_groups (fingerprint, source, name, message, stack, anonymous, first_at, last_at, first_revision, last_revision, last_actor_label, last_path, last_user_agent, last_context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(fingerprint, o.source, o.name, o.message, o.stack, o.anonymous ? 1 : 0, now, now, o.revision, o.revision, o.actorLabel, o.path, o.userAgent, context)!;
    if (o.anonymous) evict(SIGNED_OUT_GROUPS_MAX, "anonymous = 1");
    evict(GROUPS_MAX, "1 = 1");
    return { id, news: true };
  })();
}

function tellAdmins(o: Occurrence, now: number): void {
  // Anyone can write a signed-out report, so nobody's phone buzzes for one.
  if (o.anonymous) return;
  const queued = enqueueForAdmins({ key: `error:${Math.floor(now / PUSH_EVERY_MS)}`, title: `New error: ${o.name}`, body: o.message.slice(0, 200), url: `${INBOX_URL}?tab=errors`, now });
  if (queued) requestNotifierPass();
}

/** A browser's report. The answer's id lets a note say which errors came just before it. */
export function reportClientError(actor: Actor, address: string | null, body: unknown, userAgent: string | null, now: number = Date.now()): number | null {
  checkErrorReportRate(actor, address, now);
  const report = reportSchema.parse(body);
  const context = cleanContext(report.context);
  const anonymous = actor.kind === "nobody";
  const occurrence: Occurrence = {
    source: `client:${report.where}`,
    name: redactText(report.name),
    message: redactText(report.message),
    stack: report.stack ? redactText(mapStack(report.stack)) : null,
    anonymous,
    actorLabel: anonymous ? null : actorLabel(actor),
    path: context.path ?? null,
    userAgent: userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    revision: context.revision ?? null,
    context,
  };
  const { id, news } = record(occurrence, now);
  if (news) tellAdmins(occurrence, now);
  return anonymous ? null : id;
}

function describe(err: unknown): { name: string; message: string; stack: string | null } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack ?? null };
  if (err instanceof Response) return { name: "Response", message: `A ${err.status} response was thrown`, stack: null };
  return { name: "Thrown value", message: String(err), stack: null };
}

/**
 * What the router hands us that's a real failure. A 4xx isn't: a scanner hunting for
 * /wp-login.php arrives as a 404 the router raised itself. Nor is someone leaving mid-load.
 */
export function worthReporting(error: unknown, request: Request): boolean {
  if (request.signal.aborted) return false;
  return !(isRouteErrorResponse(error) && error.status < 500);
}

const SERVER_REVISION = process.env.APP_REVISION ?? null;

/**
 * Note something that went wrong on the server. This runs while something else is
 * failing, possibly the database, so it never throws. Logging stays with the caller.
 */
export function reportServerError(source: string, err: unknown, context: { path?: string; actorLabel?: string; anonymous?: boolean } = {}): void {
  try {
    const { name, message, stack } = describe(err);
    const now = Date.now();
    const occurrence: Occurrence = {
      source: `server:${source}`,
      name: redactText(name).slice(0, NAME_MAX),
      message: redactText(message).slice(0, MESSAGE_MAX),
      stack: stack ? redactText(stack).slice(0, STACK_MAX) : null,
      anonymous: context.anonymous ?? false,
      actorLabel: context.actorLabel ?? null,
      path: context.path ? redactPath(context.path).slice(0, PATH_MAX) : null,
      userAgent: null,
      revision: SERVER_REVISION,
      context: null,
    };
    if (record(occurrence, now).news) tellAdmins(occurrence, now);
  } catch (failure) {
    console.error("[errors] couldn't record an error:", failure);
  }
}

// ---- the inbox ---------------------------------------------------------------------------

function assertCanTriage(actor: Actor): void {
  if (!canTriageReports(actor)) throw new ForbiddenError("This is for admins.");
}

interface GroupRow {
  id: number;
  source: string;
  name: string;
  message: string;
  stack: string | null;
  status: ErrorStatus;
  anonymous: number;
  count: number;
  first_at: number;
  last_at: number;
  first_revision: string | null;
  last_revision: string | null;
  last_actor_label: string | null;
  last_path: string | null;
  last_user_agent: string | null;
  last_context: string | null;
}

export interface ErrorGroupView {
  id: number;
  source: string;
  name: string;
  message: string;
  stack: string | null;
  status: ErrorStatus;
  anonymous: boolean;
  count: number;
  firstAt: number;
  lastAt: number;
  firstRevision: string | null;
  lastRevision: string | null;
  who: string | null;
  path: string | null;
  device: string | null;
  userAgent: string | null;
  context: ClientContext | null;
}

const toView = (r: GroupRow): ErrorGroupView => ({
  id: r.id,
  source: r.source,
  name: r.name,
  message: r.message,
  stack: r.stack,
  status: r.status,
  anonymous: r.anonymous === 1,
  count: r.count,
  firstAt: r.first_at,
  lastAt: r.last_at,
  firstRevision: r.first_revision,
  lastRevision: r.last_revision,
  who: r.last_actor_label,
  path: r.last_path,
  device: r.last_user_agent ? describeUserAgent(r.last_user_agent) : null,
  userAgent: r.last_user_agent,
  context: r.last_context ? (JSON.parse(r.last_context) as ClientContext) : null,
});

/** Newest first. Signed-out reports go last, since anyone could have written them. */
export function listErrorGroups(actor: Actor, filter: { open?: boolean; limit?: number } = {}): ErrorGroupView[] {
  assertCanTriage(actor);
  const where = filter.open ? "WHERE status = 'open'" : "";
  return db()
    .query<GroupRow, [number]>(`SELECT * FROM error_groups ${where} ORDER BY anonymous, last_at DESC LIMIT ?`)
    .all(filter.limit ?? 200)
    .map(toView);
}

export function setErrorStatus(actor: Extract<Actor, { kind: "user" }>, id: number, status: string): void {
  assertCanTriage(actor);
  const next = z.enum(ERROR_STATUSES).parse(status);
  const row = db().query<{ status: string }, [number]>("SELECT status FROM error_groups WHERE id = ?").get(id);
  if (!row) throw new NotFoundError("That error has gone.");
  db().query("UPDATE error_groups SET status = ? WHERE id = ?").run(next, id);
  audit({ actorUserId: actor.userId, entity: "error_group", entityId: id, action: "status", before: { status: row.status }, after: { status: next } });
}

export function countOpenErrors(): number {
  // Signed-out reports don't count: the number mustn't be something a stranger can raise.
  return db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM error_groups WHERE status = 'open' AND anonymous = 0").get()!.n;
}
