import { type MiddlewareFunction, type RouterContextProvider, createContext, data, redirect } from "react-router";

import type { Actor } from "../src/actors.ts";
import { sessionCookie, deviceCookie } from "../src/http/cookies.ts";
import { type ResolvedRequest, resolveRequest } from "../src/http/resolve-actor.ts";
import { DomainError } from "../src/errors.ts";
import type { Session } from "../src/sessions.ts";
import type { User } from "../src/users.ts";

export { ceremonyCookie, clearCookie, deviceCookie, joinCookie, readCookie, sessionCookie } from "../src/http/cookies.ts";
export { assertSameOrigin, readJson } from "../src/http/guard.ts";

/**
 * HTTP-side auth for the React Router app: the middleware that turns a request
 * into an Actor once, and the guards loaders and actions call.
 */

export const requestContext = createContext<ResolvedRequest | null>(null);

/**
 * Root middleware. Publishes who this is on the router context. When a session
 * has just slid forward, re-send its cookie so the browser's copy slides too,
 * unless the route already set or cleared it (sign-in, sign-out). A device seen
 * on site for the first time gets its cookie.
 */
export const authMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const resolved = await resolveRequest(request);
  context.set(requestContext, resolved);

  const response = await next();
  const cookies: string[] = [];
  if (resolved.sessionRefreshed && resolved.sessionToken) {
    const alreadySet = response.headers.getSetCookie().some((c) => c.startsWith("pl_session="));
    if (!alreadySet) cookies.push(await sessionCookie.serialize(resolved.sessionToken));
  }
  if (resolved.newDeviceId) cookies.push(await deviceCookie.serialize(resolved.newDeviceId));
  if (cookies.length === 0) return response;

  try {
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch {
    // Some responses have immutable headers; re-wrap rather than drop the cookie.
    const copy = new Response(response.body, response);
    for (const cookie of cookies) copy.headers.append("Set-Cookie", cookie);
    return copy;
  }
};

type Ctx = Readonly<RouterContextProvider>;

export function getResolved(context: Ctx): ResolvedRequest {
  const resolved = context.get(requestContext);
  if (!resolved) throw new Error("authMiddleware didn't run");
  return resolved;
}

export function getActor(context: Ctx): Actor {
  return getResolved(context).actor;
}

export interface Auth {
  user: User;
  session: Session;
}

export function getAuth(context: Ctx): Auth | null {
  const { user, session } = getResolved(context);
  return user && session ? { user, session } : null;
}

function toSignIn(request: Request): never {
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(next === "/" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`);
}

/**
 * Someone who may look at the list: a signed-in person, or a browser on site.
 * Anyone else gets the sign-in page and no task data. A bearer token is for the
 * API, so it doesn't count here.
 */
export function requireViewer(context: Ctx, request: Request): Actor {
  const actor = getActor(context);
  if (actor.kind === "user" || actor.kind === "lan_device") return actor;
  toSignIn(request);
}

/** The signed-in person, or a redirect to sign-in that returns here afterwards. */
export function requireUser(context: Ctx, request: Request): Auth {
  const auth = getAuth(context);
  if (auth) return auth;
  toSignIn(request);
}

export function requireAdmin(context: Ctx, request: Request): Auth {
  const auth = requireUser(context, request);
  if (auth.user.role !== "admin") throw data("This page is for admins.", { status: 403 });
  return auth;
}

// ---- for the passkey routes ----------------------------------------------------------

/** Turn a DomainError into its status with its message; let anything else propagate. */
export function userErrorResponse(err: unknown): Response {
  if (err instanceof DomainError) return Response.json({ error: err.message }, { status: err.status });
  throw err;
}

export function isPost(request: Request): void {
  if (request.method !== "POST") {
    throw Response.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "POST" } });
  }
}
