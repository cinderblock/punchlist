import { createECDH, randomBytes } from "node:crypto";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";

import { e2eEnv, fakePushUrl } from "../playwright.config.ts";
import { newAdmin, newMember } from "./helpers.ts";

/**
 * Web Push through the real `web-push` library, VAPID and encryption included, to
 * a pretend push service (e2e/fake-push-server.ts).
 */
test.describe.configure({ mode: "serial" });

let admin: { context: BrowserContext; page: Page };
let member: { context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }) => {
  admin = await newAdmin(browser, e2eEnv, "Push Admin");
  member = await newMember(browser, admin.page, "Push Member");
});

test.afterAll(async () => {
  await admin?.context.close();
  await member?.context.close();
});

/** What a browser would post, for a device that doesn't exist. */
function fakeSubscription(name: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `${fakePushUrl}/push/${name}`, keys: { p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") } };
}

async function received(page: Page): Promise<{ path: string; headers: Record<string, string> }[]> {
  const response = await page.context().request.get(`${fakePushUrl}/__test/received`, { ignoreHTTPSErrors: true });
  return (await response.json()) as { path: string; headers: Record<string, string> }[];
}

test("the settings page shows the choices, and saves them", async () => {
  const { page } = member;
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("this-device")).toBeVisible();
  await page.getByRole("switch", { name: "Comments on my tasks" }).click({ force: true });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Comments on my tasks" })).not.toBeChecked();
});

test("a test message reaches a subscribed device, encrypted and signed", async () => {
  const { page } = member;
  await page.goto("/settings/notifications");
  const posted = await page.request.post("/settings/notifications", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL },
    form: { intent: "push-subscribe", subscription: JSON.stringify(fakeSubscription("member")) },
  });
  expect(posted.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("push-device")).toHaveCount(1);

  const test = await page.request.post("/settings/notifications", { headers: { Origin: e2eEnv.PUBLIC_BASE_URL }, form: { intent: "push-test" } });
  expect(test.ok()).toBe(true);

  await expect.poll(async () => (await received(page)).filter((m) => m.path === "/push/member").length).toBe(1);
  const [message] = (await received(page)).filter((m) => m.path === "/push/member");
  expect(message!.headers["content-encoding"]).toBe("aes128gcm");
  expect(message!.headers.authorization).toContain("vapid");
});

test("the iPhone guidance appears instead of a button that fails", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    storageState: await member.context.storageState(),
  });
  // Safari outside the home screen app has no PushManager.
  await context.addInitScript(() => {
    delete (window as unknown as { PushManager?: unknown }).PushManager;
  });
  const page = await context.newPage();
  await page.goto("/settings/notifications");
  await expect(page.getByTestId("this-device")).toContainText("Add to Home Screen");
  await expect(page.getByRole("button", { name: "Turn on notifications here" })).toHaveCount(0);
  await context.close();
});

test("an anonymous request can't subscribe", async ({ request }) => {
  const response = await request.post("/settings/notifications", {
    headers: { Origin: e2eEnv.PUBLIC_BASE_URL },
    form: { intent: "push-subscribe", subscription: JSON.stringify(fakeSubscription("anon")) },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toContain("/signin");
});
