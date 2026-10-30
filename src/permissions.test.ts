import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Actor } from "./actors.ts";
import { setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "./errors.ts";
import { type TaskAccess, canAssign, canComplete, canDelete, canEdit, canMakePrivate, canManageAccess, canRead, visibleClause } from "./permissions.ts";
import { addComment, completeTask, createTask, deleteTask, getTask, listTasks, reopenTask, taskHistory, updateTask } from "./tasks.ts";
import { type World, agentFor, freshWorld } from "./testing/fixtures.ts";

let w: World;
beforeEach(() => {
  w = freshWorld();
});
afterEach(() => setConfigForTests(undefined));

const nobody: Actor = { kind: "nobody" };

describe("what each kind of actor can do with a public task", () => {
  test("an on-site visitor can view, check off and add, and nothing more", () => {
    const { task } = createTask(w.lan, { title: "Sweep the floor" });
    expect(task.createdBy).toBe("On-site device");
    expect(getTask(w.lan, task.id).title).toBe("Sweep the floor");
    expect(completeTask(w.lan, task.id).status).toBe("done");
    expect(reopenTask(w.lan, task.id).status).toBe("open");

    const others = createTask(w.alice, { title: "Alice's job" }).task;
    expect(() => updateTask(w.lan, others.id, { title: "Mine now" })).toThrow(ForbiddenError);
    expect(() => deleteTask(w.lan, others.id)).toThrow(ForbiddenError);
    expect(() => deleteTask(w.lan, task.id)).toThrow(ForbiddenError);
    expect(() => addComment(w.lan, task.id, { body: "hello" })).toThrow(ForbiddenError);
  });

  test("an on-site visitor may fix their own task's typo, but not anyone else's", () => {
    const mine = createTask(w.lan, { title: "Tpyo" }).task;
    expect(updateTask(w.lan, mine.id, { title: "Typo" }).title).toBe("Typo");
    const otherDevice: Actor = { kind: "lan_device", deviceId: "device-2", deviceName: null };
    db().exec("INSERT INTO lan_devices (id, created_at, last_seen_at) VALUES ('device-2', 0, 0)");
    expect(() => updateTask(otherDevice, mine.id, { title: "Nope" })).toThrow(ForbiddenError);
  });

  test("an on-site visitor can't assign, share, change visibility, or set repeats", () => {
    const mine = createTask(w.lan, { title: "Mine" }).task;
    expect(() => updateTask(w.lan, mine.id, { assignees: [w.alice.userId] })).toThrow(ForbiddenError);
    expect(() => updateTask(w.lan, mine.id, { visibility: "private" })).toThrow(ForbiddenError);
    expect(() => updateTask(w.lan, mine.id, { recurrence: { kind: "after_completion", intervalDays: 7 } })).toThrow(ForbiddenError);
    expect(() => createTask(w.lan, { title: "x", assignees: [w.alice.userId] })).toThrow(ForbiddenError);
    expect(() => createTask(w.lan, { title: "x", recurrence: { kind: "after_completion", intervalDays: 7 } })).toThrow(ForbiddenError);
    expect(() => createTask(w.lan, { title: "x", dedupeKey: "k" })).toThrow(ForbiddenError);
  });

  test("a typed name stays unverified and never maps to a user", () => {
    const named: Actor = { kind: "lan_device", deviceId: "device-1", deviceName: "Alice Member" };
    const { task } = createTask(named, { title: "Signed by nobody" });
    expect(task.createdBy).toBe('On-site device, "Alice Member" (unverified)');
    expect(() => updateTask(named, createTask(w.alice, { title: "Alice's" }).task.id, { title: "x" })).toThrow(ForbiddenError);
  });

  test("anyone signed in can edit and delete a public task", () => {
    const { task } = createTask(w.lan, { title: "Left on site" });
    expect(updateTask(w.bob, task.id, { title: "Tidied" }).title).toBe("Tidied");
    deleteTask(w.alice, task.id);
    expect(() => getTask(w.bob, task.id)).toThrow(NotFoundError);
  });

  test("nobody gets nothing, and a clear refusal", () => {
    const { task } = createTask(w.alice, { title: "Visible on site" });
    expect(() => listTasks(nobody)).toThrow(UnauthorizedError);
    expect(() => getTask(nobody, task.id)).toThrow(UnauthorizedError);
    expect(() => createTask(nobody, { title: "x" })).toThrow(UnauthorizedError);
    expect(() => completeTask(nobody, task.id)).toThrow(UnauthorizedError);
  });
});

describe("private tasks", () => {
  test("visible to the owner, sharees and assignees, and not to anyone else, admins included", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private", sharedWith: [w.bob.userId] });
    expect(getTask(w.alice, task.id).title).toBe("Secret");
    expect(getTask(w.bob, task.id).title).toBe("Secret");
    expect(() => getTask(w.admin, task.id)).toThrow(NotFoundError);
    expect(() => getTask(w.lan, task.id)).toThrow(NotFoundError);
    expect(listTasks(w.admin).map((t) => t.id)).not.toContain(task.id);
    expect(listTasks(w.lan).map((t) => t.id)).not.toContain(task.id);
  });

  test("a stranger gets the same answer for a private task as for no task at all", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private" });
    const errorFor = (id: string) => {
      try {
        getTask(w.bob, id);
      } catch (err) {
        return `${(err as Error).constructor.name}: ${(err as Error).message}`;
      }
      return "no error";
    };
    expect(errorFor(task.id)).toBe(errorFor("no-such-task"));
    expect(() => completeTask(w.bob, task.id)).toThrow(NotFoundError);
    expect(() => deleteTask(w.admin, task.id)).toThrow(NotFoundError);
    expect(() => taskHistory(w.admin, task.id)).toThrow(NotFoundError);
  });

  test("being assigned grants sight; being unassigned takes it away", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private", assignees: [w.bob.userId] });
    expect(getTask(w.bob, task.id).id).toBe(task.id);
    updateTask(w.alice, task.id, { assignees: [] });
    expect(() => getTask(w.bob, task.id)).toThrow(NotFoundError);
  });

  test("an on-site visitor can't make one, or check one off", () => {
    expect(() => createTask(w.lan, { title: "x", visibility: "private" })).toThrow(ForbiddenError);
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private" });
    expect(() => completeTask(w.lan, task.id)).toThrow(NotFoundError);
  });

  test("only the owner shares, assigns, or makes it public", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private", sharedWith: [w.bob.userId] });
    expect(() => updateTask(w.bob, task.id, { sharedWith: [w.admin.userId] })).toThrow(ForbiddenError);
    expect(() => updateTask(w.bob, task.id, { assignees: [w.admin.userId] })).toThrow(ForbiddenError);
    expect(() => updateTask(w.bob, task.id, { visibility: "public" })).toThrow(ForbiddenError);
    expect(updateTask(w.alice, task.id, { visibility: "public" }).visibility).toBe("public");
    expect(getTask(w.lan, task.id).id).toBe(task.id);
  });

  test("a sharee can edit it, but only the owner can delete it", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private", sharedWith: [w.bob.userId] });
    expect(updateTask(w.bob, task.id, { title: "Secret, edited" }).title).toBe("Secret, edited");
    expect(() => deleteTask(w.bob, task.id)).toThrow(ForbiddenError);
    deleteTask(w.alice, task.id);
  });

  test("making a public task private takes it out of everyone else's sight", () => {
    const { task } = createTask(w.lan, { title: "Going private" });
    expect(() => updateTask(w.bob, task.id, { visibility: "private" })).toThrow(ForbiddenError);
    const made = updateTask(w.admin, task.id, { visibility: "private" });
    expect(made.visibility).toBe("private");
    expect(() => getTask(w.bob, task.id)).toThrow(NotFoundError);
    expect(() => getTask(w.lan, task.id)).toThrow(NotFoundError);
  });
});

describe("agents", () => {
  test("act as the intersection of their scopes and their owner's rights", () => {
    const privateOne = createTask(w.alice, { title: "Alice's secret", visibility: "private" }).task;
    const bobsSecret = createTask(w.bob, { title: "Bob's secret", visibility: "private" }).task;

    const full = agentFor(w.alice).actor;
    expect(getTask(full, privateOne.id).id).toBe(privateOne.id);
    expect(() => getTask(full, bobsSecret.id)).toThrow(NotFoundError);

    const publicOnly = agentFor(w.alice, ["tasks:read", "tasks:write", "tasks:complete"]).actor;
    expect(() => getTask(publicOnly, privateOne.id)).toThrow(NotFoundError);
    expect(() => createTask(publicOnly, { title: "x", visibility: "private" })).toThrow(ForbiddenError);
  });

  test("need the scope for each thing", () => {
    const { task } = createTask(w.alice, { title: "Public" });
    const reader = agentFor(w.alice, ["tasks:read"]).actor;
    expect(getTask(reader, task.id).id).toBe(task.id);
    expect(() => createTask(reader, { title: "x" })).toThrow(ForbiddenError);
    expect(() => updateTask(reader, task.id, { title: "x" })).toThrow(ForbiddenError);
    expect(() => completeTask(reader, task.id)).toThrow(ForbiddenError);
    expect(() => addComment(reader, task.id, { body: "x" })).toThrow(ForbiddenError);

    const noRead = agentFor(w.alice, ["tasks:write"]).actor;
    expect(() => listTasks(noRead)).toThrow(ForbiddenError);
  });

  test("private:read alone can see but not change", () => {
    const { task } = createTask(w.alice, { title: "Secret", visibility: "private" });
    const peek = agentFor(w.alice, ["tasks:read", "tasks:write", "tasks:complete", "private:read"]).actor;
    expect(getTask(peek, task.id).id).toBe(task.id);
    expect(() => updateTask(peek, task.id, { title: "x" })).toThrow(ForbiddenError);
    expect(() => completeTask(peek, task.id)).toThrow(ForbiddenError);
  });

  test("can never delete, even with every scope", () => {
    const { task } = createTask(w.alice, { title: "Public" });
    const mine = createTask(agentFor(w.alice).actor, { title: "Agent's own" }).task;
    const full = agentFor(w.alice).actor;
    expect(() => deleteTask(full, task.id)).toThrow(ForbiddenError);
    expect(() => deleteTask(full, mine.id)).toThrow(ForbiddenError);
  });

  test("an admin's agent gets no admin power", () => {
    const { task } = createTask(w.lan, { title: "Public" });
    const adminAgent = agentFor(w.admin).actor;
    expect(() => updateTask(adminAgent, task.id, { visibility: "private" })).toThrow(ForbiddenError);
  });

  test("are shown as themselves, on behalf of their owner, everywhere", () => {
    const agent = agentFor(w.alice).actor;
    const { task } = createTask(agent, { title: "From an agent", dueDate: "2030-01-02" }, { via: "mcp" });
    expect(task.createdBy).toBe("Helper, for Alice Member");
    const [event] = taskHistory(w.alice, task.id);
    expect(event!.actor).toBe("Helper, for Alice Member");
    expect(event!.via).toBe("mcp");
    const row = db().query<{ actor_id: string; on_behalf_of: string }, []>("SELECT actor_id, on_behalf_of FROM task_events").get()!;
    expect(row.actor_id).toBe(`agent:${agent.agentId}`);
    expect(row.on_behalf_of).toBe(`user:${w.alice.userId}`);
  });
});

describe("the SQL filter and canRead agree", () => {
  test("for every actor, on every shape of task", () => {
    const scopesAgent = agentFor(w.alice).actor;
    const publicAgent = agentFor(w.alice, ["tasks:read"]).actor;
    const blindAgent = agentFor(w.alice, ["tasks:write"]).actor;
    const integration: Actor = { kind: "integration", integrationId: "monitor", name: "Monitor", scopes: ["tasks:read"], via: "api" };
    const blindIntegration: Actor = { kind: "integration", integrationId: "monitor", name: "Monitor", scopes: ["tasks:write"], via: "api" };
    const actors: Actor[] = [w.admin, w.alice, w.bob, w.lan, scopesAgent, publicAgent, blindAgent, integration, blindIntegration, { kind: "system" }, nobody];

    createTask(w.lan, { title: "Public, no owner" });
    createTask(w.alice, { title: "Public, Alice" });
    createTask(w.alice, { title: "Private, Alice", visibility: "private" });
    createTask(w.bob, { title: "Private, Bob", visibility: "private" });
    createTask(w.bob, { title: "Private, Bob, shared with Alice", visibility: "private", sharedWith: [w.alice.userId] });
    createTask(w.bob, { title: "Private, Bob, assigned to Alice", visibility: "private", assignees: [w.alice.userId] });

    const access = (id: string): TaskAccess => {
      const t = db().query<{ visibility: "public" | "private"; owner_user_id: number | null; created_by: string }, [string]>("SELECT visibility, owner_user_id, created_by FROM tasks WHERE id = ?").get(id)!;
      const ids = (table: string) => db().query<{ user_id: number }, [string]>(`SELECT user_id FROM ${table} WHERE task_id = ?`).all(id).map((r) => r.user_id);
      return { visibility: t.visibility, ownerUserId: t.owner_user_id, createdBy: t.created_by, assigneeIds: ids("task_assignees"), shareIds: ids("task_shares") };
    };
    const all = db().query<{ id: string }, []>("SELECT id FROM tasks").all().map((r) => r.id);

    for (const actor of actors) {
      const clause = visibleClause(actor);
      const sqlSees = new Set(db().query<{ id: string }, (string | number)[]>(`SELECT t.id FROM tasks t WHERE ${clause.sql}`).all(...clause.params).map((r) => r.id));
      for (const id of all) expect(sqlSees.has(id)).toBe(canRead(actor, access(id)));
    }
  });
});

test("the rules read as the table says", () => {
  const publicTask: TaskAccess = { visibility: "public", ownerUserId: null, createdBy: "lan:x", assigneeIds: [], shareIds: [] };
  expect(canComplete(w.lan, publicTask)).toBe(true);
  expect(canEdit(w.lan, publicTask)).toBe(false);
  expect(canDelete(w.lan, publicTask)).toBe(false);
  expect(canAssign(w.lan, publicTask)).toBe(false);
  expect(canManageAccess(w.lan, publicTask)).toBe(false);
  expect(canMakePrivate(w.lan, publicTask)).toBe(false);
  expect(canRead(nobody, publicTask)).toBe(false);
});
