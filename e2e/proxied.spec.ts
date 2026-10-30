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

async function post(headers: Record<string, string>) {
  const res = await fetch(`${proxiedListenUrl}/admin/people.data`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  // React Router answers a .data action with 202 and the outcome (a redirect, or a
  // thrown error) encoded in the body, so that's where to look.
  return { status: res.status, text: await res.text() };
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
  const r = await post({ Origin: "https://evil.test", "X-Forwarded-Host": "evil.test", Host: "evil.test" });
  expect(r.status).toBe(400);
});

test("cookies are Secure when the public address is https", async () => {
  const res = await fetch(`${proxiedListenUrl}/api/passkey/signin-options`, {
    method: "POST",
    headers: { Origin: proxiedEnv.PUBLIC_BASE_URL, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.headers.get("set-cookie")).toContain("Secure");
});
