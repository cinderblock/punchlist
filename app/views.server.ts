import { config } from "../src/config.server.ts";
import { listCredentials } from "../src/credentials.ts";
import { listSessions } from "../src/sessions.ts";
import { dateOf, formatDate, formatInstant } from "../src/time.ts";
import { describeUserAgent } from "../src/user-agent.ts";
import type { PasskeyView, SessionView } from "./components/credential-lists.tsx";

const today = (now: number) => dateOf(now, config.timezone);
export const whenText = (instant: number, now = Date.now()) => formatInstant(instant, config.timezone, today(now));

/** A person's passkeys, shaped for display. */
export function passkeyViews(userId: number, now = Date.now()): PasskeyView[] {
  return listCredentials(userId).map((c) => ({
    id: c.id,
    nickname: c.nickname,
    created: formatDate(dateOf(c.createdAt, config.timezone), today(now)),
    lastUsed: c.lastUsedAt ? whenText(c.lastUsedAt, now) : "never",
    synced: c.backedUp,
  }));
}

/** A person's live sessions, shaped for display. */
export function sessionViews(userId: number, currentSessionId: string | null, now = Date.now()): SessionView[] {
  return listSessions(userId, now).map((s) => ({
    id: s.id,
    device: describeUserAgent(s.userAgent),
    passkey: s.credentialNickname,
    lastUsed: whenText(s.lastUsedAt, now),
    current: s.id === currentSessionId,
  }));
}
