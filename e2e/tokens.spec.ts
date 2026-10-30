import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import { newAdmin } from "./helpers.ts";

/** Agents and feeds, as a person sets them up and as the thing outside uses them. */
test.describe.configure({ mode: "serial" });

let person: { context: BrowserContext; page: Page };
let token = "";
let feedUrl = "";

const bearer = () => ({ Authorization: `Bearer ${token}` });

test.beforeAll(async ({ browser }) => {
  person = await newAdmin(browser, e2eEnv, "Agent Owner");
});

test.afterAll(async () => {
  await person?.context.close();
});

test("the agents page makes a token and gives the one setup command", async () => {
  const { page } = person;
  await page.goto("/settings/agents");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await page.getByLabel("Name").fill("Claude Code");
  await page.getByRole("button", { name: "Create agent" }).click();

  const command = await page.getByTestId("setup-command").innerText();
  expect(command).toContain("claude mcp add --transport http punchlist");
  expect(command).toContain("/mcp");
  expect(command).toContain("skills/punchlist/SKILL.md");
  token = /Bearer (pl_[0-9a-f]{12}_[\w-]{43})/.exec(command)?.[1] ?? "";
  expect(token).not.toBe("");

  await page.reload();
  await expect(page.getByTestId("agent")).toContainText("Claude Code");
  await expect(page.getByTestId("setup-command")).toHaveCount(0);
});

test("the skill it installs is there, with no sign-in", async ({ request }) => {
  const response = await request.get("/skill/SKILL.md");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("name: punchlist");
});

test("the REST API answers to the token, and tasks show as the agent", async ({ request }) => {
  const created = await request.post("/api/v1/tasks", { headers: bearer(), data: { title: "Made by an agent", dueDate: "2030-03-04" } });
  expect(created.status()).toBe(201);
  expect((await created.json()).task.createdBy).toBe("Claude Code, for Agent Owner");

  await person.page.goto("/");
  await person.page.getByRole("link", { name: /Made by an agent/ }).click();
  await expect(person.page.getByText("Claude Code, for Agent Owner added this")).toBeVisible();
  await expect(person.page.getByText("via api")).toBeVisible();
});

test("/mcp answers an MCP client, over real HTTP through the real server", async ({ request }) => {
  const rpc = (method: string, params: unknown) =>
    request.post("/mcp", {
      headers: { ...bearer(), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  expect(init.status()).toBe(200);
  expect((await init.json()).result.instructions).toContain("Claude Code, for Agent Owner");

  const tools = await rpc("tools/list", {});
  expect((await tools.json()).result.tools.map((t: { name: string }) => t.name)).toContain("create_task");

  const call = await rpc("tools/call", { name: "search_tasks", arguments: { query: "Made by an agent" } });
  expect((await call.json()).result.content[0].text).toContain("Made by an agent");
});

test("without a token, /mcp is 401 with WWW-Authenticate", async ({ request }) => {
  const response = await request.post("/mcp", { headers: { "Content-Type": "application/json" }, data: {} });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain("Bearer");
});

test("an integration from the config file has its own token and name", async ({ request }) => {
  const created = await request.post("/api/v1/tasks", {
    headers: { Authorization: `Bearer ${e2eEnv.INTEGRATION_MONITOR_TOKEN}` },
    data: { title: "Compressor offline", dedupeKey: "compressor" },
  });
  expect((await created.json()).task.createdBy).toBe("Shop monitor");

  const again = await request.post("/api/v1/tasks", {
    headers: { Authorization: `Bearer ${e2eEnv.INTEGRATION_MONITOR_TOKEN}` },
    data: { title: "Compressor still offline", dedupeKey: "compressor" },
  });
  expect(again.status()).toBe(200);
  expect((await again.json()).deduped).toBe(true);

  const closed = await request.post("/api/v1/dedupe/compressor/complete", {
    headers: { Authorization: `Bearer ${e2eEnv.INTEGRATION_MONITOR_TOKEN}` },
    data: { note: "Back up" },
  });
  expect((await closed.json()).closed).toBe(true);
});

test("a calendar feed: made once, fetched with no sign-in, all-day events", async ({ request }) => {
  const { page } = person;
  await page.goto("/");
  await page.goto("/settings/calendar");
  await page.getByLabel("Name").fill("Work calendar");
  await page.getByRole("button", { name: "Create feed" }).click();
  feedUrl = (await page.getByTestId("feed-url").innerText()).trim();
  expect(feedUrl).toMatch(/\/feeds\/[\w-]{43}\.ics$/);

  const response = await request.get(feedUrl);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/calendar");
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const ics = await response.text();
  expect(ics).toContain("BEGIN:VEVENT");
  expect(ics).toContain("DTSTART;VALUE=DATE:20300304");
  expect(ics).toContain("Made by an agent");
  expect(ics).not.toContain("VTODO");
});

test("revoking the feed kills its URL", async ({ request }) => {
  const { page } = person;
  await page.reload();
  await page.getByTestId("feed").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("feed")).toHaveCount(0);
  expect((await request.get(feedUrl)).status()).toBe(404);
});

test("revoking the agent stops its token at once", async ({ request }) => {
  const { page } = person;
  await page.goto("/settings/agents");
  await page.getByTestId("agent").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("agent")).toHaveCount(0);
  expect((await request.get("/api/v1/tasks", { headers: bearer() })).status()).toBe(401);
  expect((await request.post("/mcp", { headers: bearer(), data: {} })).status()).toBe(401);
});
