import { createCookie } from "react-router";

import { config } from "../config.server.ts";
import { SESSION_TTL_MS } from "../sessions.ts";
import { CEREMONY_TTL_MS } from "../webauthn.ts";

/**
 * The app's cookies. `Secure` cookies over plain http only work on localhost in
 * some browsers, so follow the scheme the app is actually served on.
 */
const secure = new URL(config.publicBaseUrl).protocol === "https:";

const base = {
  httpOnly: true,
  secure,
  sameSite: "lax" as const,
  path: "/",
  secrets: [config.sessionSecret],
};

export const sessionCookie = createCookie("pl_session", { ...base, maxAge: Math.floor(SESSION_TTL_MS / 1000) });

/** Names the in-flight WebAuthn ceremony between its options and verify calls. */
export const ceremonyCookie = createCookie("pl_ceremony", { ...base, maxAge: Math.floor(CEREMONY_TTL_MS / 1000) });

/**
 * Holds a one-time link's token after /join/:token is opened, so the token
 * leaves the address bar and history. Long enough to read the page and find the
 * phone's passkey prompt; the link itself enforces the real expiry.
 */
export const joinCookie = createCookie("pl_join", { ...base, maxAge: 30 * 60 });

/**
 * An anonymous on-site browser's identity. It means nothing unless the request
 * is also on the perimeter, so a device carried off site has no standing.
 */
export const deviceCookie = createCookie("pl_device", { ...base, maxAge: 365 * 24 * 60 * 60 });

export async function readCookie(cookie: typeof sessionCookie, request: Request): Promise<string | null> {
  const value: unknown = await cookie.parse(request.headers.get("Cookie"));
  return typeof value === "string" && value ? value : null;
}

export function clearCookie(cookie: typeof sessionCookie): Promise<string> {
  return cookie.serialize("", { maxAge: 0 });
}
