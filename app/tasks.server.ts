import type { Actor } from "../src/actors.ts";
import { config, site } from "../src/config.server.ts";
import { dateOf } from "../src/time.ts";
import {
  activity,
  getTask,
  listAssignable,
  listAttachments,
  listComments,
  listLabels,
  listTasks,
  listZones,
  taskHistory,
} from "../src/tasks.ts";
import { personOf } from "../src/actors.ts";
import { whenText } from "./views.server.ts";

/**
 * What the task pages load, in one place away from the components: every loader
 * here is a thin read through the domain layer, as the actor, and a test reads
 * the same functions to prove what a page can show.
 */

export function referenceData(actor: Actor) {
  return {
    labels: listLabels(actor),
    zones: listZones(actor),
    people: listAssignable(actor),
    maps: site().maps,
    today: dateOf(Date.now(), config.timezone),
    timezone: config.timezone,
  };
}

export interface ListQuery {
  view: "open" | "done";
  q: string;
  label: string;
  zone: string;
  mine: boolean;
}

export function parseListQuery(url: URL): ListQuery {
  const p = url.searchParams;
  return {
    view: p.get("view") === "done" ? "done" : "open",
    q: (p.get("q") ?? "").slice(0, 200),
    label: p.get("label") ?? "",
    zone: p.get("zone") ?? "",
    mine: p.get("mine") === "1",
  };
}

/** The home screen. */
export function indexData(actor: Actor, url: URL) {
  const query = parseListQuery(url);
  const me = personOf(actor);
  const tasks = listTasks(actor, {
    status: query.view,
    q: query.q || undefined,
    label: query.label || undefined,
    zone: query.zone || undefined,
    assignee: query.mine && me != null ? me : undefined,
    limit: query.view === "done" ? 100 : undefined,
  });
  return { tasks, query, ...referenceData(actor) };
}

/** One task, with what's around it. Throws NotFoundError for what the actor can't see. */
export function taskPageData(actor: Actor, id: string) {
  return {
    task: getTask(actor, id),
    comments: listComments(actor, id).map((c) => ({ ...c, when: whenText(c.at) })),
    attachments: listAttachments(actor, id),
    history: taskHistory(actor, id).map((e) => ({ ...e, when: whenText(e.at) })),
    ...referenceData(actor),
  };
}

/** Open tasks with a place on a map. */
export function mapPageData(actor: Actor) {
  return { tasks: listTasks(actor, { status: "open" }).filter((t) => t.location), ...referenceData(actor) };
}

export function activityData(actor: Actor) {
  return { events: activity(actor).map((e) => ({ ...e, when: whenText(e.at) })) };
}
