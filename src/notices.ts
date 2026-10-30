import { db } from "./db.server.ts";

/**
 * Notices to an account's owner about something done to it: an admin making a
 * recovery link, and that link being used. Admins are trusted, so this can't stop
 * an admin taking over an account. It makes sure the owner finds out.
 *
 * The rows are the history, and nothing removes them. Dismissing only quiets the
 * banner, and a dismissal made on the passkey the link enrolled doesn't count for
 * the owner's other passkeys, so someone using a recovery link can't hide it from
 * the person who still has their old device.
 */

export type NoticeKind = "recovery_link" | "recovery_used";

export interface Notice {
  id: number;
  kind: NoticeKind;
  byName: string;
  detail: string | null;
  at: number;
}

interface NoticeRow {
  id: number;
  kind: NoticeKind;
  by_name: string;
  detail: string | null;
  credential_id: number | null;
  created_at: number;
  acknowledged_at: number | null;
  acknowledged_credential_id: number | null;
}

const toNotice = (r: NoticeRow): Notice => ({ id: r.id, kind: r.kind, byName: r.by_name, detail: r.detail, at: r.created_at });

export function addNotice(args: { userId: number; kind: NoticeKind; byUserId: number | null; byName: string; detail?: string | null; credentialId?: number | null; now?: number }): void {
  db()
    .query("INSERT INTO account_notices (user_id, kind, by_user_id, by_name, detail, credential_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(args.userId, args.kind, args.byUserId, args.byName, args.detail ?? null, args.credentialId ?? null, args.now ?? Date.now());
}

/** What this session should be told. */
export function activeNotices(userId: number, credentialId: number | null): Notice[] {
  return db()
    .query<NoticeRow, [number]>("SELECT * FROM account_notices WHERE user_id = ? ORDER BY id DESC")
    .all(userId)
    .filter((n) => {
      if (n.acknowledged_at == null) return true;
      // Dismissed on the passkey the link added: still news on any other.
      return n.credential_id != null && n.acknowledged_credential_id === n.credential_id && credentialId !== n.credential_id;
    })
    .map(toNotice);
}

/** Everything that has been done to this account. There's no way to delete these. */
export function noticeHistory(userId: number): Notice[] {
  return db().query<NoticeRow, [number]>("SELECT * FROM account_notices WHERE user_id = ? ORDER BY id DESC").all(userId).map(toNotice);
}

export function acknowledgeNotices(args: { userId: number; credentialId: number | null; now?: number }): void {
  db()
    .query("UPDATE account_notices SET acknowledged_at = ?, acknowledged_credential_id = ? WHERE user_id = ?")
    .run(args.now ?? Date.now(), args.credentialId, args.userId);
}

/** Words for a notice. Pure, so a page can show it. */
export function noticeText(n: Pick<Notice, "kind" | "byName" | "detail">, when: string): string {
  return n.kind === "recovery_link"
    ? `${n.byName} made a recovery link for your account on ${when}. It signed you out everywhere. If you didn't ask for this, talk to them or another admin.`
    : `A recovery link from ${n.byName} was used on ${when} to add a passkey to your account${n.detail ? ` (${n.detail})` : ""}. Whoever used it could see your private tasks. If that wasn't you, remove that passkey now.`;
}
