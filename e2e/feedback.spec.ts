import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import sharp from "sharp";

import { e2eEnv } from "../playwright.config.ts";
import { contextWithPasskeys, newAdmin, newMember, offlineCopiesKept, workerReady } from "./helpers.ts";

let admin: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  admin = await newAdmin(browser, e2eEnv, "Report Admin");
  member = await newMember(browser, admin.page, "Report Member");
});

test.afterAll(async () => {
  await admin.context.close();
  await member.context.close();
});

const inbox = async (tab: "notes" | "errors") => {
  await admin.page.goto(tab === "errors" ? "/admin/feedback?tab=errors" : "/admin/feedback");
};

test("a note, with a screenshot, reaches the admins and only them", async () => {
  const { page } = member;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Confusing").click();
  await dialog.getByLabel("What happened?").fill("I couldn't find where to set a due date");
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#36c" } }).png().toBuffer();
  await page.locator('input[type="file"]').setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: png });
  await expect(dialog.getByTestId("feedback-images")).toHaveText("screen.png");
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks. That's gone to the admins.")).toBeVisible();
  await expect(dialog).toBeHidden();

  await inbox("notes");
  const card = admin.page.getByTestId("feedback-note").filter({ hasText: "couldn't find where to set a due date" });
  await expect(card).toContainText("Report Member");
  await expect(card).toContainText("Confusing");
  await expect(card).toContainText("/settings");
  const image = card.getByRole("img", { name: /screenshot/ });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);

  // The nav says there's something to look at, and dealing with it clears it.
  await expect(admin.page.getByRole("link", { name: /^Feedback/ }).getByLabel(/to look at/)).toBeVisible();
  await card.getByLabel("Status").selectOption("done");
  await expect(card).toBeHidden();
  await admin.page.getByRole("switch", { name: "Show finished" }).click({ force: true });
  await expect(admin.page.getByTestId("feedback-note").filter({ hasText: "couldn't find where" })).toBeVisible();

  // A member gets nowhere near it.
  const response = await page.goto("/admin/feedback");
  expect(response?.status()).toBe(403);
  const src = await image.getAttribute("src").catch(() => null);
  if (src) expect((await page.request.get(src)).status()).toBe(404);
});

test("a browser error reports itself, mapped to the source, with no query string", async () => {
  const { page } = member;
  await page.goto("/?q=something-private");
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("The e2e browser error");
    });
  });
  await inbox("errors");
  const card = admin.page.getByTestId("error-group").filter({ hasText: "The e2e browser error" });
  await expect(async () => {
    await admin.page.reload();
    await expect(card).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(card).toContainText("client:window");
  await expect(card).toContainText("Report Member");
  await expect(card).not.toContainText("something-private");
});

test("a failure inside shipped code comes back as source, and the error page takes a note", async () => {
  const { page } = member;
  await page.goto("/");
  // Garbage where the router expects its own encoding: it throws from inside the bundle.
  await page.route("**/activity.data*", (route) => route.fulfill({ status: 200, contentType: "text/x-script", body: "not what the router expects" }));
  await page.goto("/settings");
  await page.getByRole("link", { name: "Activity" }).first().evaluate((link: HTMLElement) => link.click());
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();

  await page.getByLabel(/What were you doing/).fill("I only opened Activity");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thanks. That's gone to the admins.")).toBeVisible();

  await inbox("notes");
  const note = admin.page.getByTestId("feedback-note").filter({ hasText: "I only opened Activity" });
  await expect(note).toContainText(/Errors just before: #\d+/);

  await inbox("errors");
  const card = admin.page.getByTestId("error-group").filter({ hasText: /client:(router|react)/ }).first();
  await expect(card).toBeVisible();
  await card.getByText("Stack", { exact: true }).click();
  const stack = await card.locator("code, pre").first().innerText();
  expect(stack).toMatch(/\.tsx?:\d+:\d+/);
  expect(stack).not.toContain("/assets/");
});

test("an error on the sign-in page is reported by someone with no session, and marked", async ({ browser }) => {
  const { context, page } = await contextWithPasskeys(browser);
  await page.goto("/signin");
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("The e2e signed-out error");
    });
  });
  await inbox("errors");
  const card = admin.page.getByTestId("error-group").filter({ hasText: "The e2e signed-out error" });
  await expect(async () => {
    await admin.page.reload();
    await expect(card).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(card).toContainText("Signed out, unverified");
  await context.close();
});

test("a scanner's 404 isn't an error", async () => {
  await admin.page.request.get("/wp-login.php");
  await inbox("errors");
  await expect(admin.page.getByTestId("error-group").filter({ hasText: "wp-login" })).toHaveCount(0);
});

test("a half-written note outlives the page it was written on", async () => {
  const { page } = member;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await page.getByRole("dialog").getByLabel("What happened?").fill("Half a thought");
  await page.reload();
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByRole("dialog").getByLabel("What happened?")).toHaveValue("Half a thought");
  await page.getByRole("dialog").getByLabel("What happened?").fill("");
});

test("with no connection, a note waits on the device and goes when it's back", async () => {
  const { context, page } = member;
  // The home list is the page that stays up with no connection.
  await page.goto("/");
  await workerReady(page);
  await page.reload();
  await offlineCopiesKept(page);
  await page.getByRole("button", { name: "Send feedback" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What happened?").fill("Sent from a dead spot in the building");
  await context.setOffline(true);
  await dialog.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await context.setOffline(false);

  await inbox("notes");
  const card = admin.page.getByTestId("feedback-note").filter({ hasText: "dead spot" });
  await expect(async () => {
    await admin.page.reload();
    await expect(card).toHaveCount(1, { timeout: 500 });
  }).toPass();
});
