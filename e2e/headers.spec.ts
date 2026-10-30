import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { PERIMETER_HEADER, e2eEnv } from "../playwright.config.ts";
import { addTask, newAdmin } from "./helpers.ts";

/** What the wire says, through the real server. */
test.describe.configure({ mode: "serial" });

let person: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  person = await newAdmin(browser, e2eEnv, "Header Person");
  await person.page.goto("/");
  await addTask(person.page, "A task for headers");
});

test.afterAll(async () => {
  await person?.context.close();
});

test("every task-data response is private, no-store", async () => {
  const { page } = person;
  const ask = (path: string) => page.request.get(path);
  for (const path of ["/", "/map.data", "/map", "/activity", "/api/v1/tasks", "/api/v1/labels", "/settings", "/tasks/new"]) {
    const response = await ask(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("private, no-store");
  }
});

test("hashed assets may be cached forever, and the worker never", async ({ request }) => {
  const worker = await request.get("/sw.js");
  expect(worker.headers()["cache-control"]).toBe("no-cache");
  const page = await (await request.get("/signin")).text();
  const asset = /\/assets\/[\w.-]+\.js/.exec(page)?.[0];
  expect(asset).toBeTruthy();
  expect((await request.get(asset!)).headers()["cache-control"]).toContain("immutable");
});

test("with no perimeter header configured, sending one changes nothing", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { [PERIMETER_HEADER]: "lan", "X-Punchlist-Perimeter": "lan", "X-Forwarded-For": "10.0.0.1", "X-Real-IP": "10.0.0.1" },
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  expect(await page.content()).not.toContain("A task for headers");
  expect((await page.request.get("/api/v1/tasks")).status()).toBe(401);
  await expect(page.getByText("turn off iCloud Private Relay", { exact: false })).toHaveCount(0);
  await context.close();
});

test("a signed-out visitor gets the shell and sign-in, and no task data", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/map");
  await expect(page).toHaveURL(/\/signin\?next=%2Fmap$/);
  expect(await page.content()).not.toContain("A task for headers");
  for (const path of ["/map.data", "/activity.data"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(await response.text(), path).not.toContain("A task for headers");
  }
  await context.close();
});

test("a live event stream stays open, and streams, through the real server", async () => {
  const { page } = person;
  await page.goto("/");
  const firstEvent = page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const source = new EventSource("/api/v1/events");
        source.addEventListener("task", (e) => {
          source.close();
          resolve((e as MessageEvent).data as string);
        });
        source.onerror = () => reject(new Error("stream failed"));
        source.onopen = () => {
          void fetch("/api/v1/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Heard on the stream" }) });
        };
      }),
  );
  expect(await firstEvent).toContain('"id"');
});

test("the manifest and health check answer", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect((await manifest.json()).name).toBe("Maple Street Workshop");
  expect((await (await request.get("/healthz")).text()).trim()).toBe("ok");
});

test("logs and pages keep capabilities out of referrers", async ({ request }) => {
  const response = await request.get("/signin");
  expect(response.headers()["referrer-policy"]).toBe("same-origin");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-powered-by"]).toBeUndefined();
});
