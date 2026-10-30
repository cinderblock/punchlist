import { RRule } from "rrule";

import { UserInputError } from "./errors.ts";
import { RECURRENCE_MAX_INTERVAL_DAYS } from "./limits.ts";
import { addDays, dateToUtc, isDate, utcToDate } from "./time.ts";

/**
 * Two kinds of repeating, because they mean different things.
 *
 *   schedule          An RRULE ("first Monday"). The next due date doesn't
 *                     depend on when the last one was done.
 *   after_completion  An interval ("30 days after last done").
 *
 * Either way only one open occurrence exists (a unique index enforces it): a
 * missed filter change stays one overdue task and never piles up. A schedule
 * that has fallen behind therefore skips to its next date still ahead, rather
 * than to the date that was missed.
 *
 * Dates here are wall-clock dates. They travel through the rule library as
 * UTC-midnight Dates, which keeps DST out of it entirely.
 */

export type RecurrenceSpec = { kind: "schedule"; rrule: string; anchorDate: string } | { kind: "after_completion"; intervalDays: number };

/** A rule with no occurrence this far ahead is taken to be impossible (February 30th). */
const HORIZON_YEARS = 10;

const ALLOWED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST", "COUNT", "UNTIL"]);
const ALLOWED_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

/**
 * Normalise an RRULE string: optional "RRULE:" prefix, upper case. Only
 * calendar-day parts are allowed, since a task's due date is a day. Throws a
 * message fit for whoever typed it.
 */
export function parseRrule(raw: string): string {
  const text = raw.trim().replace(/^RRULE:/i, "").toUpperCase();
  if (!text || text.length > 200) throw new UserInputError("Enter a repeat rule, like FREQ=MONTHLY;BYDAY=1MO.");
  const parts = text.split(";").filter(Boolean);
  const seen = new Set<string>();
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (!key || !value || !ALLOWED_KEYS.has(key)) throw new UserInputError(`Repeat rules can't use "${key ?? part}".`);
    if (seen.has(key)) throw new UserInputError(`"${key}" appears twice in the repeat rule.`);
    seen.add(key);
    if (key === "FREQ" && !ALLOWED_FREQ.has(value)) throw new UserInputError("Repeat rules go by day, week, month or year.");
  }
  if (!seen.has("FREQ")) throw new UserInputError("A repeat rule needs a FREQ, like FREQ=WEEKLY.");
  return parts.join(";");
}

function ruleFor(rrule: string, anchorDate: string): RRule {
  try {
    return new RRule({ ...RRule.parseString(rrule), dtstart: dateToUtc(anchorDate) });
  } catch {
    throw new UserInputError("That repeat rule doesn't make sense.");
  }
}

/** The first date of the rule strictly after `after`, or null when it has ended. */
export function nextScheduled(rrule: string, anchorDate: string, after: string): string | null {
  const rule = ruleFor(rrule, anchorDate);
  const from = dateToUtc(after);
  const horizon = new Date(from);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + HORIZON_YEARS);
  // The iterator stops the search at the first hit. `between` with no iterator
  // would expand every date to the horizon, and `after` walks to year 9999 on
  // an impossible rule.
  const hits = rule.between(from, horizon, false, (_date, i) => i < 1);
  return hits[0] ? utcToDate(hits[0]) : null;
}

/** The first date of the rule on or after `date`. */
export function firstScheduled(rrule: string, anchorDate: string, date: string): string | null {
  return nextScheduled(rrule, anchorDate, addDays(date, -1));
}

/** Check a rule can produce a date at all. Returns the first. */
export function validateSchedule(rrule: string, anchorDate: string): string {
  const first = firstScheduled(rrule, anchorDate, anchorDate);
  if (!first) throw new UserInputError("That repeat rule never lands on a date.");
  return first;
}

export function validateInterval(days: unknown): number {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > RECURRENCE_MAX_INTERVAL_DAYS) {
    throw new UserInputError(`Repeat after 1 to ${RECURRENCE_MAX_INTERVAL_DAYS} days.`);
  }
  return days;
}

/**
 * When the occurrence after this one is due.
 *
 * `completed` is the day it was done, `due` the day it was due. A schedule
 * takes the first date past both, so finishing January's early gives February
 * rather than January again, and finishing January's in March gives April
 * rather than a February that's already over. Null means the rule has ended.
 */
export function nextDueDate(spec: RecurrenceSpec, completed: string, due: string | null): string | null {
  if (spec.kind === "after_completion") return addDays(completed, spec.intervalDays);
  const after = due && due > completed ? due : completed;
  return nextScheduled(spec.rrule, spec.anchorDate, after);
}

/** "every month on the 1st Monday", "every 30 days after it's done". */
export function describeRecurrence(spec: RecurrenceSpec): string {
  if (spec.kind === "after_completion") {
    return spec.intervalDays === 1 ? "every day after it's done" : `${spec.intervalDays} days after it's done`;
  }
  return ruleFor(spec.rrule, spec.anchorDate).toText();
}

export function isValidAnchor(value: unknown): value is string {
  return isDate(value);
}
