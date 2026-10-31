import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import { addTask, newAdmin } from "./helpers.ts";

/** A phone-sized screen with touch: the app's main home. */
test.describe.configure({ mode: "serial" });

let person: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  person = await newAdmin(browser, e2eEnv, "Phone Person", { viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true });
});

test.afterAll(async () => {
  await person?.context.close();
});

test("the list fits, nothing scrolls sideways, and the check-off is a big target", async () => {
  const { page } = person;
  await page.goto("/");
  await addTask(page, "A job to reach with one thumb, with a title long enough to wrap onto a second line");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const box = await page.getByRole("checkbox", { name: /^Check off/ }).first().boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(48);
  expect(box!.height).toBeGreaterThanOrEqual(48);
});

test("the drawer opens, navigates and closes", async () => {
  const { page } = person;
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Activity" })).not.toBeInViewport();
});

test("a tap checks off", async () => {
  const { page } = person;
  await page.goto("/");
  await page.getByRole("checkbox", { name: /^Check off/ }).first().tap();
  await expect(page.getByText("Checked off.")).toBeVisible();
});

test("focusing a field can't zoom the page: none has text under 16px", async () => {
  const { page } = person;
  for (const path of ["/", "/tasks/new", "/settings", "/settings/notifications"]) {
    await page.goto(path);
    await expect(page.locator("main input:not([type=hidden]), main textarea").first()).toBeVisible();
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select")]
        .map((field) => ({ field: field.getAttribute("aria-label") ?? field.id, size: Number.parseFloat(getComputedStyle(field).fontSize) }))
        .filter((f) => f.size < 16),
    );
    expect(small, path).toEqual([]);
  }
});

// Declared rather than performed: headless Chromium won't pinch-zoom a page, even
// through CDP with touch-action off, and already skips double-tap zoom on a phone-width one.
test("a double tap is off, and nothing stops a pinch", async () => {
  const { page } = person;
  await page.goto("/");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe("manipulation");
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute("content", /maximum-scale|user-scalable/);
});
