import { type Actor, SYSTEM, actorId, actorLabel, defaultVia, onBehalfOf, personOf } from "./actors.ts";
import { config, site } from "./config.server.ts";
import { db } from "./db.server.ts";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UserInputError } from "./errors.ts";
import { pointInPolygon, boundsOf, roundCoordinate } from "./geometry.ts";
import { TASK_LIST_DEFAULT_LIMIT, ATTACHMENTS_MAX_PER_TASK } from "./limits.ts";
import { publish } from "./live.ts";
import { requestNotifierPass } from "./notifications/kick.ts";
import {
  type TaskAccess,
  type TaskPermissions,
  canAssign,
  canAttach,
  canComment,
  canComplete,
  canCreate,
  canDedupe,
  canDelete,
  canEdit,
  canMakePrivate,
  canManageAccess,
  canManageLabels,
  canRead,
  canReadAnything,
  canSetRecurrence,
  taskPermissions,
  visibleClause,
} from "./permissions.ts";
import { checkWriteRate } from "./rate-limit.ts";
import {
  type RecurrenceSpec,
  describeRecurrence,
  firstScheduled,
  nextDueDate,
  parseRrule,
  validateSchedule,
} from "./recurrence.ts";
import {
  type CompleteInput,
  type ListFilter,
  type LocationInput,
  type RecurrenceInput,
  type TaskCreateInput,
  type TaskUpdateInput,
  commentSchema,
  completeSchema,
  listFilterSchema,
  taskCreateSchema,
  taskUpdateSchema,
} from "./task-schema.ts";
import { addDays, dateOf } from "./time.ts";
import { listPeople } from "./users.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * The domain layer. UI, REST and MCP all call this module, and none of them
 * has another way to reach the data: this is where permissions are enforced and
 * where every change writes its event, in the same transaction as the change.
 *
 * Reads are filtered by `visibleClause`, so a row the actor can't see simply
 * isn't there. A task the actor can't see answers NotFoundError, never
 * ForbiddenError, so its existence doesn't leak.
 */

// ---- context ---------------------------------------------------------------------

export interface WriteContext {
  /** The channel: "ui", "api", "mcp". Defaults from the actor. */
  via?: string;
  /** The client's id for this mutation. A retry returns the first answer. */
  idempotencyKey?: string | null;
  now?: number;
}

function requireReader(actor: Actor): void {
  if (actor.kind === "nobody") throw new UnauthorizedError();
  if (!canReadAnything(actor)) throw new ForbiddenError("This token can't read tasks.");
}

/** What a transaction leaves to do once it has committed. */
interface Pending {
  publish: { taskId: string; resync: boolean }[];
}

/**
 * Run one write: check the rate limit, open a transaction, replay the first
 * answer if this idempotency key has been seen, and after commit tell the live
 * bus and the notifier. Everything that changes a task goes through here.
 */
function write<T>(actor: Actor, ctx: WriteContext, fn: (pending: Pending, now: number) => T): T {
  if (actor.kind === "nobody") throw new UnauthorizedError();
  const key = ctx.idempotencyKey?.slice(0, 200) || null;
  const id = actorId(actor);
  if (key) {
    const seen = replay<T>(id, key);
    if (seen !== undefined) return seen;
  }
  checkWriteRate(actor, ctx.now);
  const pending: Pending = { publish: [] };
  const now = ctx.now ?? Date.now();
  const database = db();
  const result = database.transaction(() => {
    if (key) {
      // Again inside the transaction: two tabs retrying at the same moment.
      const seen = replay<T>(id, key);
      if (seen !== undefined) return seen;
    }
    const value = fn(pending, now);
    if (key) {
      database.query("INSERT INTO idempotency (actor_id, key, response, created_at) VALUES (?, ?, ?, ?)").run(id, key, JSON.stringify(value ?? null), now);
    }
    return value;
  })();
  for (const event of pending.publish) publish(event);
  if (pending.publish.length > 0) requestNotifierPass();
  return result;
}

function replay<T>(actorKey: string, key: string): T | undefined {
  const row = db().query<{ response: string }, [string, string]>("SELECT response FROM idempotency WHERE actor_id = ? AND key = ?").get(actorKey, key);
  return row ? (JSON.parse(row.response) as T) : undefined;
}

/** Forget idempotency keys old enough that no queue is still retrying them. */
export function pruneIdempotency(now: number = Date.now()): void {
  db().query("DELETE FROM idempotency WHERE created_at < ?").run(now - 45 * 86_400_000);
}

export type EventType =
  | "created"
  | "updated"
  | "completed"
  | "reopened"
  | "deleted"
  | "commented"
  | "attached"
  | "detached"
  | "deduped"
  | "superseded";

/** Append to the task's history. Called only inside a write's transaction. */
function recordEvent(args: { taskId: string; actor: Actor; via: string; type: EventType; payload?: unknown; now: number; pending: Pending; resync?: boolean }): void {
  db()
    .query("INSERT INTO task_events (task_id, at, actor_id, actor_label, on_behalf_of, via, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(args.taskId, args.now, actorId(args.actor), actorLabel(args.actor), onBehalfOf(args.actor), args.via, args.type, JSON.stringify(args.payload ?? {}));
  args.pending.publish.push({ taskId: args.taskId, resync: args.resync ?? false });
}

// ---- reading ---------------------------------------------------------------------

interface TaskRow {
  id: string;
  title: string;
  details: string;
  visibility: "public" | "private";
  owner_user_id: number | null;
  created_by: string;
  created_by_label: string;
  due_date: string | null;
  map_id: string | null;
  x: number | null;
  y: number | null;
  zone_id: string | null;
  location_note: string | null;
  recurrence_id: string | null;
  dedupe_scope: string | null;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  completed_by: string | null;
  completed_by_label: string | null;
  deleted_at: number | null;
  rev: number;
  // from the aggregates in SELECT_TASK
  label_json: string;
  assignee_json: string;
  share_json: string;
  attachment_count: number;
  comment_count: number;
  r_kind: "schedule" | "after_completion" | null;
  r_rrule: string | null;
  r_anchor_date: string | null;
  r_interval_days: number | null;
  r_stopped_at: number | null;
}

const SELECT_TASK = `
  SELECT t.*,
    (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
       FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id) AS label_json,
    (SELECT json_group_array(json_object('id', u.id, 'name', u.name))
       FROM task_assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id = t.id) AS assignee_json,
    (SELECT json_group_array(json_object('id', u.id, 'name', u.name))
       FROM task_shares s JOIN users u ON u.id = s.user_id WHERE s.task_id = t.id) AS share_json,
    (SELECT COUNT(*) FROM attachments f WHERE f.task_id = t.id AND f.deleted_at IS NULL) AS attachment_count,
    (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
    r.kind AS r_kind, r.rrule AS r_rrule, r.anchor_date AS r_anchor_date,
    r.interval_days AS r_interval_days, r.stopped_at AS r_stopped_at
  FROM tasks t LEFT JOIN recurrences r ON r.id = t.recurrence_id`;

export interface TaskLocation {
  mapId: string | null;
  mapName: string | null;
  x: number | null;
  y: number | null;
  zoneId: string | null;
  zoneName: string | null;
  note: string | null;
}

export interface TaskView {
  id: string;
  title: string;
  details: string;
  visibility: "public" | "private";
  status: "open" | "done";
  dueDate: string | null;
  location: TaskLocation | null;
  labels: { id: number; name: string; color: string | null }[];
  assignees: { id: number; name: string }[];
  /** Only filled in for an actor who manages this task's access. */
  sharedWith: { id: number; name: string }[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  completedBy: string | null;
  recurrence: { kind: "schedule" | "after_completion"; rrule: string | null; intervalDays: number | null; text: string } | null;
  attachmentCount: number;
  commentCount: number;
  dedupeKey: string | null;
  rev: number;
  /** What this actor may do. Not a grant: the domain checks again on every write. */
  can: TaskPermissions;
}

function accessOf(row: TaskRow): TaskAccess {
  return {
    visibility: row.visibility,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
    assigneeIds: (JSON.parse(row.assignee_json) as { id: number }[]).map((a) => a.id),
    shareIds: (JSON.parse(row.share_json) as { id: number }[]).map((a) => a.id),
  };
}

function specOf(row: TaskRow): RecurrenceSpec | null {
  if (row.r_kind === "schedule" && row.r_rrule && row.r_anchor_date) return { kind: "schedule", rrule: row.r_rrule, anchorDate: row.r_anchor_date };
  if (row.r_kind === "after_completion" && row.r_interval_days) return { kind: "after_completion", intervalDays: row.r_interval_days };
  return null;
}

function zoneName(zoneId: string | null): string | null {
  if (!zoneId) return null;
  return allZones().find((z) => z.id === zoneId)?.name ?? zoneId;
}

function toView(actor: Actor, row: TaskRow): TaskView {
  const access = accessOf(row);
  const can = taskPermissions(actor, access);
  const spec = row.r_stopped_at == null ? specOf(row) : null;
  const hasLocation = row.map_id != null || row.zone_id != null || row.location_note != null || row.x != null;
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    visibility: row.visibility,
    status: row.completed_at == null ? "open" : "done",
    dueDate: row.due_date,
    location: hasLocation
      ? {
          mapId: row.map_id,
          mapName: site().maps.find((m) => m.id === row.map_id)?.name ?? null,
          x: row.x,
          y: row.y,
          zoneId: row.zone_id,
          zoneName: zoneName(row.zone_id),
          note: row.location_note,
        }
      : null,
    labels: JSON.parse(row.label_json) as TaskView["labels"],
    assignees: JSON.parse(row.assignee_json) as TaskView["assignees"],
    sharedWith: can.manageAccess ? (JSON.parse(row.share_json) as TaskView["sharedWith"]) : [],
    createdBy: row.created_by_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by_label,
    recurrence: spec
      ? { kind: spec.kind, rrule: spec.kind === "schedule" ? spec.rrule : null, intervalDays: spec.kind === "after_completion" ? spec.intervalDays : null, text: describeRecurrence(spec) }
      : null,
    attachmentCount: row.attachment_count,
    commentCount: row.comment_count,
    dedupeKey: row.dedupe_key,
    rev: row.rev,
    can,
  };
}

function findRow(id: string): TaskRow | null {
  return db().query<TaskRow, [string]>(`${SELECT_TASK} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
}

/** The row, or NotFoundError if it isn't there *for this actor*. */
function readableRow(actor: Actor, id: string): TaskRow {
  requireReader(actor);
  const row = findRow(id);
  if (!row || !canRead(actor, accessOf(row))) throw new NotFoundError();
  return row;
}

export function getTask(actor: Actor, id: string): TaskView {
  return toView(actor, readableRow(actor, id));
}

/** Whether this actor may know about this task right now. Used by live updates. */
export function canSeeTask(actor: Actor, id: string): boolean {
  if (!canReadAnything(actor)) return false;
  const row = findRow(id);
  return row != null && canRead(actor, accessOf(row));
}

export function listTasks(actor: Actor, filter: ListFilter = {}): TaskView[] {
  requireReader(actor);
  const f = listFilterSchema.parse(filter);
  const visible = visibleClause(actor);
  const where: string[] = ["t.deleted_at IS NULL", visible.sql];
  const params: (string | number)[] = [...visible.params];

  if (f.status === "open") where.push("t.completed_at IS NULL");
  if (f.status === "done") where.push("t.completed_at IS NOT NULL");
  if (f.q) {
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.details LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (f.label !== undefined) {
    where.push("EXISTS (SELECT 1 FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id AND (l.id = ? OR l.name = ? COLLATE NOCASE))");
    params.push(typeof f.label === "number" ? f.label : -1, String(f.label));
  }
  if (f.zone) {
    where.push("t.zone_id = ?");
    params.push(f.zone);
  }
  if (f.assignee !== undefined) {
    where.push("EXISTS (SELECT 1 FROM task_assignees a2 WHERE a2.task_id = t.id AND a2.user_id = ?)");
    params.push(f.assignee);
  }
  if (f.unassigned) where.push("NOT EXISTS (SELECT 1 FROM task_assignees a3 WHERE a3.task_id = t.id)");
  if (f.visibility) {
    where.push("t.visibility = ?");
    params.push(f.visibility);
  }
  if (f.dueBy) {
    where.push("t.due_date IS NOT NULL AND t.due_date <= ?");
    params.push(f.dueBy);
  }

  const order = f.status === "done" ? "t.completed_at DESC" : "t.due_date IS NULL, t.due_date, t.created_at DESC";
  const rows = db()
    .query<TaskRow, (string | number)[]>(`${SELECT_TASK} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...params, f.limit ?? TASK_LIST_DEFAULT_LIMIT);
  return rows.map((row) => toView(actor, row));
}

export interface EventView {
  id: number;
  at: number;
  actor: string;
  via: string;
  type: string;
  payload: Record<string, unknown>;
}

export function taskHistory(actor: Actor, id: string): EventView[] {
  const seesShares = canManageAccess(actor, accessOf(readableRow(actor, id)));
  return db()
    .query<{ id: number; at: number; actor_label: string; via: string; type: string; payload: string }, [string]>(
      "SELECT id, at, actor_label, via, type, payload FROM task_events WHERE task_id = ? ORDER BY id",
    )
    .all(id)
    .map((e) => ({ id: e.id, at: e.at, actor: e.actor_label, via: e.via, type: e.type, payload: visiblePayload(e.payload, seesShares) }));
}

/** An event's payload, without who a task is shared with unless the reader manages that. */
function visiblePayload(raw: string, seesShares: boolean): Record<string, unknown> {
  const payload = JSON.parse(raw) as { changes?: Record<string, unknown> };
  if (!seesShares && payload.changes) delete payload.changes.sharedWith;
  return payload;
}

export interface ActivityView extends EventView {
  taskId: string;
  taskTitle: string;
}

/** The newest changes across every task this actor can see. */
export function activity(actor: Actor, limit = 100): ActivityView[] {
  requireReader(actor);
  const visible = visibleClause(actor);
  return db()
    .query<{ id: number; at: number; actor_label: string; via: string; type: string; payload: string; task_id: string; title: string }, (string | number)[]>(
      `SELECT e.id, e.at, e.actor_label, e.via, e.type, e.payload, e.task_id, t.title
         FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE t.deleted_at IS NULL AND ${visible.sql}
        ORDER BY e.id DESC LIMIT ?`,
    )
    .all(...visible.params, limit)
    .map((e) => ({
      id: e.id,
      at: e.at,
      actor: e.actor_label,
      via: e.via,
      type: e.type,
      payload: visiblePayload(e.payload, false),
      taskId: e.task_id,
      taskTitle: e.title,
    }));
}

export interface CommentView {
  id: string;
  body: string;
  actor: string;
  at: number;
}

export function listComments(actor: Actor, taskId: string): CommentView[] {
  readableRow(actor, taskId);
  return db()
    .query<{ id: string; body: string; actor_label: string; created_at: number }, [string]>(
      "SELECT id, body, actor_label, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at, id",
    )
    .all(taskId)
    .map((c) => ({ id: c.id, body: c.body, actor: c.actor_label, at: c.created_at }));
}

// ---- reference data ------------------------------------------------------------------

export interface LabelView {
  id: number;
  name: string;
  color: string | null;
}

interface LabelRow {
  id: number;
  name: string;
  color: string | null;
  created_at: number;
  archived_at: number | null;
}

export function listLabels(actor: Actor): LabelView[] {
  requireReader(actor);
  return db()
    .query<LabelView, []>("SELECT id, name, color FROM labels WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE")
    .all();
}

export interface ZoneView {
  id: string;
  name: string;
  mapId: string | null;
}

function allZones(): ZoneView[] {
  const s = site();
  return [
    ...s.zones.map((z) => ({ id: z.id, name: z.name, mapId: null })),
    ...s.maps.flatMap((m) => m.zones.map((z) => ({ id: z.id, name: z.name, mapId: m.id }))),
  ];
}

export function listZones(actor: Actor): ZoneView[] {
  requireReader(actor);
  return allZones();
}

/** Who can be assigned or shared with. Names only. */
export function listAssignable(actor: Actor): { id: number; name: string }[] {
  requireReader(actor);
  if (actor.kind === "lan_device") return [];
  return listPeople();
}

/** Copy the labels the config file seeds, once each. Admin edits win afterwards. */
export function seedLabels(now: number = Date.now()): void {
  const insert = db().query("INSERT OR IGNORE INTO labels (name, color, created_at) VALUES (?, ?, ?)");
  const seeded = db().query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'labels_seeded'").get();
  const done = new Set<string>(seeded ? (JSON.parse(seeded.value) as string[]) : []);
  for (const label of site().labels) {
    const key = label.name.toLowerCase();
    if (done.has(key)) continue;
    insert.run(label.name, label.color ?? null, now);
    done.add(key);
  }
  db().query("INSERT INTO kv (key, value) VALUES ('labels_seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...done]));
}

export function createLabel(actor: Actor, input: { name: string; color?: string | null }): LabelView {
  assertLabelAdmin(actor);
  const name = input.name?.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) throw new UserInputError("Label names are 1 to 40 characters.");
  const existing = db().query<LabelRow, [string]>("SELECT * FROM labels WHERE name = ? COLLATE NOCASE").get(name);
  if (existing && existing.archived_at == null) throw new UserInputError(`There's already a label called ${existing.name}.`);
  if (existing) {
    db().query("UPDATE labels SET archived_at = NULL, color = COALESCE(?, color) WHERE id = ?").run(cleanColor(input.color), existing.id);
    return { id: existing.id, name: existing.name, color: cleanColor(input.color) ?? existing.color };
  }
  return db()
    .query<LabelView, [string, string | null, number]>("INSERT INTO labels (name, color, created_at) VALUES (?, ?, ?) RETURNING id, name, color")
    .get(name, cleanColor(input.color), Date.now())!;
}

export function updateLabel(actor: Actor, id: number, input: { name?: string; color?: string | null }): void {
  assertLabelAdmin(actor);
  const name = input.name?.trim().replace(/\s+/g, " ");
  if (input.name !== undefined && (!name || name.length > 40)) throw new UserInputError("Label names are 1 to 40 characters.");
  try {
    db().query("UPDATE labels SET name = COALESCE(?, name), color = ? WHERE id = ?").run(name ?? null, cleanColor(input.color), id);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) throw new UserInputError(`There's already a label called ${name}.`);
    throw err;
  }
}

/** Archived, not deleted: tasks keep showing it, and it stops being offered. */
export function archiveLabel(actor: Actor, id: number): void {
  assertLabelAdmin(actor);
  db().query("UPDATE labels SET archived_at = ? WHERE id = ?").run(Date.now(), id);
}

function assertLabelAdmin(actor: Actor): void {
  if (!canManageLabels(actor)) throw new ForbiddenError("Labels are managed by admins.");
}

function cleanColor(color: string | null | undefined): string | null {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

function resolveLabels(refs: readonly (string | number)[]): number[] {
  const ids = new Set<number>();
  for (const ref of refs) {
    const row =
      typeof ref === "number"
        ? db().query<{ id: number }, [number]>("SELECT id FROM labels WHERE id = ? AND archived_at IS NULL").get(ref)
        : db().query<{ id: number }, [string]>("SELECT id FROM labels WHERE name = ? COLLATE NOCASE AND archived_at IS NULL").get(ref);
    if (!row) throw new UserInputError(`There's no label "${ref}".`);
    ids.add(row.id);
  }
  return [...ids];
}

function checkPeople(ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  const known = new Set(listPeople().map((p) => p.id));
  for (const id of unique) if (!known.has(id)) throw new UserInputError("One of those people doesn't exist or isn't active.");
  return unique;
}

interface StoredLocation {
  mapId: string | null;
  x: number | null;
  y: number | null;
  zoneId: string | null;
  note: string | null;
}

/**
 * Turn what a client sent into what's stored. Tapping a map gives a point, and
 * the zone is derived from it here so a client can't claim a point in one zone
 * and a label from another. A zone alone (a space with no map) is fine too.
 */
function resolveLocation(input: LocationInput | null | undefined): StoredLocation | null {
  if (!input) return null;
  const hasPoint = input.x != null || input.y != null;
  if (hasPoint && (input.x == null || input.y == null)) throw new UserInputError("A map location needs both x and y.");
  const zones = allZones();
  let zoneId = input.zoneId ?? null;
  if (zoneId && !zones.some((z) => z.id === zoneId)) throw new UserInputError(`There's no zone "${zoneId}".`);

  const s = site();
  let mapId = input.mapId ?? null;
  if (!mapId && hasPoint) {
    if (s.maps.length !== 1) throw new UserInputError("Say which map that point is on.");
    mapId = s.maps[0]!.id;
  }
  if (!mapId && zoneId) mapId = zones.find((z) => z.id === zoneId)?.mapId ?? null;

  let x: number | null = null;
  let y: number | null = null;
  if (mapId) {
    const map = s.maps.find((m) => m.id === mapId);
    if (!map) throw new UserInputError(`There's no map "${mapId}".`);
    if (hasPoint) {
      x = roundCoordinate(input.x!);
      y = roundCoordinate(input.y!);
      const b = boundsOf(map.outline);
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) throw new UserInputError("That point is outside the map.");
      const here = map.zones.find((z) => pointInPolygon(x!, y!, z.polygon));
      // A point in no zone (a corridor) keeps no zone; the point is still the location.
      zoneId = here?.id ?? null;
    }
  } else if (hasPoint) {
    throw new UserInputError("Say which map that point is on.");
  }
  const note = input.note?.trim() || null;
  if (!mapId && !zoneId && !note) return null;
  return { mapId, x, y, zoneId, note };
}

function today(now: number): string {
  return dateOf(now, config.timezone);
}

/**
 * Store the repeating rule. Returns its row id, and the due date the task should
 * carry. A series keeps one id for life, through rule changes and stops, because
 * that id is what ties past occurrences to it when its visibility changes.
 */
function saveRecurrence(input: RecurrenceInput, dueDate: string | null, now: number, existingId: string | null): { id: string; dueDate: string } {
  const id = existingId ?? uuidv7(now);
  const day = today(now);
  if (input.kind === "schedule") {
    const rrule = parseRrule(input.rrule);
    const anchorDate = input.anchorDate ?? dueDate ?? day;
    validateSchedule(rrule, anchorDate);
    const first = dueDate ?? firstScheduled(rrule, anchorDate, day);
    if (!first) throw new UserInputError("That repeat rule has no dates left.");
    db()
      .query(
        `INSERT INTO recurrences (id, kind, rrule, anchor_date, created_at) VALUES (?, 'schedule', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = 'schedule', rrule = excluded.rrule, anchor_date = excluded.anchor_date, interval_days = NULL, stopped_at = NULL`,
      )
      .run(id, rrule, anchorDate, now);
    return { id, dueDate: first };
  }
  db()
    .query(
      `INSERT INTO recurrences (id, kind, interval_days, created_at) VALUES (?, 'after_completion', ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = 'after_completion', rrule = NULL, anchor_date = NULL, interval_days = excluded.interval_days, stopped_at = NULL`,
    )
    .run(id, input.intervalDays, now);
  return { id, dueDate: dueDate ?? addDays(day, input.intervalDays) };
}

function setLinks(table: "task_labels" | "task_assignees" | "task_shares", column: "label_id" | "user_id", taskId: string, ids: readonly number[]): void {
  db().query(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
  const insert = db().query(`INSERT OR IGNORE INTO ${table} (task_id, ${column}) VALUES (?, ?)`);
  for (const id of ids) insert.run(taskId, id);
}

// ---- writing ---------------------------------------------------------------------

export interface CreateResult {
  task: TaskView;
  /** True when a dedupe key matched an open task, which was updated instead. */
  deduped: boolean;
}

/** A dedupe key belongs to the actor that made it: keys aren't global, and one agent can't reach into another's tasks. */
const dedupeScope = (actor: Actor): string => actorId(actor);

export function createTask(actor: Actor, input: TaskCreateInput, ctx: WriteContext = {}): CreateResult {
  const data = taskCreateSchema.parse(input);
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    if (!canCreate(actor, data.visibility)) {
      throw new ForbiddenError(data.visibility === "private" ? "This can't create private tasks." : "This can't create tasks.");
    }
    if (data.recurrence && !canSetRecurrence(actor)) throw new ForbiddenError("Repeating tasks need a sign-in.");
    if ((data.assignees.length > 0 || data.sharedWith.length > 0) && (actor.kind === "lan_device" || actor.kind === "integration")) {
      throw new ForbiddenError("Assigning and sharing need a sign-in.");
    }
    if (data.dedupeKey && !canDedupe(actor)) throw new ForbiddenError("Dedupe keys need a sign-in.");

    const labels = resolveLabels(data.labels);
    const assignees = checkPeople(data.assignees);
    const shares = checkPeople(data.sharedWith);
    const location = resolveLocation(data.location);

    if (data.dedupeKey) {
      const scope = dedupeScope(actor);
      const match = db()
        .query<TaskRow, [string, string]>(`${SELECT_TASK} WHERE t.dedupe_scope = ? AND t.dedupe_key = ? AND t.completed_at IS NULL AND t.deleted_at IS NULL`)
        .get(scope, data.dedupeKey);
      if (match) {
        // A key only ever names a task this actor may change, at the visibility it
        // asked for. Otherwise a repeat would overwrite a task someone has since made
        // private, or publish private text onto a public one. The refusal says
        // nothing about the task.
        if (!canEdit(actor, accessOf(match)) || match.visibility !== data.visibility) {
          throw new ConflictError("That dedupe key is held by a task this can't update. Use another key.");
        }
        db().query("UPDATE tasks SET title = ?, details = ?, updated_at = ?, rev = rev + 1 WHERE id = ?").run(data.title, data.details, now, match.id);
        recordEvent({ taskId: match.id, actor, via, type: "deduped", payload: { key: data.dedupeKey }, now, pending });
        return { task: toView(actor, findRow(match.id)!), deduped: true };
      }
    }

    const id = data.id ?? uuidv7(now);
    if (data.id && db().query("SELECT 1 FROM tasks WHERE id = ?").get(data.id)) throw new ConflictError("A task with that id already exists.");

    const owner = personOf(actor);
    const recurrence = data.recurrence ? saveRecurrence(data.recurrence, data.dueDate ?? null, now, null) : null;
    db()
      .query(
        `INSERT INTO tasks (id, title, details, visibility, owner_user_id, created_by, created_by_label, due_date,
                            map_id, x, y, zone_id, location_note, recurrence_id, dedupe_scope, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.title,
        data.details,
        data.visibility,
        owner,
        actorId(actor),
        actorLabel(actor),
        recurrence?.dueDate ?? data.dueDate ?? null,
        location?.mapId ?? null,
        location?.x ?? null,
        location?.y ?? null,
        location?.zoneId ?? null,
        location?.note ?? null,
        recurrence?.id ?? null,
        data.dedupeKey ? dedupeScope(actor) : null,
        data.dedupeKey ?? null,
        now,
        now,
      );
    setLinks("task_labels", "label_id", id, labels);
    setLinks("task_assignees", "user_id", id, assignees);
    setLinks("task_shares", "user_id", id, shares);
    recordEvent({
      taskId: id,
      actor,
      via,
      type: "created",
      payload: { title: data.title, visibility: data.visibility, assignees, labels, dueDate: recurrence?.dueDate ?? data.dueDate ?? null },
      now,
      pending,
    });
    return { task: toView(actor, findRow(id)!), deduped: false };
  });
}

export function updateTask(actor: Actor, id: string, input: TaskUpdateInput, ctx: WriteContext = {}): TaskView {
  const data = taskUpdateSchema.parse(input);
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, id);
    const access = accessOf(row);
    if (data.expectedRev !== undefined && data.expectedRev !== row.rev) {
      throw new ConflictError("Someone else changed this task. Reload and try again.");
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const note = (field: string, from: unknown, to: unknown) => {
      if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
    };

    const content = data.title !== undefined || data.details !== undefined || data.dueDate !== undefined || data.labels !== undefined || data.location !== undefined;
    if (content && !canEdit(actor, access)) throw new ForbiddenError("Editing someone else's task needs a sign-in.");

    if (data.assignees !== undefined && !canAssign(actor, access)) throw new ForbiddenError("You can't change who this is assigned to.");
    if (data.sharedWith !== undefined && !canManageAccess(actor, access)) throw new ForbiddenError("Only the owner can change who this is shared with.");
    if (data.recurrence !== undefined && (!canSetRecurrence(actor) || !canEdit(actor, access))) throw new ForbiddenError("You can't change how this repeats.");

    let visibility = row.visibility;
    let ownerUserId = row.owner_user_id;
    if (data.visibility !== undefined && data.visibility !== row.visibility) {
      if (data.visibility === "private") {
        if (!canMakePrivate(actor, access)) throw new ForbiddenError("Only the task's owner or an admin can make it private.");
        ownerUserId ??= personOf(actor);
        if (ownerUserId == null) throw new ForbiddenError("A private task needs an owner.");
      } else if (!canManageAccess(actor, access)) {
        throw new ForbiddenError("Only the owner can make this public.");
      }
      visibility = data.visibility;
      note("visibility", row.visibility, visibility);
    }

    const title = data.title ?? row.title;
    const details = data.details ?? row.details;
    note("title", row.title, title);
    note("details", row.details, details);

    let dueDate = data.dueDate === undefined ? row.due_date : (data.dueDate ?? null);

    let mapId = row.map_id;
    let x = row.x;
    let y = row.y;
    let zoneId = row.zone_id;
    let locationNote = row.location_note;
    if (data.location !== undefined) {
      const next = resolveLocation(data.location);
      note("location", { mapId, x, y, zoneId, note: locationNote }, next ?? { mapId: null, x: null, y: null, zoneId: null, note: null });
      mapId = next?.mapId ?? null;
      x = next?.x ?? null;
      y = next?.y ?? null;
      zoneId = next?.zoneId ?? null;
      locationNote = next?.note ?? null;
    }

    let recurrenceId = row.recurrence_id;
    if (data.recurrence !== undefined) {
      const before = row.r_stopped_at == null ? specOf(row) : null;
      if (data.recurrence) {
        const made = saveRecurrence(data.recurrence, dueDate, now, row.recurrence_id);
        recurrenceId = made.id;
        dueDate = made.dueDate;
      } else if (row.recurrence_id) {
        // Stopped, not forgotten: past occurrences still belong to this series.
        db().query("UPDATE recurrences SET stopped_at = ? WHERE id = ? AND stopped_at IS NULL").run(now, row.recurrence_id);
      }
      note("recurrence", before, data.recurrence);
    }
    note("dueDate", row.due_date, dueDate);

    if (data.labels !== undefined) {
      const ids = resolveLabels(data.labels);
      note("labels", (JSON.parse(row.label_json) as { id: number }[]).map((l) => l.id), ids);
      setLinks("task_labels", "label_id", id, ids);
    }
    if (data.assignees !== undefined) {
      const ids = checkPeople(data.assignees);
      note("assignees", access.assigneeIds, ids);
      setLinks("task_assignees", "user_id", id, ids);
    }
    if (data.sharedWith !== undefined) {
      const ids = checkPeople(data.sharedWith);
      note("sharedWith", access.shareIds, ids);
      setLinks("task_shares", "user_id", id, ids);
    }

    if (Object.keys(changes).length === 0) return toView(actor, findRow(id)!);

    db()
      .query(
        `UPDATE tasks SET title = ?, details = ?, visibility = ?, owner_user_id = ?, due_date = ?, map_id = ?, x = ?, y = ?,
                          zone_id = ?, location_note = ?, recurrence_id = ?, updated_at = ?, rev = rev + 1
          WHERE id = ?`,
      )
      .run(title, details, visibility, ownerUserId, dueDate, mapId, x, y, zoneId, locationNote, recurrenceId, now, id);
    // Narrowing who can see it may hide it from someone watching.
    const narrowed = changes.visibility !== undefined || changes.sharedWith !== undefined || changes.assignees !== undefined;
    recordEvent({ taskId: id, actor, via, type: "updated", payload: { changes }, now, pending, resync: narrowed });
    if (recurrenceId && narrowed && (changes.visibility !== undefined || visibility === "private")) {
      syncSeriesAccess({ taskId: id, recurrenceId, visibility, ownerUserId, actor, via, now, pending });
    }
    return toView(actor, findRow(id)!);
  });
}

/**
 * Past occurrences follow the series. Going private must take the history with it,
 * or last month's occurrence goes on showing the same title to everyone, and who
 * can see a private occurrence is whoever can see the live one.
 */
function syncSeriesAccess(args: { taskId: string; recurrenceId: string; visibility: "public" | "private"; ownerUserId: number | null; actor: Actor; via: string; now: number; pending: Pending }): void {
  const { taskId, recurrenceId, visibility, ownerUserId, actor, via, now, pending } = args;
  const others = db().query<{ id: string }, [string, string]>("SELECT id FROM tasks WHERE recurrence_id = ? AND id <> ?").all(recurrenceId, taskId);
  for (const { id } of others) {
    db().query("UPDATE tasks SET visibility = ?, owner_user_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?").run(visibility, ownerUserId, now, id);
    if (visibility === "private") {
      db().query("DELETE FROM task_shares WHERE task_id = ?").run(id);
      db().query("INSERT INTO task_shares (task_id, user_id) SELECT ?, user_id FROM task_shares WHERE task_id = ?").run(id, taskId);
      db().query("DELETE FROM task_assignees WHERE task_id = ?").run(id);
      db().query("INSERT INTO task_assignees (task_id, user_id) SELECT ?, user_id FROM task_assignees WHERE task_id = ?").run(id, taskId);
    }
    recordEvent({ taskId: id, actor, via, type: "updated", payload: { series: taskId, visibility }, now, pending, resync: true });
  }
}

/** A check-off's time, from a client's queue: never the future, never ancient history. */
function completionTime(at: number | undefined, now: number): number {
  if (at === undefined) return now;
  return Math.max(Math.min(at, now), now - 30 * 86_400_000);
}

export function completeTask(actor: Actor, id: string, input: CompleteInput = {}, ctx: WriteContext = {}): TaskView {
  const data = completeSchema.parse(input);
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, id);
    if (!canComplete(actor, accessOf(row))) throw new ForbiddenError("This can't check off that task.");
    // Two people tapping the same task is one check-off, and neither has done anything wrong.
    if (row.completed_at != null) return toView(actor, row);

    const at = completionTime(data.at, now);
    db()
      .query("UPDATE tasks SET completed_at = ?, completed_by = ?, completed_by_label = ?, updated_at = ?, rev = rev + 1 WHERE id = ?")
      .run(at, actorId(actor), actorLabel(actor), now, id);
    recordEvent({ taskId: id, actor, via, type: "completed", payload: { at, ...(data.note ? { note: data.note } : {}) }, now, pending });

    if (data.note && canComment(actor, accessOf(row))) insertComment(actor, via, id, uuidv7(now), data.note, now, pending);

    spawnNextOccurrence(row, at, now, pending);
    return toView(actor, findRow(id)!);
  });
}

function spawnNextOccurrence(row: TaskRow, completedAt: number, now: number, pending: Pending): void {
  const spec = row.r_stopped_at == null ? specOf(row) : null;
  if (!spec) return;
  const next = nextDueDate(spec, today(completedAt), row.due_date);
  if (!next) return;

  const id = uuidv7(now);
  db()
    .query(
      `INSERT INTO tasks (id, title, details, visibility, owner_user_id, created_by, created_by_label, due_date,
                          map_id, x, y, zone_id, location_note, recurrence_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      row.title,
      row.details,
      row.visibility,
      row.owner_user_id,
      actorId(SYSTEM),
      actorLabel(SYSTEM),
      next,
      row.map_id,
      row.x,
      row.y,
      row.zone_id,
      row.location_note,
      row.recurrence_id,
      now,
      now,
    );
  db().query("INSERT INTO task_labels (task_id, label_id) SELECT ?, label_id FROM task_labels WHERE task_id = ?").run(id, row.id);
  db().query("INSERT INTO task_assignees (task_id, user_id) SELECT ?, user_id FROM task_assignees WHERE task_id = ?").run(id, row.id);
  db().query("INSERT INTO task_shares (task_id, user_id) SELECT ?, user_id FROM task_shares WHERE task_id = ?").run(id, row.id);
  recordEvent({ taskId: id, actor: SYSTEM, via: "schedule", type: "created", payload: { previous: row.id, dueDate: next }, now, pending });
}

export function reopenTask(actor: Actor, id: string, ctx: WriteContext = {}): TaskView {
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, id);
    if (!canComplete(actor, accessOf(row))) throw new ForbiddenError("This can't reopen that task.");
    if (row.completed_at == null) return toView(actor, row);

    // Only one occurrence may be open. Undoing a mis-tap should simply work, so
    // for a person the successor that check-off spawned is taken back, unless
    // someone has since changed it. Only a person may cause a deletion, so anyone
    // else reopens this one out of the series, and the successor stays.
    let leavesSeries = false;
    if (row.recurrence_id) {
      const successor = db()
        .query<{ id: string; rev: number }, [string, string]>(
          "SELECT id, rev FROM tasks WHERE recurrence_id = ? AND id <> ? AND completed_at IS NULL AND deleted_at IS NULL",
        )
        .get(row.recurrence_id, id);
      if (successor && actor.kind !== "user") {
        leavesSeries = true;
      } else if (successor) {
        if (successor.rev > 1) throw new ConflictError("The next occurrence has already been changed. Complete or delete it first.");
        db().query("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, successor.id);
        recordEvent({ taskId: successor.id, actor: SYSTEM, via, type: "superseded", payload: { reopened: id }, now, pending, resync: true });
      }
    }
    if (row.dedupe_key) {
      const clash = db()
        .query("SELECT 1 FROM tasks WHERE dedupe_scope = ? AND dedupe_key = ? AND id <> ? AND completed_at IS NULL AND deleted_at IS NULL")
        .get(row.dedupe_scope, row.dedupe_key, id);
      if (clash) throw new ConflictError("A newer open task has the same dedupe key.");
    }

    db()
      .query("UPDATE tasks SET completed_at = NULL, completed_by = NULL, completed_by_label = NULL, recurrence_id = ?, updated_at = ?, rev = rev + 1 WHERE id = ?")
      .run(leavesSeries ? null : row.recurrence_id, now, id);
    recordEvent({ taskId: id, actor, via, type: "reopened", payload: leavesSeries ? { leftSeries: row.recurrence_id } : {}, now, pending });
    return toView(actor, findRow(id)!);
  });
}

/**
 * Close the open task with this key, for "the sensor came back". Answers null
 * rather than failing when nothing is open: recovery often has nothing to close.
 */
export function completeByDedupeKey(actor: Actor, key: string, input: CompleteInput = {}, ctx: WriteContext = {}): TaskView | null {
  requireReader(actor);
  const row = db()
    .query<{ id: string }, [string, string]>("SELECT id FROM tasks WHERE dedupe_scope = ? AND dedupe_key = ? AND completed_at IS NULL AND deleted_at IS NULL")
    .get(dedupeScope(actor), key);
  return row ? completeTask(actor, row.id, input, ctx) : null;
}

/** Soft: the row and its history stay, and it stops existing for everyone. */
export function deleteTask(actor: Actor, id: string, ctx: WriteContext = {}): void {
  const via = ctx.via ?? defaultVia(actor);
  write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, id);
    if (!canDelete(actor, accessOf(row))) {
      throw new ForbiddenError(actor.kind === "agent" || actor.kind === "integration" ? "Deleting isn't available to agents." : "Deleting needs a sign-in, and a private task is its owner's to delete.");
    }
    db().query("UPDATE tasks SET deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, now, id);
    recordEvent({ taskId: id, actor, via, type: "deleted", payload: { title: row.title }, now, pending, resync: true });
    return null;
  });
}

function insertComment(actor: Actor, via: string, taskId: string, id: string, body: string, now: number, pending: Pending): void {
  db().query("INSERT INTO task_comments (id, task_id, body, actor_id, actor_label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, taskId, body, actorId(actor), actorLabel(actor), now);
  db().query("UPDATE tasks SET updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, taskId);
  recordEvent({ taskId, actor, via, type: "commented", payload: { commentId: id, body: body.slice(0, 280) }, now, pending });
}

export function addComment(actor: Actor, taskId: string, input: { id?: string; body: string }, ctx: WriteContext = {}): CommentView {
  const data = commentSchema.parse(input);
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, taskId);
    if (!canComment(actor, accessOf(row))) throw new ForbiddenError("Commenting needs a sign-in.");
    const id = data.id ?? uuidv7(now);
    insertComment(actor, via, taskId, id, data.body, now, pending);
    return { id, body: data.body, actor: actorLabel(actor), at: now };
  });
}

// ---- attachments --------------------------------------------------------------------

export interface AttachmentView {
  id: string;
  taskId: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hasThumb: boolean;
  by: string;
  at: number;
  canDelete: boolean;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  has_thumb: number;
  actor_id: string;
  actor_label: string;
  created_at: number;
  deleted_at: number | null;
}

function attachmentView(actor: Actor, a: AttachmentRow, row: TaskRow): AttachmentView {
  return {
    id: a.id,
    taskId: a.task_id,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    width: a.width,
    height: a.height,
    hasThumb: a.has_thumb === 1,
    by: a.actor_label,
    at: a.created_at,
    canDelete: canRemoveAttachment(actor, a, row),
  };
}

function canRemoveAttachment(actor: Actor, a: AttachmentRow, row: TaskRow): boolean {
  // Removing destroys bytes, so it's for people, like deleting a task.
  if (actor.kind !== "user") return false;
  return actorId(actor) === a.actor_id || row.owner_user_id === actor.userId || actor.role === "admin";
}

export function listAttachments(actor: Actor, taskId: string): AttachmentView[] {
  const row = readableRow(actor, taskId);
  return db()
    .query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at, id")
    .all(taskId)
    .map((a) => attachmentView(actor, a, row));
}

/** Check, before any bytes are stored, that this actor may attach to this task. */
export function assertCanAttach(actor: Actor, taskId: string): void {
  const row = readableRow(actor, taskId);
  if (!canAttach(actor, accessOf(row))) throw new ForbiddenError("Attaching files needs a sign-in.");
  const { n } = db().query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM attachments WHERE task_id = ? AND deleted_at IS NULL").get(taskId)!;
  if (n >= ATTACHMENTS_MAX_PER_TASK) throw new UserInputError(`A task can hold ${ATTACHMENTS_MAX_PER_TASK} attachments.`);
}

export function addAttachment(
  actor: Actor,
  taskId: string,
  file: { id: string; filename: string; mime: string; size: number; sha256: string; width: number | null; height: number | null; hasThumb: boolean },
  ctx: WriteContext = {},
): AttachmentView {
  const via = ctx.via ?? defaultVia(actor);
  return write(actor, ctx, (pending, now) => {
    const row = readableRow(actor, taskId);
    if (!canAttach(actor, accessOf(row))) throw new ForbiddenError("Attaching files needs a sign-in.");
    db()
      .query(
        `INSERT INTO attachments (id, task_id, filename, mime, size, sha256, width, height, has_thumb, actor_id, actor_label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(file.id, taskId, file.filename, file.mime, file.size, file.sha256, file.width, file.height, file.hasThumb ? 1 : 0, actorId(actor), actorLabel(actor), now);
    db().query("UPDATE tasks SET updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, taskId);
    recordEvent({ taskId, actor, via, type: "attached", payload: { attachmentId: file.id, filename: file.filename, size: file.size }, now, pending });
    const a = db().query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE id = ?").get(file.id)!;
    return attachmentView(actor, a, row);
  });
}

/**
 * The attachment, if this actor may read its task. A deleted task's files go
 * with it, and an attachment on a task the actor can't see doesn't exist.
 */
export function readableAttachment(actor: Actor, id: string): AttachmentView {
  requireReader(actor);
  const a = db().query<AttachmentRow, [string]>("SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!a) throw new NotFoundError("That attachment doesn't exist, or you can't see it.");
  const row = findRow(a.task_id);
  if (!row || !canRead(actor, accessOf(row))) throw new NotFoundError("That attachment doesn't exist, or you can't see it.");
  return attachmentView(actor, a, row);
}

export function removeAttachment(actor: Actor, id: string, ctx: WriteContext = {}): void {
  const via = ctx.via ?? defaultVia(actor);
  write(actor, ctx, (pending, now) => {
    const view = readableAttachment(actor, id);
    if (!view.canDelete) throw new ForbiddenError("That isn't yours to remove.");
    db().query("UPDATE attachments SET deleted_at = ? WHERE id = ?").run(now, id);
    db().query("UPDATE tasks SET updated_at = ?, rev = rev + 1 WHERE id = ?").run(now, view.taskId);
    recordEvent({ taskId: view.taskId, actor, via, type: "detached", payload: { attachmentId: id, filename: view.filename }, now, pending });
    return null;
  });
}

