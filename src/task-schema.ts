import { z } from "zod";

import {
  COMMENT_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
  DETAILS_MAX_LENGTH,
  LOCATION_NOTE_MAX_LENGTH,
  RECURRENCE_MAX_INTERVAL_DAYS,
  TASK_LIST_MAX_LIMIT,
  TITLE_MAX_LENGTH,
} from "./limits.ts";
import { isDate } from "./time.ts";
import { UUID_PATTERN } from "./uuid.ts";

/**
 * The shapes tasks are written in, shared by REST, MCP and the UI so there's one
 * definition of a valid task. Pure: the browser imports this for its form.
 */

const dateString = z.string().refine((v) => isDate(v), "a date like 2026-11-02");
const trimmedTitle = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "A task needs a title.").max(TITLE_MAX_LENGTH));

export const locationSchema = z.strictObject({
  mapId: z.string().max(64).nullish(),
  x: z.number().finite().nullish(),
  y: z.number().finite().nullish(),
  zoneId: z.string().max(64).nullish(),
  note: z.string().trim().max(LOCATION_NOTE_MAX_LENGTH).nullish(),
});
export type LocationInput = z.infer<typeof locationSchema>;

export const recurrenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("schedule"),
    /** An RRULE, such as FREQ=MONTHLY;BYDAY=1MO. */
    rrule: z.string().min(1).max(200),
    /** Which date the rule counts from. Defaults to the due date, or today. */
    anchorDate: dateString.optional(),
  }),
  z.strictObject({
    kind: z.literal("after_completion"),
    intervalDays: z.number().int().min(1).max(RECURRENCE_MAX_INTERVAL_DAYS),
  }),
]);
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;

const labelRefs = z.array(z.union([z.string().min(1).max(64), z.number().int()])).max(32);
const userIds = z.array(z.number().int().positive()).max(64);

export const taskCreateSchema = z.strictObject({
  /** A client-generated UUID, so a task made offline keeps its identity. */
  id: z.string().regex(UUID_PATTERN).optional(),
  title: trimmedTitle,
  details: z.string().max(DETAILS_MAX_LENGTH).default(""),
  visibility: z.enum(["public", "private"]).default("public"),
  dueDate: dateString.nullish(),
  /** Label names (any case) or ids. */
  labels: labelRefs.default([]),
  assignees: userIds.default([]),
  sharedWith: userIds.default([]),
  location: locationSchema.nullish(),
  recurrence: recurrenceSchema.nullish(),
  /**
   * For automated tasks: while a task with this key is open, creating another
   * updates that one instead of adding a duplicate.
   */
  dedupeKey: z.string().trim().min(1).max(DEDUPE_KEY_MAX_LENGTH).nullish(),
});
export type TaskCreateInput = z.input<typeof taskCreateSchema>;

export const taskUpdateSchema = z
  .strictObject({
    title: trimmedTitle.optional(),
    details: z.string().max(DETAILS_MAX_LENGTH).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    dueDate: dateString.nullish(),
    labels: labelRefs.optional(),
    assignees: userIds.optional(),
    sharedWith: userIds.optional(),
    location: locationSchema.nullish(),
    /** null stops the repeating. */
    recurrence: recurrenceSchema.nullish(),
    /** The revision being edited. A stale one is refused, not silently overwritten. */
    expectedRev: z.number().int().positive().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "expectedRev"), "Nothing to change.");
export type TaskUpdateInput = z.input<typeof taskUpdateSchema>;

export const completeSchema = z.strictObject({
  /** An optional note, kept as a comment where the actor may comment and on the event regardless. */
  note: z.string().trim().max(COMMENT_MAX_LENGTH).optional(),
  /** When it was really done (a queued check-off). Bounded on the server. */
  at: z.number().int().positive().optional(),
});
export type CompleteInput = z.input<typeof completeSchema>;

export const commentSchema = z.strictObject({
  id: z.string().regex(UUID_PATTERN).optional(),
  body: z.string().trim().min(1, "Say something first.").max(COMMENT_MAX_LENGTH),
});

export const listFilterSchema = z.strictObject({
  status: z.enum(["open", "done", "all"]).default("open"),
  q: z.string().trim().max(200).optional(),
  /** Label name or id. */
  label: z.union([z.string().max(64), z.number().int()]).optional(),
  zone: z.string().max(64).optional(),
  /** A user id. */
  assignee: z.number().int().positive().optional(),
  /** Tasks with nobody assigned. */
  unassigned: z.boolean().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  /** Only tasks due on or before this date. */
  dueBy: dateString.optional(),
  limit: z.number().int().min(1).max(TASK_LIST_MAX_LIMIT).optional(),
});
export type ListFilter = z.input<typeof listFilterSchema>;
