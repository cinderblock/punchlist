import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv } from "../playwright.config.ts";
import { contextWithPasskeys, expectSignedInAs, mintAdminLink } from "./helpers.ts";

/**
 * The whole passkey lifecycle, in order, in real Chromium: first-admin setup,
 * sign out, sign in, invite, sign-up, permissions, link reuse, recovery,
 * deactivation.
 */
test.describe.configure({ mode: "serial" });

let admin: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };
let inviteUrl = "";

test.afterAll(async () => {
  await admin?.context.close();
  await member?.context.close();
});

test("signed-out visitors get the sign-in page, which explains setup is pending", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/signin\?next=%2Fsettings$/);
  await expect(page.getByText("No admin exists yet")).toBeVisible();
});

test("the first admin sets up with a one-time link and a passkey", async ({ browser }) => {
  admin = await contextWithPasskeys(browser);
  const { page } = admin;

  await page.goto(mintAdminLink(e2eEnv));
  // The token is moved out of the address bar before anything renders.
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByRole("heading", { name: "Set up the first admin" })).toBeVisible();

  await page.getByLabel("Your name").fill("Robin Sample");
  await page.getByRole("button", { name: "Create passkey" }).click();

  await expectSignedInAs(page, "Robin Sample");
  await expect(page.getByText("All clear")).toBeVisible();
  await expect(page).toHaveTitle("Tasks · Maple Street Workshop");
});

test("the admin can sign out and back in with the passkey", async () => {
  const { page } = admin;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByText("No admin exists yet")).toHaveCount(0);

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expectSignedInAs(page, "Robin Sample");
});

test("sign-in returns to the page that asked for it", async () => {
  const { page } = admin;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/admin/people");
  await expect(page).toHaveURL(/\/signin\?next=%2Fadmin%2Fpeople$/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
});

test("the admin invites someone and sees the link exactly once", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  await expect(page.getByText("First-admin setup")).toHaveCount(0);
  await page.getByLabel("Their name").fill("Pat Example");
  await page.getByRole("button", { name: "Create invite link" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Invite for Pat Example (member)")).toBeVisible();
  inviteUrl = (await dialog.locator("pre, code").first().innerText()).trim();
  expect(inviteUrl).toMatch(/^http:\/\/localhost:\d+\/join\/[\w-]+$/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText("Invite for Pat Example (member)")).toBeVisible();
  await expect(page.getByText(inviteUrl)).toHaveCount(0);
});

test("the invited person signs up on their own device", async ({ browser }) => {
  member = await contextWithPasskeys(browser);
  const { page } = member;
  await page.goto(inviteUrl);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Pat Example");
  await page.getByRole("button", { name: "Create passkey" }).click();

  await expectSignedInAs(page, "Pat Example");
  await expect(page.getByRole("link", { name: "People" })).toHaveCount(0);
});

test("members are refused the admin pages", async () => {
  const { page } = member;
  const response = await page.goto("/admin/people");
  expect(response?.status()).toBe(403);
  await expect(page.getByText("This page is for admins.")).toBeVisible();
});

test("a used invite link can't be used again", async ({ browser }) => {
  const stranger = await contextWithPasskeys(browser);
  await stranger.page.goto(inviteUrl);
  await expect(stranger.page).toHaveURL(/\/join\?invalid=1$/);
  await expect(stranger.page.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await stranger.context.close();
});

test("someone signed in can make an add-a-device link, and it works elsewhere", async ({ browser }) => {
  const { page } = member;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Link for another device" }).click();
  const dialog = page.getByRole("dialog");
  const url = (await dialog.locator("pre, code").first().innerText()).trim();
  await dialog.getByRole("button", { name: "Done" }).click();

  const tablet = await contextWithPasskeys(browser);
  await tablet.page.goto(url);
  await expect(tablet.page.getByRole("heading", { name: "Add this device for Pat Example" })).toBeVisible();
  await tablet.page.getByRole("button", { name: "Create passkey" }).click();
  await expectSignedInAs(tablet.page, "Pat Example");
  await tablet.context.close();
});

test("an admin's recovery link gets someone back in", async ({ browser }) => {
  const { page } = admin;
  await page.goto("/admin/people");
  await page.getByRole("link", { name: "Pat Example" }).click();
  await page.getByRole("button", { name: "Make a recovery link" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Recovery link for Pat Example")).toBeVisible();
  const url = (await dialog.locator("pre, code").first().innerText()).trim();
  await dialog.getByRole("button", { name: "Done" }).click();

  const newPhone = await contextWithPasskeys(browser);
  await newPhone.page.goto(url);
  await newPhone.page.getByRole("button", { name: "Create passkey" }).click();
  await expectSignedInAs(newPhone.page, "Pat Example");
  await newPhone.context.close();
});

test("finding 1: the owner was signed out by that link, and is told who did it at next sign-in", async () => {
  const { page } = member;
  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expectSignedInAs(page, "Pat Example");

  const notice = page.getByTestId("account-notice");
  await expect(notice).toContainText("Robin Sample made a recovery link for your account");
  await expect(notice).toContainText("was used on");
  await page.getByRole("button", { name: "I've read this" }).click();
  await expect(notice).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByTestId("account-history")).toContainText("Robin Sample made a recovery link");
});

test("finding 7: Add a passkey ignores a link left in the browser", async () => {
  const { page, context } = admin;
  // A member's own add-a-device link, opened here and never finished.
  await member.page.goto("/settings");
  await member.page.getByRole("button", { name: "Link for another device" }).click();
  const dialog = member.page.getByRole("dialog");
  const url = (await dialog.locator("pre, code").first().innerText()).trim();
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.goto(url);
  await expect(page.getByText("You're signed in as Robin Sample")).toBeVisible();
  const create = page.getByRole("button", { name: "Create passkey" });
  await expect(create).toBeDisabled();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Add a passkey on this device" }).click();
  await expect(page.getByText("This device already has a passkey", { exact: false })).toBeVisible();
  await expectSignedInAs(page, "Robin Sample");
  expect((await context.cookies()).some((c) => c.name === "pl_session")).toBe(true);

  // And the link page goes ahead only when asked to.
  await page.goto("/join");
  await page.getByLabel(/Sign Robin Sample out here/).check();
  await expect(create).toBeEnabled();
});


test("deactivating someone signs them out immediately", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  await page.getByRole("link", { name: "Pat Example" }).click();
  await page.getByRole("switch", { name: "Can sign in" }).click({ force: true });
  await expect(page.getByText("deactivated", { exact: true })).toBeVisible();

  await member.page.goto("/");
  await expect(member.page).toHaveURL(/\/signin$/);
  await member.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(member.page.getByText("This account has been deactivated")).toBeVisible();
});

test("the only admin cannot deactivate themselves", async () => {
  const { page } = admin;
  await page.goto("/admin/people");
  await page.getByRole("link", { name: "Robin Sample" }).click();
  await page.getByRole("switch", { name: "Can sign in" }).click({ force: true });
  await expect(page.getByText("This is the only active admin")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Can sign in" })).toBeChecked();
});

test("the passkey API refuses cross-origin calls", async ({ request }) => {
  const response = await request.post("/api/passkey/signin-options", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    data: {},
  });
  expect(response.status()).toBe(403);
});
