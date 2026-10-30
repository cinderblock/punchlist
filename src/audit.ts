import { db } from "./db.server.ts";

export interface AuditEvent {
  /** Who did it. null for the system itself (startup bootstrap, CLI). */
  actorUserId: number | null;
  entity: string;
  entityId: string | number;
  action: string;
  before?: unknown;
  after?: unknown;
  at?: number;
}

/**
 * Append to the audit log. The table is append-only by convention: nothing in
 * the app may UPDATE or DELETE it.
 *
 * Never pass secrets here — tokens, public keys and cookie values stay out of
 * `before`/`after`. Callers pass the fields a human would want to see.
 */
export function audit(event: AuditEvent): void {
  db()
    .query(
      `INSERT INTO audit_log
         (actor_user_id, at, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.actorUserId,
      event.at ?? Date.now(),
      event.entity,
      String(event.entityId),
      event.action,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
    );
}

export interface AuditRow {
  id: number;
  actor_user_id: number | null;
  at: number;
  entity: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
}

export function auditFor(entity: string, entityId: string | number): AuditRow[] {
  return db()
    .query<AuditRow, [string, string]>(
      `SELECT id, actor_user_id, at, entity, entity_id, action, before_json, after_json
         FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id`,
    )
    .all(entity, String(entityId));
}

export interface AuditListing extends AuditRow {
  actor_name: string | null;
}

/** The newest account and credential events, for the admin audit page. */
export function recentAudit(limit = 200): AuditListing[] {
  return db()
    .query<AuditListing, [number]>(
      `SELECT a.id, a.actor_user_id, a.at, a.entity, a.entity_id, a.action, a.before_json, a.after_json, u.name AS actor_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit);
}
