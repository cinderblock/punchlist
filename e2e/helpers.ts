import { execFileSync } from "node:child_process";

import { type Browser, type BrowserContext, type BrowserContextOptions, type Page, expect } from "@playwright/test";

/** A browser context with a platform authenticator that always says yes. */
export async function contextWithPasskeys(browser: Browser, options: BrowserContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page };
}

/** A one-time admin link, from the CLI, as an operator would get it. */
export function mintAdminLink(env: Record<string, string | undefined>): string {
  const out = execFileSync("bun", ["src/cli/admin-link.ts"], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const url = out.trim().split(/\r?\n/).pop() ?? "";
  expect(url).toMatch(/\/join\/[\w-]+$/);
  return url;
}

/** The app header names whoever is signed in. */
export async function expectSignedInAs(page: Page, name: string) {
  // Attached, not visible: on a phone the name gives way to its initials.
  await expect(page.getByRole("banner").getByText(name)).toBeAttached();
}

/** A new admin, signed in, in their own browser. Works whether or not one exists yet. */
export async function newAdmin(browser: Browser, env: Record<string, string | undefined>, name: string, options: BrowserContextOptions = {}) {
  const person = await contextWithPasskeys(browser, options);
  await person.page.goto(mintAdminLink(env));
  await person.page.getByLabel("Your name").fill(name);
  await person.page.getByRole("button", { name: "Create passkey" }).click();
  await expectSignedInAs(person.page, name);
  return person;
}

/** A new member, invited by this admin. */
export async function newMember(browser: Browser, admin: Page, name: string, options: BrowserContextOptions = {}) {
  await admin.goto("/admin/people");
  await admin.getByLabel("Their name").fill(name);
  await admin.getByRole("button", { name: "Create invite link" }).click();
  const dialog = admin.getByRole("dialog");
  const url = (await dialog.locator("pre, code").first().innerText()).trim();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const person = await contextWithPasskeys(browser, options);
  await person.page.goto(url);
  await expect(person.page.getByLabel("Your name")).toHaveValue(name);
  await person.page.getByRole("button", { name: "Create passkey" }).click();
  await expectSignedInAs(person.page, name);
  return person;
}

/** Wait for the service worker to be in charge, so the app can start with no network. */
export async function workerReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
    }
  });
}

export async function addTask(page: Page, title: string) {
  await page.getByLabel("New task").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
}
