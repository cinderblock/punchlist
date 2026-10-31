import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import { addTask, newAdmin, workerReady } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let person: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  person = await newAdmin(browser, e2eEnv, "Offline Person");
});

test.afterAll(async () => {
  await person?.context.close();
});

test("a check-off made offline sticks, waits, and goes when the connection is back", async () => {
  const { page, context } = person;
  await page.goto("/");
  await addTask(page, "Tick me in the dead zone");
  await workerReady(page);
  await page.reload();

  await context.setOffline(true);
  await page.getByRole("checkbox", { name: "Check off Tick me in the dead zone" }).click();
  await expect(page.getByRole("checkbox", { name: "Reopen Tick me in the dead zone" })).toBeChecked();
  await expect(page.getByTestId("queue-badge")).toContainText("1 waiting to send");

  await context.setOffline(false);
  await expect(page.getByTestId("queue-badge")).toHaveCount(0, { timeout: 25_000 });
  const tasks = await page.request.get("/api/v1/tasks?status=done");
  expect(JSON.stringify(await tasks.json())).toContain("Tick me in the dead zone");
});

test("the queue survives closing the app", async () => {
  const { page, context } = person;
  await page.goto("/");
  await addTask(page, "Survive a reload");
  await workerReady(page);
  await page.reload();

  await context.setOffline(true);
  await page.getByRole("checkbox", { name: "Check off Survive a reload" }).click();
  await expect(page.getByTestId("queue-badge")).toContainText("1 waiting");
  await page.reload(); // served by the worker
  await expect(page.getByTestId("queue-badge")).toContainText("1 waiting");
  await expect(page.getByRole("checkbox", { name: "Reopen Survive a reload" })).toBeChecked();

  await context.setOffline(false);
  await expect(page.getByTestId("queue-badge")).toHaveCount(0, { timeout: 25_000 });
});

test("a retry can't check something off twice: the client's id is the idempotency key", async () => {
  const { page } = person;
  await page.goto("/");
  await addTask(page, "Only once");
  const tasks = (await (await page.request.get("/api/v1/tasks?q=Only%20once")).json()) as { tasks: { id: string }[] };
  const id = tasks.tasks[0]!.id;
  const post = () =>
    page.evaluate(
      (taskId) => fetch(`/api/v1/tasks/${taskId}/complete`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "retry-1" }, body: "{}" }).then((r) => r.status),
      id,
    );
  expect(await post()).toBe(200);
  expect(await post()).toBe(200);
  const events = (await (await page.request.get(`/api/v1/tasks/${id}/events`)).json()) as { events: { type: string }[] };
  expect(events.events.filter((e) => e.type === "completed")).toHaveLength(1);
});

test("signing out with unsent check-offs warns first, and staying keeps them", async () => {
  const { page, context } = person;
  await page.goto("/");
  await addTask(page, "Not sent yet");
  await workerReady(page);
  await page.reload();

  await context.setOffline(true);
  await page.getByRole("checkbox", { name: "Check off Not sent yet" }).click();
  await expect(page.getByTestId("queue-badge")).toContainText("1 waiting");
  let warning = "";
  page.once("dialog", (d) => {
    warning = d.message();
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => warning).toContain("1 check-off hasn't reached the server");
  await expect(page.getByTestId("queue-badge")).toContainText("1 waiting");

  await context.setOffline(false);
  await expect(page.getByTestId("queue-badge")).toHaveCount(0, { timeout: 25_000 });
});

test("the last-read list opens with no connection, and the app shell with it", async () => {
  const { page, context } = person;
  await page.goto("/");
  await addTask(page, "Seen before going offline");
  await workerReady(page);
  await page.reload();
  await expect(page.getByRole("link", { name: /Seen before going offline/ })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("link", { name: /Seen before going offline/ })).toBeVisible();
  await context.setOffline(false);
});

test("/api/r repairs a stuck worker and comes back", async () => {
  const { page } = person;
  await page.goto("/api/r");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Seen before going offline/ })).toBeVisible();
});
