import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { setConfigForTests } from "./config.server.ts";
import { handleMcp } from "./mcp.ts";
import { getTask, listTasks, taskHistory } from "./tasks.ts";
import { type World, ORIGIN, agentFor, freshWorld } from "./testing/fixtures.ts";

/** Through the real client, so what's proved is that an MCP client can use this. */
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (input, init) => handleMcp(new Request(input as string, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${token}` } })),
  });
  await client.connect(transport);
  return client;
}

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const text = (r: unknown) => (r as TextResult).content[0]!.text;
const parsed = (r: unknown) => JSON.parse(text(r));

describe("the tools", () => {
  test("list everything the brief asks for", async () => {
    const client = await connect(agentFor(w.alice).token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_tasks", "search_tasks", "get_task", "create_task", "update_task", "complete_task", "reopen_task", "list_labels", "list_zones"]));
    await client.close();
  });

  test("the whole life of a task, shown as the agent", async () => {
    const client = await connect(agentFor(w.alice).token);
    const created = parsed(await client.callTool({ name: "create_task", arguments: { title: "From an agent", labels: ["maintenance"], due_date: "2030-01-01", location: { zoneId: "bay-1" } } }));
    expect(created.task.createdBy).toBe("Helper, for Alice Member");
    const id = created.task.id as string;

    expect(parsed(await client.callTool({ name: "update_task", arguments: { id, title: "Renamed" } })).title).toBe("Renamed");
    expect(parsed(await client.callTool({ name: "search_tasks", arguments: { query: "Renamed" } }))).toHaveLength(1);
    expect(parsed(await client.callTool({ name: "get_task", arguments: { id } })).task.id).toBe(id);
    expect(parsed(await client.callTool({ name: "complete_task", arguments: { id, note: "Done" } })).status).toBe("done");
    expect(parsed(await client.callTool({ name: "reopen_task", arguments: { id } })).status).toBe("open");

    const history = taskHistory(w.alice, id);
    expect(new Set(history.map((e) => e.via))).toEqual(new Set(["mcp"]));
    expect(new Set(history.map((e) => e.actor))).toEqual(new Set(["Helper, for Alice Member"]));
    await client.close();
  });

  test("dedupe_key updates rather than duplicates, and closes by key", async () => {
    const client = await connect(agentFor(w.alice).token);
    await client.callTool({ name: "create_task", arguments: { title: "Sensor offline", dedupe_key: "sensor" } });
    const second = parsed(await client.callTool({ name: "create_task", arguments: { title: "Still offline", dedupe_key: "sensor" } }));
    expect(second.deduped).toBe(true);
    expect(listTasks(w.alice)).toHaveLength(1);
    await client.callTool({ name: "complete_task", arguments: { dedupe_key: "sensor", note: "Back" } });
    expect(listTasks(w.alice)).toHaveLength(0);
    await client.close();
  });

  test("idempotency_key makes a retry safe", async () => {
    const client = await connect(agentFor(w.alice).token);
    const args = { title: "Once", idempotency_key: "retry-me" };
    await client.callTool({ name: "create_task", arguments: args });
    await client.callTool({ name: "create_task", arguments: args });
    expect(listTasks(w.alice)).toHaveLength(1);
    await client.close();
  });

  test("a refusal is an error the model can read, not a crash", async () => {
    const client = await connect(agentFor(w.alice, ["tasks:read"]).token);
    const result = (await client.callTool({ name: "create_task", arguments: { title: "x" } })) as TextResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("can't create");
    await client.close();
  });

  test("there's no delete tool", async () => {
    const client = await connect(agentFor(w.alice).token);
    const { tools } = await client.listTools();
    expect(tools.some((t) => /delete|remove/.test(t.name))).toBe(false);
    await client.close();
  });

  test("reference tools answer", async () => {
    const client = await connect(agentFor(w.alice).token);
    expect(parsed(await client.callTool({ name: "list_labels", arguments: {} })).map((l: { name: string }) => l.name)).toContain("safety");
    expect(parsed(await client.callTool({ name: "list_zones", arguments: {} })).map((z: { id: string }) => z.id)).toContain("yard");
    expect(parsed(await client.callTool({ name: "who_am_i", arguments: {} })).actor).toBe("Helper, for Alice Member");
    await client.close();
  });
});

test("declines the standalone SSE stream", async () => {
  const { token } = agentFor(w.alice);
  const response = await handleMcp(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(405);
});

test("refuses a foreign Origin, even with a good token", async () => {
  const { token } = agentFor(w.alice);
  const response = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" }, body: "{}" }));
  expect(response.status).toBe(403);
});

test("task data isn't cached", async () => {
  const { token } = agentFor(w.alice);
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(getTask).toBeTruthy();
});
