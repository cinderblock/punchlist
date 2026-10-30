import { deleteUpload, serveAttachment, serveThumb, storeUpload } from "../attachment-store.ts";
import { type Actor, actorLabel } from "../actors.ts";
import { site } from "../config.server.ts";
import { ForbiddenError, UnauthorizedError, UserInputError } from "../errors.ts";
import { listFilterSchema } from "../task-schema.ts";
import {
  addComment,
  activity,
  completeByDedupeKey,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listAssignable,
  listAttachments,
  listComments,
  listLabels,
  listTasks,
  listZones,
  reopenTask,
  taskHistory,
  updateTask,
  type WriteContext,
} from "../tasks.ts";
import { eventStream } from "./events.ts";
import { assertJsonBody, assertSameOrigin, errorResponse, json, readJson } from "./guard.ts";
import { type ResolvedRequest, reauthenticator, resolveRequest, setDeviceName } from "./resolve-actor.ts";

/**
 * The REST API, /api/v1. The UI and tokens use the same endpoints: the browser
 * has no private way in. Every route here is a thin call into src/tasks.ts.
 *
 * A signed-out visitor from the internet gets 401 from all of it, without
 * touching the domain.
 */

interface Ctx {
  request: Request;
  url: URL;
  actor: Actor;
  resolved: ResolvedRequest;
  write: WriteContext;
}

type Handler = (ctx: Ctx, params: Record<string, string>) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  /** Cookie-authenticated calls need JSON. Uploads are raw bodies, from a signed-in person. */
  rawBody?: boolean;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, options: { rawBody?: boolean } = {}): void {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  })}$`);
  routes.push({ method, pattern, keys, handler, ...options });
}

const mutating = (method: string) => method !== "GET" && method !== "HEAD";

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new UserInputError("That key isn't valid.");
  }
}

function queryFilter(url: URL) {
  const q = url.searchParams;
  const number = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined);
  const label = q.get("label");
  return listFilterSchema.parse({
    status: q.get("status") ?? undefined,
    q: q.get("q") ?? undefined,
    label: label == null ? undefined : /^\d+$/.test(label) ? Number(label) : label,
    zone: q.get("zone") ?? undefined,
    assignee: number("assignee"),
    unassigned: q.get("unassigned") === "true" ? true : undefined,
    visibility: q.get("visibility") ?? undefined,
    dueBy: q.get("dueBy") ?? undefined,
    limit: number("limit"),
  });
}

route("GET", "/api/v1/me", ({ actor }) => json({ kind: actor.kind, label: actorLabel(actor), scopes: "scopes" in actor ? actor.scopes : undefined }));

route("GET", "/api/v1/tasks", ({ actor, url }) => json({ tasks: listTasks(actor, queryFilter(url)) }));

route("POST", "/api/v1/tasks", async ({ actor, request, write }) => {
  const result = createTask(actor, (await readJson(request)) as never, write);
  return json(result, { status: result.deduped ? 200 : 201 });
});

route("GET", "/api/v1/tasks/:id", ({ actor }, { id }) => json({ task: getTask(actor, id!) }));

route("PATCH", "/api/v1/tasks/:id", async ({ actor, request, write }, { id }) => json({ task: updateTask(actor, id!, (await readJson(request)) as never, write) }));

route("DELETE", "/api/v1/tasks/:id", ({ actor, write }, { id }) => {
  deleteTask(actor, id!, write);
  return json({ ok: true });
});

route("POST", "/api/v1/tasks/:id/complete", async ({ actor, request, write }, { id }) => json({ task: completeTask(actor, id!, (await readJson(request)) as never, write) }));

route("POST", "/api/v1/tasks/:id/reopen", ({ actor, write }, { id }) => json({ task: reopenTask(actor, id!, write) }));

route("GET", "/api/v1/tasks/:id/events", ({ actor }, { id }) => json({ events: taskHistory(actor, id!) }));

route("GET", "/api/v1/tasks/:id/comments", ({ actor }, { id }) => json({ comments: listComments(actor, id!) }));

route("POST", "/api/v1/tasks/:id/comments", async ({ actor, request, write }, { id }) =>
  json({ comment: addComment(actor, id!, (await readJson(request)) as never, write) }, { status: 201 }),
);

route("GET", "/api/v1/tasks/:id/attachments", ({ actor }, { id }) => json({ attachments: listAttachments(actor, id!) }));

route(
  "POST",
  "/api/v1/tasks/:id/attachments",
  async ({ actor, request, url, write }, { id }) => json({ attachment: await storeUpload(actor, id!, request, url.searchParams.get("filename"), write) }, { status: 201 }),
  { rawBody: true },
);

route("GET", "/api/v1/attachments/:id", ({ actor }, { id }) => serveAttachment(actor, id!));
route("GET", "/api/v1/attachments/:id/thumb", ({ actor }, { id }) => serveThumb(actor, id!));

route("DELETE", "/api/v1/attachments/:id", ({ actor, write }, { id }) => {
  deleteUpload(actor, id!, write);
  return json({ ok: true });
});

route("POST", "/api/v1/dedupe/:key/complete", async ({ actor, request, write }, { key }) => {
  const task = completeByDedupeKey(actor, decodeKey(key!), (await readJson(request)) as never, write);
  return json({ task, closed: task != null });
});

route("GET", "/api/v1/activity", ({ actor }) => json({ activity: activity(actor) }));
route("GET", "/api/v1/labels", ({ actor }) => json({ labels: listLabels(actor) }));
route("GET", "/api/v1/zones", ({ actor }) => json({ zones: listZones(actor) }));
route("GET", "/api/v1/people", ({ actor }) => json({ people: listAssignable(actor) }));
route("GET", "/api/v1/maps", ({ actor }) => {
  listZones(actor); // the same reader check
  return json({ maps: site().maps });
});

route("GET", "/api/v1/events", ({ actor, request, resolved }) => eventStream({ request, actor, reauthenticate: reauthenticator(request, resolved) }));

route("PATCH", "/api/v1/device", async ({ actor, request }) => {
  if (actor.kind !== "lan_device") throw new ForbiddenError("Only an on-site device has a device name.");
  const body = await readJson(request);
  return json({ label: actorLabel(setDeviceName(actor, body.name)) });
});

/** The whole API, from a resolved request to a response. Errors become their status. */
export async function handleApi(request: Request, resolved: ResolvedRequest): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = routes.flatMap((r) => {
      const m = r.pattern.exec(url.pathname);
      return m ? [{ r, m }] : [];
    });
    if (match.length === 0) return json({ error: "Not found." }, { status: 404 });
    const found = match.find(({ r }) => r.method === request.method);
    if (!found) {
      return json({ error: "Method not allowed." }, { status: 405, headers: { Allow: [...new Set(match.map(({ r }) => r.method))].join(", ") } });
    }

    const { actor, credential } = resolved;
    if (actor.kind === "nobody") throw new UnauthorizedError();

    if (mutating(request.method) && credential !== "bearer") {
      // Cookie or network position: ambient authority, so prove this came from our own pages.
      assertSameOrigin(request);
      if (!found.r.rawBody && request.method !== "DELETE") assertJsonBody(request);
    }

    const params: Record<string, string> = {};
    found.r.keys.forEach((key, i) => (params[key] = found.m[i + 1]!));
    const write: WriteContext = {
      via: credential === "bearer" ? (actor.kind === "integration" ? actor.via : "api") : "ui",
      idempotencyKey: request.headers.get("Idempotency-Key"),
    };
    return await found.r.handler({ request, url, actor, resolved, write }, params);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Convenience for tests and the attachment routes: resolve, then handle. */
export async function apiFromRequest(request: Request): Promise<Response> {
  return handleApi(request, await resolveRequest(request));
}
