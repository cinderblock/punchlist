import { z } from "zod";

import { isDate } from "../time.ts";

/**
 * Each person's notification choices, as a schema. Pure (no database), so the
 * settings page's form can share it; storage is in store.ts.
 *
 * Stored as JSON and parsed through this schema, so a stored value from an
 * older version still reads: anything missing takes its default, anything
 * unknown is dropped.
 */

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock = (fallback: string) => z.string().regex(CLOCK, "A time like 17:00").catch(fallback);

/** A group of settings: missing or not an object reads as all defaults. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess((v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}), z.object(shape));

export const prefsSchema = z.object({
  /** A task was assigned to me. */
  assigned: z.boolean().catch(true),
  /** Someone commented on a task I own or am assigned to. */
  comments: z.boolean().catch(true),
  /** Admins: someone sent feedback, or a new error turned up. */
  reports: z.boolean().catch(true),
  /** My tasks coming due. */
  dueSoon: section({
    on: z.boolean().catch(true),
    /** How many days ahead counts as soon. 0: on the day. */
    days: z.number().int().min(0).max(14).catch(1),
    at: clock("08:00"),
  }),
  /** One message a day listing my overdue tasks. */
  overdueDigest: section({
    on: z.boolean().catch(true),
    at: clock("08:30"),
  }),
  /** New tasks in these labels and zones, whoever they're for. */
  watch: section({
    labels: z.array(z.number().int()).max(50).catch([]),
    zones: z.array(z.string().max(64)).max(50).catch([]),
  }),
  /** Nothing buzzes in this window; it waits, and goes when the window ends. */
  quietHours: section({
    on: z.boolean().catch(true),
    from: clock("21:00"),
    until: clock("07:00"),
  }),
  /** Nothing at all is sent through this date (inclusive). */
  pausedThrough: z
    .string()
    .refine((v) => isDate(v))
    .nullable()
    .catch(null),
});

export type NotificationPrefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: NotificationPrefs = prefsSchema.parse({});

/** Read anything (stored JSON, a form's JSON) as prefs, defaults filling the gaps. */
export function parsePrefs(value: unknown): NotificationPrefs {
  const result = prefsSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_PREFS;
}
