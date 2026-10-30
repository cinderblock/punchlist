import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { PERIMETER_HEADER, onsiteEnv } from "../playwright.config.ts";
import { addTask, newAdmin } from "./helpers.ts";

/**
 * A deployment with the on-site tier. The test plays the reverse proxy: a
 * browser "on the LAN" has the header added to every request, and one "from the
 * internet" doesn't.
 */
test.describe.configure({ mode: "serial" });

const lan = { [PERIMETER_HEADER]: "lan" };

async function onSite(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: lan });
  return { context, page: await context.newPage() };
}

let admin: { context: BrowserContext; page: Page };
let visitor: { context: BrowserContext; page: Page };
let secretUrl = "";
let attachment = "";

test.beforeAll(async ({ browser }) => {
  admin = await newAdmin(browser, onsiteEnv, "Site Admin");
  visitor = await onSite(browser);
});

test.afterAll(async () => {
  await admin?.context.close();
  await visitor?.context.close();
});

test("a visitor on site sees the list with no sign-in, and is offered one", async () => {
  await admin.page.goto("/");
  await addTask(admin.page, "Public from the admin");
  await visitor.page.goto("/");
  await expect(visitor.page.getByRole("link", { name: /Public from the admin/ })).toBeVisible();
  await expect(visitor.page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("they can add a task, and it says who: an unverified device", async () => {
  await addTask(visitor.page, "Spotted on site");
  await visitor.page.getByRole("link", { name: /Spotted on site/ }).click();
  await expect(visitor.page.getByText("Workshop device", { exact: true }).first()).toBeVisible();
});

test("a typed name stays labelled unverified", async () => {
  await visitor.page.goto("/");
  await visitor.page.getByLabel("Your name (optional)").fill("Sam");
  await visitor.page.getByRole("button", { name: "Save" }).click();
  await expect(visitor.page.getByText('Workshop device, "Sam" (unverified)')).toBeVisible();
  await addTask(visitor.page, "Named on site");
  await visitor.page.getByRole("link", { name: /Named on site/ }).click();
  await expect(visitor.page.getByText('Workshop device, "Sam" (unverified)').first()).toBeVisible();
});

test("they can check off a public task", async () => {
  await visitor.page.goto("/");
  await visitor.page.getByRole("checkbox", { name: "Check off Public from the admin" }).click();
  await expect(visitor.page.getByRole("checkbox", { name: "Reopen Public from the admin" })).toBeChecked();
  await visitor.page.goto("/?view=done");
  await expect(visitor.page.getByRole("link", { name: /Public from the admin/ })).toBeVisible();
});

test("they can't edit or delete someone else's task, and are told how", async () => {
  await visitor.page.goto("/?view=done");
  await visitor.page.getByRole("link", { name: /Public from the admin/ }).click();
  await expect(visitor.page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(visitor.page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(visitor.page.getByRole("link", { name: "Sign in" }).last()).toBeVisible();
});

test("they can't reach private tasks, however they ask", async () => {
  await admin.page.goto("/");
  await admin.page.getByLabel("New task").fill("Admin's private errand");
  await admin.page.getByRole("button", { name: "Private" }).click();
  await admin.page.getByRole("button", { name: "Add task" }).click();
  await admin.page.getByRole("link", { name: /Admin's private errand/ }).click();
  await expect(admin.page.getByRole("heading", { name: "Admin's private errand" })).toBeVisible();
  secretUrl = admin.page.url();

  await visitor.page.goto("/");
  await expect(visitor.page.getByText("Admin's private errand")).toHaveCount(0);
  expect((await visitor.page.goto(secretUrl))?.status()).toBe(404);
  const list = await visitor.page.request.get("/api/v1/tasks?status=all&q=errand");
  expect(await list.json()).toEqual({ tasks: [] });
  const id = secretUrl.split("/").pop();
  expect((await visitor.page.request.get(`/api/v1/tasks/${id}`)).status()).toBe(404);
});

test("the admin pages and settings aren't for them", async () => {
  await visitor.page.goto("/admin/people");
  await expect(visitor.page).toHaveURL(/\/signin/);
  await visitor.page.goto("/settings/agents");
  await expect(visitor.page).toHaveURL(/\/signin/);
});

test("no enrolment: a passkey still needs a link", async () => {
  const response = await visitor.page.request.post("/api/passkey/register-options", {
    headers: { "Content-Type": "application/json", Origin: onsiteEnv.PUBLIC_BASE_URL },
    data: { name: "Walk-in" },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toContain("Sign in first");
});

test("no agent powers: /mcp wants a token", async () => {
  const response = await visitor.page.request.post("/mcp", { headers: { "Content-Type": "application/json" }, data: {} });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain("Bearer");
});

test("a mutation from another origin is refused, even from a browser on site", async () => {
  const response = await visitor.page.request.post("/api/v1/tasks", {
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    data: { title: "From a malicious page" },
  });
  expect(response.status()).toBe(403);
});

test("a form post is refused: a cross-site page can only send those", async () => {
  const response = await visitor.page.request.post("/api/v1/tasks", {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: onsiteEnv.PUBLIC_BASE_URL },
    data: "title=From+a+form",
  });
  expect(response.status()).toBe(415);
});

test("a wrong header value is no tier at all", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { [PERIMETER_HEADER]: "wan" } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await context.close();
});

test("from the internet, the same deployment gives the sign-in page and no task data", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  expect(await page.content()).not.toContain("Spotted on site");
  await expect(page.getByText("turn off iCloud Private Relay", { exact: false })).toBeVisible();

  for (const path of ["/api/v1/tasks", "/api/v1/events", "/api/v1/labels", "/mcp", "/feeds/nothing.ics", `/attachments/${attachment || "x"}`]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBeGreaterThanOrEqual(400);
    expect(await response.text(), path).not.toContain("Spotted on site");
  }
  await context.close();
});

test("a device cookie carried off site means nothing", async ({ browser }) => {
  const cookies = await visitor.context.cookies();
  expect(cookies.some((c) => c.name === "pl_device")).toBe(true);
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await context.close();
});

test("a signed-in person on site is still that person", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: lan, storageState: await admin.context.storageState() });
  const page = await context.newPage();
  await page.goto(secretUrl);
  await expect(page.getByRole("heading", { name: "Admin's private errand" })).toBeVisible();
  await context.close();
});

test("visitors have no notifications to turn on", async () => {
  await visitor.page.goto("/settings/notifications");
  await expect(visitor.page).toHaveURL(/\/signin/);
});
