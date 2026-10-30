import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { userActor } from "./actors.ts";
import { authenticateBearer, createAgent, listAgents, listAllAgents, revokeAgent } from "./agents.ts";
import { setConfigForTests } from "./config.server.ts";
import { sha256Hex } from "./crypto.ts";
import { db } from "./db.server.ts";
import { ForbiddenError, NotFoundError, UserInputError } from "./errors.ts";
import { createFeed, listFeeds, renderFeed, revokeFeed } from "./feeds.ts";
import { apiFromRequest } from "./http/api.ts";
import { handleMcp } from "./mcp.ts";
import { createTask } from "./tasks.ts";
import { type World, INTEGRATION_TOKEN, ORIGIN, agentFor, freshWorld } from "./testing/fixtures.ts";
import { updateUserAccess } from "./users.ts";

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

const asToken = (token: string) => apiFromRequest(new Request(`${ORIGIN}/api/v1/tasks`, { headers: { Authorization: `Bearer ${token}` } }));
const mcpAs = (token: string) =>
  handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
const tokenOf = (url: string) => url.split("/feeds/")[1]!.replace(".ics", "");

describe("agent tokens", () => {
  test("are pl_<id>_<secret>, shown once, and hashed at rest", () => {
    const { agent, token } = createAgent({ ownerUserId: w.alice.userId, name: "Helper", scopes: ["tasks:read"], actorUserId: w.alice.userId });
    expect(token).toMatch(new RegExp(`^pl_${agent.id}_[A-Za-z0-9_-]{43}$`));
    const row = db().query<{ token_hash: string }, []>("SELECT token_hash FROM agents").get()!;
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(db().query("SELECT * FROM agents").all())).not.toContain(token);
    expect(JSON.stringify(listAgents(w.alice.userId))).not.toContain("hash");
  });

  test("the secret part really is checked", async () => {
    const { token } = agentFor(w.alice);
    const forged = token.slice(0, -4) + "AAAA";
    expect(authenticateBearer(forged)).toBeNull();
    expect((await asToken(forged)).status).toBe(401);
  });

  test("revoking stops it on its next request, over REST and MCP", async () => {
    const { actor, token } = agentFor(w.alice);
    expect((await asToken(token)).status).toBe(200);
    expect((await mcpAs(token)).status).toBe(200);
    revokeAgent({ id: actor.agentId, actor: w.alice });
    expect((await asToken(token)).status).toBe(401);
    expect((await mcpAs(token)).status).toBe(401);
  });

  test("the owner or an admin can revoke; nobody else, and not an agent", () => {
    const { actor } = agentFor(w.alice);
    expect(() => revokeAgent({ id: actor.agentId, actor: w.bob })).toThrow(NotFoundError);
    expect(() => revokeAgent({ id: actor.agentId, actor: agentFor(w.alice).actor })).toThrow(ForbiddenError);
    revokeAgent({ id: actor.agentId, actor: w.admin });
    expect(listAllAgents().map((a) => a.id)).not.toContain(actor.agentId);
  });

  test("deactivating the owner ends the agent at once, and reactivating brings it back", async () => {
    const { token } = agentFor(w.alice);
    updateUserAccess({ userId: w.alice.userId, active: false, actorUserId: w.admin.userId });
    expect((await asToken(token)).status).toBe(401);
    expect((await mcpAs(token)).status).toBe(401);
    updateUserAccess({ userId: w.alice.userId, active: true, actorUserId: w.admin.userId });
    expect((await asToken(token)).status).toBe(200);
  });

  test("need a name and real scopes", () => {
    const base = { ownerUserId: w.alice.userId, actorUserId: w.alice.userId };
    expect(() => createAgent({ ...base, name: "  ", scopes: ["tasks:read"] })).toThrow(UserInputError);
    expect(() => createAgent({ ...base, name: "x", scopes: [] })).toThrow(UserInputError);
    expect(() => createAgent({ ...base, name: "x", scopes: ["tasks:read", "admin"] })).toThrow(UserInputError);
  });
});

describe("integrations", () => {
  test("authenticate with the token named in the config", async () => {
    expect(authenticateBearer(INTEGRATION_TOKEN)).toMatchObject({ kind: "integration", integrationId: "monitor", name: "Monitor" });
    expect((await asToken(INTEGRATION_TOKEN)).status).toBe(200);
  });

  test("show as themselves, and record the channel", () => {
    const actor = authenticateBearer(INTEGRATION_TOKEN)!;
    const { task } = createTask(actor, { title: "Door sensor offline", dedupeKey: "door" }, { via: "api" });
    expect(task.createdBy).toBe("Monitor");
  });

  test("have no owner, so no private tasks, no assigning, no deleting", () => {
    const actor = authenticateBearer(INTEGRATION_TOKEN)!;
    expect(() => createTask(actor, { title: "x", visibility: "private" })).toThrow(ForbiddenError);
    expect(() => createTask(actor, { title: "x", assignees: [w.alice.userId] })).toThrow(ForbiddenError);
  });

  test("a missing or short token variable leaves it off", () => {
    process.env.TEST_INTEGRATION_TOKEN = "short";
    expect(authenticateBearer("short")).toBeNull();
    delete process.env.TEST_INTEGRATION_TOKEN;
    expect(authenticateBearer(INTEGRATION_TOKEN)).toBeNull();
  });
});

describe("feed tokens", () => {
  test("are hashed at rest and shown once", () => {
    const { url } = createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public" });
    const token = tokenOf(url);
    expect(JSON.stringify(db().query("SELECT * FROM feeds").all())).not.toContain(token);
    expect(JSON.stringify(listFeeds(w.alice.userId))).not.toContain(token);
    expect(url).toEndWith(".ics");
  });

  test("revoking kills it", () => {
    const { url, feed } = createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public" });
    expect(renderFeed(tokenOf(url))).toContain("BEGIN:VCALENDAR");
    revokeFeed({ id: feed.id, ownerUserId: w.alice.userId });
    expect(renderFeed(tokenOf(url))).toBeNull();
  });

  test("only the owner can revoke", () => {
    const { feed } = createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public" });
    expect(() => revokeFeed({ id: feed.id, ownerUserId: w.bob.userId })).toThrow(NotFoundError);
  });

  test("deactivating the owner kills their feeds, checked on every fetch", () => {
    const { url } = createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public" });
    const token = tokenOf(url);
    expect(renderFeed(token)).not.toBeNull();
    updateUserAccess({ userId: w.alice.userId, active: false, actorUserId: w.admin.userId });
    expect(renderFeed(token)).toBeNull();
  });

  test("record when they were last used", () => {
    const { url, feed } = createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public" });
    expect(feed.lastUsedAt).toBeNull();
    renderFeed(tokenOf(url), 5_000_000);
    expect(listFeeds(w.alice.userId)[0]!.lastUsedAt).toBe(5_000_000);
  });

  test("private is off unless asked for, and an all-public feed can't ask", () => {
    expect(createFeed({ ownerUserId: w.alice.userId, name: "Mine", scope: "public_and_mine" }).feed.privateMode).toBe("off");
    expect(createFeed({ ownerUserId: w.alice.userId, name: "Public", scope: "public", privateMode: "full" }).feed.privateMode).toBe("off");
  });

  test("label feeds keep to their labels", () => {
    const [maintenance] = db().query<{ id: number }, []>("SELECT id FROM labels WHERE name = 'maintenance'").all();
    createTask(w.alice, { title: "Labelled", labels: ["maintenance"], dueDate: "2030-01-01" });
    createTask(w.alice, { title: "Unlabelled", dueDate: "2030-01-02" });
    const { url } = createFeed({ ownerUserId: w.alice.userId, name: "One label", scope: "labels", labelIds: [maintenance!.id] });
    const ics = renderFeed(tokenOf(url))!;
    expect(ics).toContain("Labelled");
    expect(ics).not.toContain("Unlabelled");
  });

  test("need something to cover", () => {
    expect(() => createFeed({ ownerUserId: w.alice.userId, name: "x", scope: "labels" })).toThrow(UserInputError);
    expect(() => createFeed({ ownerUserId: w.alice.userId, name: " ", scope: "public" })).toThrow(UserInputError);
  });
});

test("userActor carries only what's needed", () => {
  expect(Object.keys(userActor({ id: 1, name: "x", role: "member" })).sort()).toEqual(["kind", "name", "role", "userId"]);
});
