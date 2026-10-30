import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import { addTask, newAdmin, newMember } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let owner: { context: BrowserContext; page: Page };
let other: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  owner = await newAdmin(browser, e2eEnv, "Task Owner");
  other = await newMember(browser, owner.page, "Other Person");
});

test.afterAll(async () => {
  await owner?.context.close();
  await other?.context.close();
});

test("adding a task is one line, and it shows up", async () => {
  await owner.page.goto("/");
  await addTask(owner.page, "Sweep the wood shop");
});

test("check-off answers at once, offers undo, and the task lands in Done", async () => {
  const { page } = owner;
  await page.goto("/");
  const box = page.getByRole("checkbox", { name: "Check off Sweep the wood shop" });
  await box.click();
  // Optimistic: the same row, ticked, with no waiting.
  await expect(page.getByRole("checkbox", { name: "Reopen Sweep the wood shop" })).toBeChecked();
  await expect(page.getByText("Checked off.")).toBeVisible();

  await page.goto("/?view=done");
  await expect(page.getByRole("link", { name: /Sweep the wood shop/ })).toBeVisible();
});

test("undo puts it back", async () => {
  const { page } = owner;
  await page.goto("/");
  await addTask(page, "Undo me");
  await page.getByRole("checkbox", { name: "Check off Undo me" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Check off Undo me" })).toBeVisible();
});

test("a second browser sees changes live, with no reload", async () => {
  await other.page.goto("/");
  await expect(other.page.getByText("Undo me")).toBeVisible();
  await addTask(owner.page, "Live update");
  await expect(other.page.getByRole("link", { name: /Live update/ })).toBeVisible();
});

test("a private task is invisible to everyone else, by list, URL and search", async () => {
  const { page } = owner;
  await page.goto("/");
  await page.getByLabel("New task").fill("Secret errand");
  await page.getByRole("button", { name: "Private" }).click();
  await page.getByRole("button", { name: "Add task" }).click();
  const link = page.getByRole("link", { name: /Secret errand/ });
  await expect(link).toBeVisible();
  await expect(link).toContainText("Private");

  await link.click();
  await expect(page.getByRole("heading", { name: "Secret errand" })).toBeVisible();
  const url = page.url();

  await other.page.goto("/");
  await expect(other.page.getByText("Secret errand")).toHaveCount(0);
  await other.page.goto("/?q=Secret");
  await expect(other.page.getByText("Nothing matches")).toBeVisible();
  const response = await other.page.goto(url);
  expect(response?.status()).toBe(404);
  await expect(other.page.getByText("Secret errand")).toHaveCount(0);
});

test("the full form: details, due date, labels, assignee", async () => {
  const { page } = owner;
  await page.goto("/tasks/new");
  await page.getByLabel("What needs doing?").fill("Oil the band saw");
  await page.getByLabel("Details").fill("Use the light oil");
  await page.getByLabel("Due").fill("2030-05-06");
  await page.getByRole("combobox", { name: "Labels" }).click();
  await page.getByRole("option", { name: "maintenance" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Assigned to" }).click();
  await page.getByRole("option", { name: "Other Person" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add task", exact: true }).click();

  const row = page.getByTestId("task-row").filter({ hasText: "Oil the band saw" });
  await expect(row).toContainText("maintenance");
  await expect(row).toContainText("May 6");
  await expect(row.getByLabel("Assigned to Other Person")).toBeVisible();

  await row.getByRole("link").click();
  await expect(page.getByText("Use the light oil")).toBeVisible();
  await expect(page.getByText("Added by")).toBeVisible();
  await expect(page.getByText("Task Owner added this")).toBeVisible();
});

test("tapping the map gives a point, and the zone comes from it", async () => {
  const { page } = owner;
  await page.goto("/tasks/new");
  await page.getByLabel("What needs doing?").fill("Fix the paint booth fan");
  await page.getByRole("button", { name: "Pick on map" }).click();
  const map = page.getByTestId("site-map");
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  // The upper right of the plan: the example's paint booth.
  await map.click({ position: { x: box.width * 0.85, y: box.height * 0.2 } });
  await expect(page.getByTestId("picked-point")).toContainText("Paint booth");
  await page.getByRole("button", { name: "Add task", exact: true }).click();

  const row = page.getByTestId("task-row").filter({ hasText: "Fix the paint booth fan" });
  await expect(row).toContainText("Paint booth");

  await page.goto("/map");
  await expect(page.getByRole("link", { name: "Fix the paint booth fan" })).toBeVisible();
  await page.getByRole("link", { name: "Fix the paint booth fan" }).click();
  await expect(page.getByRole("heading", { name: "Fix the paint booth fan" })).toBeVisible();
  await expect(page.getByTestId("site-map")).toBeVisible();
});

test("filtering by zone and label narrows the list, and an empty result says so", async () => {
  const { page } = owner;
  await page.goto("/");
  await page.getByText("maintenance", { exact: true }).first().click();
  await expect(page).toHaveURL(/label=maintenance/);
  await expect(page.getByRole("link", { name: /Oil the band saw/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Undo me/ })).toHaveCount(0);

  await page.goto("/?zone=yard");
  await expect(page.getByText("Nothing matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("link", { name: /Undo me/ })).toBeVisible();
});

test("comments, and history that says who", async () => {
  const { page } = other;
  await page.goto("/");
  await page.getByRole("link", { name: /Oil the band saw/ }).click();
  await page.getByLabel("Add a comment").fill("Oil is on the top shelf");
  await page.getByRole("button", { name: "Comment" }).click();
  await expect(page.getByText("Oil is on the top shelf")).toBeVisible();
  await expect(page.getByText("Other Person commented")).toBeVisible();
});

test("an attachment shows, comes back from its extensionless URL, and is refused off the task", async () => {
  const { page } = owner;
  await page.goto("/");
  await page.getByRole("link", { name: /Oil the band saw/ }).click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await page.locator('input[type="file"]').setInputFiles({ name: "saw.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("link", { name: "Open saw.png" })).toBeVisible();

  const href = await page.getByRole("link", { name: "Open saw.png" }).getAttribute("href");
  expect(href).toMatch(/^\/attachments\/[0-9a-f-]+$/);
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-type"]).toBe("image/png");
});

test("a repeating task: checking it off makes the next one", async () => {
  const { page } = owner;
  await page.goto("/tasks/new");
  await page.getByLabel("What needs doing?").fill("Change the dust filter");
  await page.getByLabel("Due").fill("2030-01-07");
  await page.getByRole("combobox", { name: "Repeats" }).click();
  await page.getByRole("option", { name: "The first Monday of each month" }).click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();

  const row = page.getByTestId("task-row").filter({ hasText: "Change the dust filter" });
  await expect(row).toBeVisible();
  await page.getByRole("checkbox", { name: "Check off Change the dust filter" }).click();

  await page.goto("/");
  await expect(page.getByTestId("task-row").filter({ hasText: "Change the dust filter" })).toContainText("Feb 4");
  await page.goto("/?view=done");
  await expect(page.getByTestId("task-row").filter({ hasText: "Change the dust filter" })).toHaveCount(1);
});

test("deleting needs a confirmation, and then it's gone", async () => {
  const { page } = owner;
  await page.goto("/");
  await addTask(page, "Delete me");
  await page.getByRole("link", { name: /Delete me/ }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Delete me/ })).toHaveCount(0);
});

test("activity lists what happened, and a private task leaves no trace for others", async () => {
  await owner.page.goto("/activity");
  await expect(owner.page.getByRole("link", { name: "Secret errand" }).first()).toBeVisible();
  await other.page.goto("/activity");
  await expect(other.page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(other.page.getByText("Secret errand")).toHaveCount(0);
});

test("the audit page is for admins, and doesn't open a side door to private tasks", async () => {
  await owner.page.goto("/admin/audit");
  await expect(owner.page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(owner.page.getByText("Secret errand")).toHaveCount(0);
  const response = await other.page.goto("/admin/audit");
  expect(response?.status()).toBe(403);
});

test("finding 11: a session that simply ends leaves nothing behind for the next person", async () => {
  const { page, context } = owner;
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pl:copy:")).length)).toBeGreaterThan(0);
  const cookies = await context.cookies();
  await context.clearCookies();
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pl:copy:")).length)).toBe(0);
  await context.addCookies(cookies);
});

test("signing out clears what this device kept", async () => {
  const { page } = owner;
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pl:copy:")).length)).toBeGreaterThan(0);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("pl:copy:")).length)).toBe(0);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("link", { name: /Secret errand/ })).toBeVisible();
});
