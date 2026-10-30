import { type Actor, actorId } from "./actors.ts";
import { RateLimitedError } from "./errors.ts";

/**
 * Write rate limits. In memory: this app is one process, and a limit forgotten
 * in a restart is harmless.
 *
 * The key is the actor, never an address. Behind a unix socket a request has no
 * peer address at all, and X-Forwarded-For is whatever the last hop said, so
 * nothing here may depend on `req.ip`. A person, agent or integration has its
 * own bucket. Anonymous devices have one each and share one more, because a
 * device's id is a cookie that a determined client can throw away.
 */

const WINDOW_MS = 60_000;

const PER_MINUTE: Record<Actor["kind"], number> = {
  user: 300,
  agent: 60,
  integration: 120,
  lan_device: 30,
  system: Number.POSITIVE_INFINITY,
  nobody: 0,
};

/** Every anonymous device together. */
const LAN_SHARED_PER_MINUTE = 200;
/** Passkey ceremonies, which by nature have no actor yet. Generous: it's a brake on floods, not a lockout. */
export const CEREMONIES_PER_MINUTE = 300;

interface Bucket {
  start: number;
  count: number;
}

type GlobalWithBuckets = typeof globalThis & { __punchlistRateBuckets__?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  const g = globalThis as GlobalWithBuckets;
  g.__punchlistRateBuckets__ ??= new Map();
  return g.__punchlistRateBuckets__;
}

function hit(key: string, limit: number, now: number): void {
  const map = buckets();
  let bucket = map.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    if (map.size > 10_000) {
      for (const [k, b] of map) if (now - b.start >= WINDOW_MS) map.delete(k);
    }
    bucket = { start: now, count: 0 };
    map.set(key, bucket);
  }
  if (bucket.count >= limit) throw new RateLimitedError(Math.ceil((bucket.start + WINDOW_MS - now) / 1000));
  bucket.count++;
}

/** Count a write against the actor. Throws RateLimitedError when over. */
export function checkWriteRate(actor: Actor, now: number = Date.now()): void {
  if (actor.kind === "system") return;
  if (actor.kind === "lan_device") hit("lan:shared", LAN_SHARED_PER_MINUTE, now);
  hit(actorId(actor), PER_MINUTE[actor.kind], now);
}

/** Count something with no actor against a named shared bucket. */
export function checkSharedRate(key: string, limit: number, now: number = Date.now()): void {
  hit(`shared:${key}`, limit, now);
}

export function resetRateLimitsForTests(): void {
  buckets().clear();
}
