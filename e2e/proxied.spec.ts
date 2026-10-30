import { request as httpRequest } from "node:http";

import { expect, test } from "@playwright/test";

import { proxiedEnv, proxiedListenUrl } from "../playwright.config.ts";

/**
 * The app behind a reverse proxy that terminates TLS: the browser talks to
 * https://proxied.test, the app sees plain http. React Router refuses a form
 * action whose Origin doesn't match the request's own origin, so without
 * allowedActionOrigins every form would come back 400 in production. No browser
 * is needed to prove it: what matters is which layer answers.
 */

const body = new URLSearchParams({ intent: "invite" }).toString();
const forwarded = { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "proxied.test" };

/** Plain http, because fetch won't let a Host header through: a proxy keeps the public one. */
function raw(path: string, method: string, headers: Record<string, string>, payload?: string): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(proxiedListenUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method, headers: { Host: "proxied.test", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function post(headers: Record<string, string>) {
  // React Router answers a .data action with 202 and the outcome (a redirect, or a
  // thrown error) encoded in the body, so that's where to look.
  return raw("/admin/people.data", "POST", { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(body.length), ...headers }, body);
}

/** The request got past React Router's origin guard: it's our sign-in that answered. */
function reachedTheApp(r: { status: number; text: string }) {
  expect(r.status, r.text).not.toBe(400);
  expect(r.status, r.text).not.toBe(500);
  expect(r.text).toContain("/signin");
}

test("a form action through a TLS-terminating proxy reaches the app", async () => {
  reachedTheApp(await post({ Origin: proxiedEnv.PUBLIC_BASE_URL, ...forwarded }));
});

test("even from a proxy that forwards no headers, the public origin is allowed", async () => {
  reachedTheApp(await post({ Origin: proxiedEnv.PUBLIC_BASE_URL }));
});

test("a foreign origin is still refused, by the framework, before any route runs", async () => {
  const r = await post({ Origin: "https://evil.test", ...forwarded });
  expect(r.status).toBe(400);
  expect(r.text).not.toContain("/signin");
});

test("a spoofed forwarded host doesn't move the origin anything is compared to", async () => {
  const r = await post({ Origin: "https://evil.test", "X-Forwarded-Host": "evil.test" });
  expect(r.status).toBe(400);
});

test("finding 13: any other Host is refused, before anything else answers", async () => {
  for (const path of ["/", "/signin", "/api/v1/tasks", "/sw.js", "/manifest.webmanifest"]) {
    const r = await raw(path, "GET", { Host: "evil.test" });
    expect(r.status, path).toBe(421);
  }
});

test("finding 13: the health check answers on any Host, as a container's own check needs", async () => {
  const r = await raw("/healthz", "GET", { Host: "127.0.0.1:3000" });
  expect(r.status).toBe(200);
  expect(r.text.trim()).toBe("ok");
});

test("cookies are Secure when the public address is https", async () => {
  const r = await raw("/api/passkey/signin-options", "POST", { Origin: proxiedEnv.PUBLIC_BASE_URL, "Content-Type": "application/json", "Content-Length": "2" }, "{}");
  expect(String(r.headers["set-cookie"])).toContain("Secure");
});
