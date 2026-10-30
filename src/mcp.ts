import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { type AgentActor, type IntegrationActor, actorLabel } from "./actors.ts";
import { authenticateBearer } from "./agents.ts";
import { config, site } from "./config.server.ts";
import { DomainError } from "./errors.ts";
import { errorResponse } from "./http/guard.ts";
import { DEDUPE_KEY_MAX_LENGTH, DETAILS_MAX_LENGTH, TITLE_MAX_LENGTH } from "./limits.ts";
import { locationSchema, recurrenceSchema } from "./task-schema.ts";
import {
  addComment,
  completeByDedupeKey,
  completeTask,
  createTask,
  getTask,
  listAssignable,
  listComments,
  listLabels,
  listTasks,
  listZones,
  reopenTask,
  taskHistory,
  updateTask,
} from "./tasks.ts";

/**
 * MCP at /mcp: stateless Streamable HTTP, a new McpServer per request. The
 * tools are thin calls into src/tasks.ts as the agent, so permissions, audit and
 * rate limits are exactly those of the REST API, and what's shown as having
 * done it is the agent.
 */

type TokenActor = AgentActor | IntegrationActor;

function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec((request.headers.get("Authorization") ?? "").trim())?.[1] ?? null;
}

const INSTRUCTIONS = (actor: TokenActor) =>
  `Punchlist: a shared list of physical jobs for a real space. You are ${actorLabel(actor)}, and everything you do is recorded under that name.
Before creating a task, search for an existing one. Set dedupe_key on anything created by automation, so a repeat updates it rather than duplicating it.
Public tasks are seen by everyone in the space; private tasks only by their owner and the people they're shared with or assigned to. Ask the person you act for before making a public task on their behalf if it wasn't what they asked for.
Dates are calendar days (YYYY-MM-DD) in the space's time zone, ${config.timezone}.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Run a domain call, turning its refusals into something the model can read and act on. */
function tool(fn: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof DomainError || err instanceof z.ZodError) {
      const message = err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid input.") : err.message;
      return { content: [{ type: "text", text: message }], isError: true };
    }
    throw err;
  }
}

const taskFields = {
  title: z.string().min(1).max(TITLE_MAX_LENGTH),
  details: z.string().max(DETAILS_MAX_LENGTH).optional().describe("Longer description"),
  due_date: z.string().nullable().optional().describe("YYYY-MM-DD, or null for no date"),
  labels: z.array(z.string()).optional().describe("Label names, from list_labels"),
  assignees: z.array(z.number().int()).optional().describe("User ids, from list_people"),
  location: locationSchema.nullable().optional().describe("{ zoneId } from list_zones, or { mapId, x, y }, optionally with a note"),
  recurrence: recurrenceSchema.nullable().optional().describe("Repeat on an RRULE schedule, or some days after completion"),
};

function registerTools(server: McpServer, actor: TokenActor): void {
  const write = { via: actor.kind === "integration" ? actor.via : "mcp" };

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks you can see. Defaults to open tasks.",
      inputSchema: {
        status: z.enum(["open", "done", "all"]).optional(),
        label: z.string().optional().describe("Label name"),
        zone: z.string().optional().describe("Zone id"),
        assignee: z.number().int().optional().describe("User id"),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    (args) => tool(() => listTasks(actor, args)),
  );

  server.registerTool(
    "search_tasks",
    {
      description: "Search task titles and details, open and done.",
      inputSchema: { query: z.string().min(1).max(200), status: z.enum(["open", "done", "all"]).optional() },
    },
    ({ query, status }) => tool(() => listTasks(actor, { q: query, status: status ?? "all" })),
  );

  server.registerTool(
    "get_task",
    { description: "One task, with its comments and history.", inputSchema: { id: z.string() } },
    ({ id }) => tool(() => ({ task: getTask(actor, id), comments: listComments(actor, id), history: taskHistory(actor, id) })),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task. With dedupe_key, an open task with the same key is updated instead, and the result says deduped.",
      inputSchema: {
        ...taskFields,
        visibility: z.enum(["public", "private"]).optional().describe("Defaults to public"),
        dedupe_key: z.string().min(1).max(DEDUPE_KEY_MAX_LENGTH).optional(),
        idempotency_key: z.string().max(200).optional().describe("A retry with the same key returns the first result"),
      },
    },
    (args) =>
      tool(() =>
        createTask(
          actor,
          {
            title: args.title,
            details: args.details,
            visibility: args.visibility,
            dueDate: args.due_date,
            labels: args.labels,
            assignees: args.assignees,
            location: args.location,
            recurrence: args.recurrence,
            dedupeKey: args.dedupe_key,
          },
          { ...write, idempotencyKey: args.idempotency_key },
        ),
      ),
  );

  server.registerTool(
    "update_task",
    {
      description: "Change a task. Only the fields you pass change.",
      inputSchema: {
        id: z.string(),
        ...taskFields,
        title: taskFields.title.optional(),
        visibility: z.enum(["public", "private"]).optional(),
        idempotency_key: z.string().max(200).optional(),
      },
    },
    ({ id, due_date, idempotency_key, ...rest }) =>
      tool(() => updateTask(actor, id, { ...rest, ...(due_date !== undefined ? { dueDate: due_date } : {}) }, { ...write, idempotencyKey: idempotency_key })),
  );

  server.registerTool(
    "complete_task",
    {
      description: "Check a task off, by id or by dedupe_key. A note is kept with it.",
      inputSchema: {
        id: z.string().optional(),
        dedupe_key: z.string().max(DEDUPE_KEY_MAX_LENGTH).optional(),
        note: z.string().max(4000).optional(),
        idempotency_key: z.string().max(200).optional(),
      },
    },
    ({ id, dedupe_key, note, idempotency_key }) =>
      tool(() => {
        if (id) return completeTask(actor, id, { note }, { ...write, idempotencyKey: idempotency_key });
        if (dedupe_key) return { task: completeByDedupeKey(actor, dedupe_key, { note }, { ...write, idempotencyKey: idempotency_key }) };
        throw new z.ZodError([{ code: "custom", path: ["id"], message: "Pass id or dedupe_key.", input: undefined }]);
      }),
  );

  server.registerTool(
    "reopen_task",
    { description: "Reopen a completed task.", inputSchema: { id: z.string(), idempotency_key: z.string().max(200).optional() } },
    ({ id, idempotency_key }) => tool(() => reopenTask(actor, id, { ...write, idempotencyKey: idempotency_key })),
  );

  server.registerTool(
    "add_comment",
    { description: "Comment on a task.", inputSchema: { id: z.string(), body: z.string().min(1).max(4000) } },
    ({ id, body }) => tool(() => addComment(actor, id, { body }, write)),
  );

  server.registerTool("list_labels", { description: "The labels in use.", inputSchema: {} }, () => tool(() => listLabels(actor)));
  server.registerTool("list_zones", { description: "The zones of the space, and their map.", inputSchema: {} }, () => tool(() => listZones(actor)));
  server.registerTool("list_people", { description: "People who can be assigned, by id and name.", inputSchema: {} }, () => tool(() => listAssignable(actor)));
  server.registerTool("who_am_i", { description: "Who this token acts as, and what it may do.", inputSchema: {} }, () =>
    tool(() => ({ actor: actorLabel(actor), scopes: actor.scopes, space: site().name, timeZone: config.timezone })),
  );
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "A bearer token is required. Make one under Settings, then Agents." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "WWW-Authenticate": 'Bearer realm="punchlist"' },
  });
}

export async function handleMcp(request: Request): Promise<Response> {
  try {
    // Tokens only: a session cookie or a LAN position gets nothing here.
    const token = bearer(request);
    const actor = token ? authenticateBearer(token) : null;
    if (!actor) return unauthorized();

    // Browsers can send a bearer token too. The spec asks for this check to stop
    // a page in someone's browser reaching a local server by DNS rebinding.
    const origin = request.headers.get("Origin");
    if (origin && origin !== config.publicBaseUrl) return new Response("Origin not allowed\n", { status: 403 });

    // Stateless: there is never anything to push, so decline the optional
    // standalone SSE stream (the spec's 405). Accepting it would park every
    // client's GET forever and keep a graceful shutdown from finishing.
    if (request.method === "GET") {
      return new Response("no standalone SSE stream: this server is stateless\n", { status: 405, headers: { Allow: "POST, DELETE" } });
    }

    const server = new McpServer({ name: "punchlist", version: "1.0.0" }, { instructions: INSTRUCTIONS(actor) });
    registerTools(server, actor);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
