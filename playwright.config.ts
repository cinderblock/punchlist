import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";
import webpush from "web-push";

/**
 * End-to-end tests against the real production build, driven through Chromium
 * with a CDP virtual authenticator standing in for Face ID.
 *
 * Three copies of the app run, each with a fresh database:
 *   - standalone, no on-site tier: the default install, and most of the tests
 *   - on-site: TRUSTED_PERIMETER_HEADER set, with tests playing the reverse proxy
 *   - proxied: believes it's https://proxied.test, as behind a TLS-terminating proxy
 *
 * Paths are fixed in the environment once, by the main process, so worker
 * processes (which re-evaluate this file and inherit the environment) agree with
 * the servers about where they are: the tests use them to mint admin links
 * through `bun run admin-link`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3240);
const ONSITE_PORT = PORT + 1;
const PROXIED_PORT = PORT + 2;
const PUSH_PORT = PORT + 3;

const stamp = `${process.pid}-${Date.now()}`;
const scratch = (name: string) => join(tmpdir(), `punchlist-e2e-${name}-${stamp}`);
process.env.E2E_DATABASE_PATH ??= `${scratch("main")}.db`;
process.env.E2E_ONSITE_DATABASE_PATH ??= `${scratch("onsite")}.db`;
process.env.E2E_PROXIED_DATABASE_PATH ??= `${scratch("proxied")}.db`;
// Made once in the main process, like the paths above, so every process agrees.
if (!process.env.E2E_VAPID_PRIVATE_KEY) process.env.E2E_VAPID_PRIVATE_KEY = webpush.generateVAPIDKeys().privateKey;

const common = {
  SESSION_SECRET: "e2e-only-session-secret",
  TZ: "America/Los_Angeles",
  CONFIG_FILE: "examples/punchlist.yaml",
  INTEGRATION_MONITOR_TOKEN: "e2e-monitor-token-of-a-sensible-length",
};

export const e2eEnv = {
  ...common,
  PORT: String(PORT),
  PUBLIC_BASE_URL: `http://localhost:${PORT}`,
  DATABASE_PATH: process.env.E2E_DATABASE_PATH,
  // The private key alone, as a deployment gives it: the public key is derived.
  VAPID_PRIVATE_KEY: process.env.E2E_VAPID_PRIVATE_KEY,
  // The site address is http here, which push services won't take as a contact.
  VAPID_SUBJECT: "mailto:push-e2e@example.invalid",
  // Tests send on demand; no reminders behind their backs.
  NOTIFY_EVERY_SECONDS: "0",
  // The pretend push service's certificate is self-signed.
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
};

export const PERIMETER_HEADER = "X-Test-Perimeter";

export const onsiteEnv = {
  ...common,
  PORT: String(ONSITE_PORT),
  PUBLIC_BASE_URL: `http://localhost:${ONSITE_PORT}`,
  DATABASE_PATH: process.env.E2E_ONSITE_DATABASE_PATH,
  TRUSTED_PERIMETER_HEADER: PERIMETER_HEADER,
};

export const proxiedListenUrl = `http://localhost:${PROXIED_PORT}`;
export const proxiedEnv = {
  ...common,
  PORT: String(PROXIED_PORT),
  PUBLIC_BASE_URL: "https://proxied.test",
  DATABASE_PATH: process.env.E2E_PROXIED_DATABASE_PATH,
};

export const fakePushUrl = `https://127.0.0.1:${PUSH_PORT}`;

const app = (env: Record<string, string | undefined>, listenUrl = env.PUBLIC_BASE_URL) => ({
  command: "bun run start",
  url: `${listenUrl}/healthz`,
  env: env as Record<string, string>,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: "pipe" as const,
});

export default defineConfig({
  testDir: "./e2e",
  // The flows share one database per app and build on each other's state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      testIgnore: /(onsite|proxied|phone).spec.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: e2eEnv.PUBLIC_BASE_URL },
    },
    {
      name: "phone",
      testMatch: /phone\.spec\.ts/,
      use: { ...devices["Pixel 7"], baseURL: e2eEnv.PUBLIC_BASE_URL },
    },
    {
      name: "onsite",
      testMatch: /onsite\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: onsiteEnv.PUBLIC_BASE_URL },
    },
    {
      // Plain requests, no browser: the point is which layer answers.
      name: "proxied",
      testMatch: /proxied\.spec\.ts/,
    },
  ],
  webServer: [
    app(e2eEnv),
    app(onsiteEnv),
    app(proxiedEnv, proxiedListenUrl),
    {
      command: "bun e2e/fake-push-server.ts",
      url: `${fakePushUrl}/__test/received`,
      ignoreHTTPSErrors: true,
      env: { PORT: String(PUSH_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
