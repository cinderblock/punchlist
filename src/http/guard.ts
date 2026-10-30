import { ZodError } from "zod";

import { config } from "../config.server.ts";
import { DomainError, RateLimitedError } from "../errors.ts";

/** Sent on everything that carries task data, and the default for the rest (app/auth.server.ts). */
export const NO_STORE = "private, no-store";

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { "Cache-Control": NO_STORE, ...init.headers } });
}

/**
 * Refuse a state-changing request that didn't come from our own pages. A token
 * is not ambient, so bearer requests don't need this. A cookie is, and so is a
 * network position: a malicious page in a LAN browser would otherwise inherit
 * the on-site tier.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(config.publicBaseUrl).origin) {
    throw Response.json({ error: "Cross-origin request refused." }, { status: 403 });
  }
}

/** A cross-site form can't send this type without a CORS preflight, which it won't pass. */
export function assertJsonBody(request: Request): void {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    throw Response.json({ error: "Send JSON." }, { status: 415 });
  }
}

/** Parse a JSON object, answering 400 instead of throwing a 500 on garbage. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : {};
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw Response.json({ error: "Malformed request." }, { status: 400 });
}

/** A DomainError or zod failure as its response; anything else is a real bug and rethrows. */
export function errorResponse(err: unknown): Response {
  if (err instanceof Response) return err;
  if (err instanceof RateLimitedError) {
    return json({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } });
  }
  if (err instanceof DomainError) {
    const headers: Record<string, string> = err.status === 401 ? { "WWW-Authenticate": 'Bearer realm="punchlist"' } : {};
    return json({ error: err.message }, { status: err.status, headers });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.join(".");
    return json({ error: first ? (where ? `${where}: ${first.message}` : first.message) : "Invalid request." }, { status: 400 });
  }
  throw err;
}
