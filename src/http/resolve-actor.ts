import { type Actor, type LanDeviceActor, NOBODY, userActor } from "../actors.ts";
import { authenticateBearer } from "../agents.ts";
import { trustedPerimeterHeader } from "../config.server.ts";
import { randomToken } from "../crypto.ts";
import { db } from "../db.server.ts";
import { DEVICE_NAME_MAX_LENGTH } from "../limits.ts";
import { type Session, resolveSession } from "../sessions.ts";
import type { User } from "../users.ts";
import { deviceCookie, readCookie, sessionCookie } from "./cookies.ts";

/**
 * Turning a request into an Actor. This is the one place that looks at how a
 * request authenticated, and the order is the security model:
 *
 *   1. An Authorization header means a token, and only a token. A bad token is
 *      nobody, even on the LAN: the on-site tier must never be the consolation
 *      prize for a credential that failed.
 *   2. A valid session cookie is that person.
 *   3. The perimeter header, if the deployment named one, is an anonymous device.
 *   4. Otherwise nobody.
 *
 * Nothing here reads a client address. Over a unix socket there is none, and
 * X-Forwarded-For is only what the last hop claimed.
 */

export const PERIMETER_VALUE = "lan";

/** Whether this request is on site. With no header configured, nothing ever is. */
export function isOnSite(request: Request): boolean {
  const header = trustedPerimeterHeader();
  return header != null && request.headers.get(header) === PERIMETER_VALUE;
}

export interface ResolvedRequest {
  actor: Actor;
  /** How it authenticated: tokens skip the cookie-only CSRF checks. */
  credential: "bearer" | "session" | "perimeter" | "none";
  user: User | null;
  session: Session | null;
  /** The session's expiry just slid: re-send its cookie. */
  sessionRefreshed: boolean;
  sessionToken: string | null;
  /** A brand new on-site device: this cookie value must be set on the response. */
  newDeviceId: string | null;
}

const nobody = (credential: ResolvedRequest["credential"]): ResolvedRequest => ({
  actor: NOBODY,
  credential,
  user: null,
  session: null,
  sessionRefreshed: false,
  sessionToken: null,
  newDeviceId: null,
});

const LAST_SEEN_EVERY_MS = 60 * 60_000;

function loadDevice(id: string, now: number): LanDeviceActor {
  const row = db().query<{ name: string | null; last_seen_at: number }, [string]>("SELECT name, last_seen_at FROM lan_devices WHERE id = ?").get(id);
  if (!row) {
    db().query("INSERT OR IGNORE INTO lan_devices (id, created_at, last_seen_at) VALUES (?, ?, ?)").run(id, now, now);
    return { kind: "lan_device", deviceId: id, deviceName: null };
  }
  if (now - row.last_seen_at >= LAST_SEEN_EVERY_MS) db().query("UPDATE lan_devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  return { kind: "lan_device", deviceId: id, deviceName: row.name };
}

export async function resolveRequest(request: Request, now: number = Date.now()): Promise<ResolvedRequest> {
  const authorization = request.headers.get("Authorization");
  if (authorization != null) {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
    const actor = token ? authenticateBearer(token, now) : null;
    return actor ? { ...nobody("bearer"), actor } : nobody("bearer");
  }

  const sessionToken = await readCookie(sessionCookie, request);
  const resolved = resolveSession(sessionToken, now);
  if (resolved) {
    return {
      actor: userActor(resolved.user),
      credential: "session",
      user: resolved.user,
      session: resolved.session,
      sessionRefreshed: resolved.refreshed,
      sessionToken,
      newDeviceId: null,
    };
  }

  if (isOnSite(request)) {
    const existing = await readCookie(deviceCookie, request);
    const id = existing ?? randomToken(16);
    return { ...nobody("perimeter"), actor: loadDevice(id, now), newDeviceId: existing ? null : id };
  }
  return nobody("none");
}

/** A device naming itself. The name is unverified by construction, and labelled so everywhere. */
export function setDeviceName(actor: LanDeviceActor, name: unknown): LanDeviceActor {
  const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, DEVICE_NAME_MAX_LENGTH) : "";
  db().query("UPDATE lan_devices SET name = ? WHERE id = ?").run(clean || null, actor.deviceId);
  return { ...actor, deviceName: clean || null };
}

/**
 * For a long-lived stream: re-run the check this request passed, synchronously
 * and without the request's cookies being parsed again. Null means the
 * credential has since died (signed out, deactivated, token revoked).
 */
export function reauthenticator(request: Request, resolved: ResolvedRequest): () => Actor | null {
  if (resolved.credential === "bearer") {
    const token = /^Bearer\s+(\S+)$/i.exec((request.headers.get("Authorization") ?? "").trim())?.[1];
    return () => (token ? authenticateBearer(token) : null);
  }
  if (resolved.credential === "session") {
    return () => {
      const session = resolveSession(resolved.sessionToken);
      return session ? userActor(session.user) : null;
    };
  }
  if (resolved.credential === "perimeter") return () => resolved.actor;
  return () => null;
}
