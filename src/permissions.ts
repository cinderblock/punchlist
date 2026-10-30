import { type Actor, type AgentActor, type Scope, type UserActor, actorId } from "./actors.ts";

/**
 * The whole permission model, as pure functions of an actor and a task. Every
 * rule in the app is one of these: the domain layer calls them, the SQL filter
 * in `visibleClause` is checked against `canRead` by a test, and no front end
 * has a rule of its own.
 *
 * In one table:
 *
 *                     read     create     complete   edit       delete   comment  attach
 *   user, public      yes      yes        yes        yes        yes      yes      yes
 *   user, private     *        own        *          *          owner    *        *
 *   lan, public       yes      yes        yes        own only   no       no       no
 *   lan, private      never    never      never      never      never    never    never
 *   agent             user's, intersected with scopes; never delete, never admin
 *   integration       public only, by scope; edits only what it made
 *   nobody            nothing
 *
 *   * = the owner, plus anyone the task is shared with or assigned to.
 *
 * Admins get no extra reach into private tasks here or anywhere else.
 */

/** The facts about a task that decide access. */
export interface TaskAccess {
  visibility: "public" | "private";
  ownerUserId: number | null;
  /** Actor id. */
  createdBy: string;
  assigneeIds: readonly number[];
  shareIds: readonly number[];
}

const has = (actor: { scopes: readonly Scope[] }, scope: Scope) => actor.scopes.includes(scope);

/** The owner, seen with no admin standing: an agent never inherits that. */
function ownerOf(agent: AgentActor): UserActor {
  return { kind: "user", userId: agent.ownerUserId, name: agent.ownerName, role: "member" };
}

function isPartyTo(userId: number, t: TaskAccess): boolean {
  return t.ownerUserId === userId || t.assigneeIds.includes(userId) || t.shareIds.includes(userId);
}

export function canRead(actor: Actor, t: TaskAccess): boolean {
  switch (actor.kind) {
    case "user":
      return t.visibility === "public" || isPartyTo(actor.userId, t);
    case "agent":
      if (!has(actor, "tasks:read")) return false;
      return t.visibility === "public" || (has(actor, "private:read") && isPartyTo(actor.ownerUserId, t));
    case "lan_device":
      return t.visibility === "public";
    case "integration":
      return t.visibility === "public" && has(actor, "tasks:read");
    case "system":
      return true;
    case "nobody":
      return false;
  }
}

export function canCreate(actor: Actor, visibility: TaskAccess["visibility"]): boolean {
  switch (actor.kind) {
    case "user":
      return true;
    case "agent":
      return has(actor, "tasks:write") && (visibility === "public" || has(actor, "private:write"));
    case "lan_device":
      return visibility === "public";
    case "integration":
      return visibility === "public" && has(actor, "tasks:write");
    case "system":
      return true;
    case "nobody":
      return false;
  }
}

/** Check off and reopen. */
export function canComplete(actor: Actor, t: TaskAccess): boolean {
  if (!canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
    case "lan_device":
    case "system":
      return true;
    case "agent":
      return has(actor, "tasks:complete") && (t.visibility === "public" || has(actor, "private:write"));
    case "integration":
      return has(actor, "tasks:complete");
    case "nobody":
      return false;
  }
}

/** Title, details, due date, labels, location. */
export function canEdit(actor: Actor, t: TaskAccess): boolean {
  if (!canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
    case "system":
      return true;
    case "agent":
      return has(actor, "tasks:write") && (t.visibility === "public" || has(actor, "private:write"));
    case "lan_device":
    case "integration":
      // Others' tasks need a sign-in. A device may fix its own typo.
      return t.createdBy === actorId(actor) && (actor.kind === "lan_device" || has(actor, "tasks:write"));
    case "nobody":
      return false;
  }
}

/** Assignees, on a task this actor may edit. On a private task assigning grants sight, so only the owner may. */
export function canAssign(actor: Actor, t: TaskAccess): boolean {
  if (!canEdit(actor, t)) return false;
  if (actor.kind === "lan_device" || actor.kind === "integration") return false;
  return t.visibility === "public" || canManageAccess(actor, t);
}

/** Who else a private task is shared with, and turning a private task public. */
export function canManageAccess(actor: Actor, t: TaskAccess): boolean {
  if (!canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
      return t.ownerUserId === actor.userId;
    case "agent":
      return has(actor, "private:write") && t.ownerUserId === actor.ownerUserId;
    case "system":
      return true;
    default:
      return false;
  }
}

/** Taking a public task private. It disappears for everyone else, so it's not for just anyone. */
export function canMakePrivate(actor: Actor, t: TaskAccess): boolean {
  if (t.visibility !== "public" || !canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
      return actor.role === "admin" || t.ownerUserId === actor.userId || t.createdBy === actorId(actor);
    case "agent":
      return has(actor, "private:write") && has(actor, "tasks:write") && t.ownerUserId === actor.ownerUserId;
    default:
      return false;
  }
}

/**
 * Deleting needs a sign-in, and is for people: agents and integrations can't.
 * On a public task anyone signed in may; a private task is its owner's alone.
 */
export function canDelete(actor: Actor, t: TaskAccess): boolean {
  if (actor.kind !== "user" || !canRead(actor, t)) return false;
  return t.visibility === "public" || t.ownerUserId === actor.userId;
}

export function canComment(actor: Actor, t: TaskAccess): boolean {
  if (!canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
      return true;
    case "agent":
      return has(actor, "tasks:write") && (t.visibility === "public" || has(actor, "private:write"));
    case "integration":
      return has(actor, "tasks:write");
    default:
      return false;
  }
}

export function canAttach(actor: Actor, t: TaskAccess): boolean {
  if (!canRead(actor, t)) return false;
  switch (actor.kind) {
    case "user":
      return true;
    case "agent":
      return has(actor, "attachments:write") && (t.visibility === "public" || has(actor, "private:write"));
    default:
      return false;
  }
}

/** Setting a repeating rule is a sign-in thing; an on-site visitor adds one-off tasks. */
export function canSetRecurrence(actor: Actor): boolean {
  return actor.kind === "user" || actor.kind === "agent" || actor.kind === "system";
}

/** Dedupe keys are for automation: agents and integrations. */
export function canDedupe(actor: Actor): boolean {
  return actor.kind === "agent" || actor.kind === "integration" || actor.kind === "user";
}

/** Labels are edited by admins; every other label decision is made by the config file. */
export function canManageLabels(actor: Actor): boolean {
  return actor.kind === "user" && actor.role === "admin";
}

/** May this actor see any task data at all? */
export function canReadAnything(actor: Actor): boolean {
  switch (actor.kind) {
    case "user":
    case "lan_device":
    case "system":
      return true;
    case "agent":
    case "integration":
      return has(actor, "tasks:read");
    case "nobody":
      return false;
  }
}

/**
 * SQL for "this actor can read the row aliased `t`", to go in a WHERE clause.
 * The same rule as canRead, in the form a list needs. No front end writes its
 * own: every query that returns task data goes through this.
 */
export function visibleClause(actor: Actor): { sql: string; params: (number | string)[] } {
  const none = { sql: "0", params: [] };
  const publicOnly = { sql: "t.visibility = 'public'", params: [] };
  const party = (userId: number) => ({
    sql: `(t.visibility = 'public' OR t.owner_user_id = ?
           OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)
           OR EXISTS (SELECT 1 FROM task_shares s WHERE s.task_id = t.id AND s.user_id = ?))`,
    params: [userId, userId, userId],
  });

  switch (actor.kind) {
    case "user":
      return party(actor.userId);
    case "agent":
      if (!has(actor, "tasks:read")) return none;
      return has(actor, "private:read") ? party(actor.ownerUserId) : publicOnly;
    case "lan_device":
      return publicOnly;
    case "integration":
      return has(actor, "tasks:read") ? publicOnly : none;
    case "system":
      return { sql: "1", params: [] };
    case "nobody":
      return none;
  }
}

/** What the signed-in actor may do with this task, for the UI's buttons. */
export function taskPermissions(actor: Actor, t: TaskAccess) {
  return {
    complete: canComplete(actor, t),
    edit: canEdit(actor, t),
    assign: canAssign(actor, t),
    manageAccess: canManageAccess(actor, t),
    makePrivate: canMakePrivate(actor, t),
    delete: canDelete(actor, t),
    comment: canComment(actor, t),
    attach: canAttach(actor, t),
  };
}

export type TaskPermissions = ReturnType<typeof taskPermissions>;
