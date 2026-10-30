import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, setConfigForTests } from "./config.server.ts";
import { createFeed, renderFeed } from "./feeds.ts";
import { apiFromRequest } from "./http/api.ts";
import { resolveRequest } from "./http/resolve-actor.ts";
import { eventStream } from "./http/events.ts";
import { handleMcp } from "./mcp.ts";
import { indexData, mapPageData, activityData, taskPageData } from "../app/tasks.server.ts";
import { addAttachment, addComment, createTask, updateTask } from "./tasks.ts";
import { publish } from "./live.ts";
import { type World, INTEGRATION_TOKEN, ORIGIN, PERIMETER_HEADER, agentFor, deviceHeader, freshWorld, sessionHeader } from "./testing/fixtures.ts";
import { NOBODY } from "./actors.ts";
import { reauthenticator } from "./http/resolve-actor.ts";

/**
 * The tests that matter most. One public task and one private task, and every
 * surface that can show a task, each asked by every kind of caller. What's being
 * proved: public means the space, private means its parties, and a signed-out
 * internet visitor gets nothing at all, on any surface.
 */

const SECRET = "SECRET-private-title";
const SECRET_DETAIL = "SECRET-private-detail";
const PUBLIC = "public-task-title";

let w: World;
let attachmentsDir: string;
let publicId: string;
let privateId: string;
let publicAttachment: string;
let privateAttachment: string;

function fileFor(id: string): void {
  Bun.write(join(config.attachmentsDir, id), "file bytes");
}

beforeEach(() => {
  w = freshWorld();
  attachmentsDir = mkdtempSync(join(tmpdir(), "punchlist-test-"));
  config.attachmentsDir = attachmentsDir;
  publicId = createTask(w.alice, { title: PUBLIC, dueDate: "2030-06-01", location: { zoneId: "bay-1" } }).task.id;
  privateId = createTask(w.alice, { title: SECRET, details: SECRET_DETAIL, visibility: "private", dueDate: "2030-06-02", location: { mapId: "shop", x: 75, y: 25 } }).task.id;
  addComment(w.alice, privateId, { body: `${SECRET} comment` });
  const add = (taskId: string, id: string) => {
    addAttachment(w.alice, taskId, { id, filename: "photo.png", mime: "application/octet-stream", size: 10, sha256: "x", width: null, height: null, hasThumb: false });
    fileFor(id);
  };
  publicAttachment = "01900000-0000-7000-8000-000000000001";
  privateAttachment = "01900000-0000-7000-8000-000000000002";
  add(publicId, publicAttachment);
  add(privateId, privateAttachment);
});

afterEach(() => {
  setConfigForTests(undefined);
  rmSync(attachmentsDir, { recursive: true, force: true });
});

interface Caller {
  name: string;
  headers: () => Promise<Record<string, string>>;
}

const anonymous: Caller = { name: "a signed-out visitor from the internet", headers: async () => ({}) };
const lan: Caller = { name: "an on-site visitor", headers: async () => ({ [PERIMETER_HEADER]: "lan", Cookie: await deviceHeader() }) };
const asUser = (name: string, who: () => World["alice"]): Caller => ({ name, headers: async () => ({ Cookie: await sessionHeader(who()) }) });

async function get(path: string, caller: Caller): Promise<Response> {
  return apiFromRequest(new Request(`${ORIGIN}${path}`, { headers: await caller.headers() }));
}

const body = async (r: Response) => JSON.stringify(await r.json());

describe("a signed-out internet visitor gets zero task data", () => {
  const paths = ["/api/v1/tasks", "/api/v1/activity", "/api/v1/labels", "/api/v1/zones", "/api/v1/maps", "/api/v1/people", "/api/v1/events"];
  for (const path of paths) {
    test(`GET ${path} is 401`, async () => {
      const response = await get(path, anonymous);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    });
  }

  test("a task by id, its events, comments and attachments are 401", async () => {
    for (const path of [`/api/v1/tasks/${publicId}`, `/api/v1/tasks/${publicId}/events`, `/api/v1/tasks/${publicId}/comments`, `/api/v1/tasks/${publicId}/attachments`, `/api/v1/attachments/${publicAttachment}`]) {
      expect((await get(path, anonymous)).status).toBe(401);
    }
  });

  test("a device cookie from an earlier visit means nothing off site", async () => {
    const response = await apiFromRequest(new Request(`${ORIGIN}/api/v1/tasks`, { headers: { Cookie: await deviceHeader() } }));
    expect(response.status).toBe(401);
  });

  test("a feed with no token or a wrong one is nothing", () => {
    expect(renderFeed("")).toBeNull();
    expect(renderFeed("x".repeat(43))).toBeNull();
  });

  test("MCP is 401 with WWW-Authenticate", async () => {
    const response = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  });
});

describe("REST", () => {
  test("lists show public to the space and private only to its owner", async () => {
    const seen = async (caller: Caller) => body(await get("/api/v1/tasks", caller));
    for (const caller of [lan, asUser("Bob", () => w.bob), asUser("the admin", () => w.admin)]) {
      const text = await seen(caller);
      expect(text).toContain(PUBLIC);
      expect(text).not.toContain(SECRET);
    }
    expect(await seen(asUser("Alice", () => w.alice))).toContain(SECRET);
  });

  test("private by id is 404 for an on-site visitor, a stranger and an admin", async () => {
    for (const caller of [lan, asUser("Bob", () => w.bob), asUser("the admin", () => w.admin)]) {
      for (const path of [`/api/v1/tasks/${privateId}`, `/api/v1/tasks/${privateId}/events`, `/api/v1/tasks/${privateId}/comments`, `/api/v1/tasks/${privateId}/attachments`]) {
        const response = await get(path, caller);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("SECRET");
      }
    }
  });

  test("search doesn't reach into private tasks", async () => {
    const text = await body(await get("/api/v1/tasks?q=SECRET&status=all", lan));
    expect(text).toBe('{"tasks":[]}');
    expect(await body(await get("/api/v1/tasks?q=SECRET&status=all", asUser("the admin", () => w.admin)))).toBe('{"tasks":[]}');
  });

  test("activity doesn't either", async () => {
    expect(await body(await get("/api/v1/activity", lan))).not.toContain("SECRET");
    expect(await body(await get("/api/v1/activity", asUser("the admin", () => w.admin)))).not.toContain("SECRET");
    expect(await body(await get("/api/v1/activity", asUser("Alice", () => w.alice)))).toContain("SECRET");
  });

  test("the on-site tier gets no people list", async () => {
    expect(await body(await get("/api/v1/people", lan))).toBe('{"people":[]}');
  });

  test("every data response is private, no-store", async () => {
    for (const path of ["/api/v1/tasks", `/api/v1/tasks/${publicId}`, "/api/v1/labels", `/api/v1/tasks/${publicId}/events`]) {
      expect((await get(path, lan)).headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  test("agents see what their scopes and owner allow", async () => {
    const bearer = (token: string): Caller => ({ name: "an agent", headers: async () => ({ Authorization: `Bearer ${token}` }) });
    const full = agentFor(w.alice).token;
    const publicOnly = agentFor(w.alice, ["tasks:read"]).token;
    const bobs = agentFor(w.bob).token;
    expect(await body(await get("/api/v1/tasks", bearer(full)))).toContain(SECRET);
    expect(await body(await get("/api/v1/tasks", bearer(publicOnly)))).not.toContain(SECRET);
    expect(await body(await get("/api/v1/tasks", bearer(bobs)))).not.toContain(SECRET);
    expect((await get(`/api/v1/tasks/${privateId}`, bearer(bobs))).status).toBe(404);
  });

  test("an integration never sees private tasks", async () => {
    const monitor: Caller = { name: "the integration", headers: async () => ({ Authorization: `Bearer ${INTEGRATION_TOKEN}` }) };
    const text = await body(await get("/api/v1/tasks", monitor));
    expect(text).toContain(PUBLIC);
    expect(text).not.toContain(SECRET);
    expect((await get(`/api/v1/tasks/${privateId}`, monitor)).status).toBe(404);
  });
});

describe("the UI's loaders", () => {
  const url = new URL(`${ORIGIN}/`);

  test("the home screen", () => {
    expect(JSON.stringify(indexData(w.lan, url))).not.toContain(SECRET);
    expect(JSON.stringify(indexData(w.admin, url))).not.toContain(SECRET);
    expect(JSON.stringify(indexData(w.bob, url))).toContain(PUBLIC);
    expect(JSON.stringify(indexData(w.alice, url))).toContain(SECRET);
  });

  test("a task page throws for what the viewer can't see", () => {
    expect(() => taskPageData(w.lan, privateId)).toThrow();
    expect(() => taskPageData(w.admin, privateId)).toThrow();
    expect(taskPageData(w.alice, privateId).task.details).toBe(SECRET_DETAIL);
  });

  test("the map", () => {
    expect(JSON.stringify(mapPageData(w.lan))).not.toContain(SECRET);
    expect(JSON.stringify(mapPageData(w.admin))).not.toContain(SECRET);
    expect(JSON.stringify(mapPageData(w.alice))).toContain(SECRET);
  });

  test("activity", () => {
    expect(JSON.stringify(activityData(w.lan))).not.toContain(SECRET);
    expect(JSON.stringify(activityData(w.admin))).not.toContain(SECRET);
  });
});

describe("attachments", () => {
  test("inherit their task's visibility", async () => {
    expect((await get(`/api/v1/attachments/${publicAttachment}`, lan)).status).toBe(200);
    expect((await get(`/api/v1/attachments/${privateAttachment}`, lan)).status).toBe(404);
    expect((await get(`/api/v1/attachments/${privateAttachment}`, asUser("the admin", () => w.admin))).status).toBe(404);
    expect((await get(`/api/v1/attachments/${privateAttachment}`, asUser("Bob", () => w.bob))).status).toBe(404);
    expect((await get(`/api/v1/attachments/${privateAttachment}`, asUser("Alice", () => w.alice))).status).toBe(200);
    expect((await get(`/api/v1/attachments/${publicAttachment}/thumb`, lan)).status).toBe(404);
  });

  test("a task going private takes its attachments with it", async () => {
    updateTask(w.alice, publicId, { visibility: "private" });
    expect((await get(`/api/v1/attachments/${publicAttachment}`, lan)).status).toBe(404);
  });

  test("carry the safety headers", async () => {
    const response = await get(`/api/v1/attachments/${publicAttachment}`, lan);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toStartWith("attachment;");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("calendar feeds", () => {
  const tokenOf = (url: string) => url.split("/feeds/")[1]!.replace(".ics", "");

  test("leave private tasks out by default", () => {
    const ics = renderFeed(tokenOf(createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public_and_mine" }).url))!;
    expect(ics).toContain(PUBLIC);
    expect(ics).not.toContain("SECRET");
  });

  test("titles-only means titles only", () => {
    const ics = renderFeed(tokenOf(createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public_and_mine", privateMode: "titles" }).url))!;
    expect(ics).toContain(SECRET);
    expect(ics).not.toContain(SECRET_DETAIL);
  });

  test("a feed with private on still can't show another person's private tasks", () => {
    const ics = renderFeed(tokenOf(createFeed({ ownerUserId: w.bob.userId, name: "Bob's", scope: "public_and_mine", privateMode: "full" }).url))!;
    expect(ics).not.toContain("SECRET");
  });

  test("an admin's feed gets nothing from their being an admin", () => {
    const ics = renderFeed(tokenOf(createFeed({ ownerUserId: w.admin.userId, name: "Admin's", scope: "public_and_mine", privateMode: "full" }).url))!;
    expect(ics).not.toContain("SECRET");
  });

  test("never carry an attachment URL", () => {
    const ics = renderFeed(tokenOf(createFeed({ ownerUserId: w.alice.userId, name: "All", scope: "public_and_mine", privateMode: "full" }).url))!;
    expect(ics).not.toContain("attachments/");
  });
});

describe("MCP", () => {
  async function call(token: string, tool: string, args: unknown = {}) {
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      }),
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  test("shows an agent what its scopes and owner allow", async () => {
    expect(await call(agentFor(w.alice).token, "list_tasks")).toContain(SECRET);
    expect(await call(agentFor(w.alice, ["tasks:read"]).token, "list_tasks")).not.toContain("SECRET");
    expect(await call(agentFor(w.bob).token, "list_tasks")).not.toContain("SECRET");
    expect(await call(agentFor(w.bob).token, "search_tasks", { query: "SECRET" })).not.toContain("SECRET-private-title");
    expect(await call(agentFor(w.bob).token, "get_task", { id: privateId })).not.toContain("SECRET");
  });

  test("gives an integration nothing private", async () => {
    expect(await call(INTEGRATION_TOKEN, "list_tasks")).not.toContain("SECRET");
  });

  test("a session cookie and a LAN position are not tokens", async () => {
    const asLan = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { [PERIMETER_HEADER]: "lan", Cookie: await deviceHeader() }, body: "{}" }));
    expect(asLan.status).toBe(401);
    const asAlice = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { Cookie: await sessionHeader(w.alice) }, body: "{}" }));
    expect(asAlice.status).toBe(401);
  });
});

describe("SSE", () => {
  /** Open a stream as this caller, and read what it says after `act`. */
  async function hear(caller: Caller, act: () => void): Promise<string> {
    const controller = new AbortController();
    const request = new Request(`${ORIGIN}/api/v1/events`, { headers: await caller.headers(), signal: controller.signal });
    const resolved = await resolveRequest(request);
    const response = eventStream({ request, actor: resolved.actor, reauthenticate: reauthenticator(request, resolved) });
    const reader = response.body!.getReader();
    await reader.read(); // the opening comment
    act();
    controller.abort();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    return text;
  }

  test("a change to a private task reaches its parties and no one else", async () => {
    const change = () => publish({ taskId: privateId, resync: false });
    expect(await hear(asUser("Alice", () => w.alice), change)).toContain(privateId);
    for (const caller of [lan, asUser("Bob", () => w.bob), asUser("the admin", () => w.admin)]) {
      expect(await hear(caller, change)).not.toContain(privateId);
    }
  });

  test("a change to a public task reaches the space", async () => {
    expect(await hear(lan, () => publish({ taskId: publicId, resync: false }))).toContain(publicId);
  });

  test("a resync says nothing about which task", async () => {
    const text = await hear(lan, () => publish({ taskId: privateId, resync: true }));
    expect(text).toContain("event: resync");
    expect(text).not.toContain(privateId);
  });

  test("the stream ends when the credential does", async () => {
    let live = true;
    const request = new Request(`${ORIGIN}/api/v1/events`);
    const response = eventStream({ request, actor: w.alice, reauthenticate: () => (live ? w.alice : null) });
    const reader = response.body!.getReader();
    await reader.read();
    live = false;
    publish({ taskId: publicId, resync: false });
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  test("nobody can open one", async () => {
    const response = await get("/api/v1/events", anonymous);
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).not.toContain("event-stream");
    expect(NOBODY.kind).toBe("nobody");
  });
});
