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
 * Dates here are wall-clock dates, so the arithmetic is on day numbers and DST
 * can't come into it.
 *
 * The search for the next date is done here, not by the rrule library. The
 * library's iterator only checks its limits when a date matches, so a rule that
 * never matches ran through to the year 9999, and one bad rule stopped the whole
 * process for 26 seconds. This evaluator has a hard cutoff and a budget. The
 * library still words a rule for people, and a test holds the two to the same
 * answers.
 */

export type RecurrenceSpec = { kind: "schedule"; rrule: string; anchorDate: string } | { kind: "after_completion"; intervalDays: number };

/** A rule with no occurrence this far ahead is taken to be impossible (February 30th). */
const HORIZON_DAYS = 3660;
/** The most candidate days one search may look at. A hard stop, however odd the rule. */
const DAY_BUDGET = 200_000;

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface Rule {
  freq: Freq;
  interval: number;
  count: number | null;
  /** 'YYYY-MM-DD', inclusive. */
  until: string | null;
  byMonth: number[] | null;
  byMonthDay: number[] | null;
  /** weekday 0 = Sunday; n = 0 means every one. */
  byDay: { weekday: number; n: number }[] | null;
  bySetPos: number[] | null;
  /** 0 = Sunday. */
  wkst: number;
}

const bad = (message: string) => new UserInputError(message);

function intList(value: string, key: string, min: number, max: number, allowNegative = false): number[] {
  return value.split(",").map((part) => {
    if (!/^[+-]?\d{1,4}$/.test(part)) throw bad(`"${key}" needs numbers.`);
    const n = Number(part);
    const size = Math.abs(n);
    if (size < min || size > max || (n < 0 && !allowNegative) || n === 0) throw bad(`"${key}" has a number out of range.`);
    return n;
  });
}

function parseUntil(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(value);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  if (!isDate(date)) throw bad("UNTIL needs a date, like 20271231.");
  return date;
}

function compile(rrule: string): Rule {
  const rule: Rule = { freq: "DAILY", interval: 1, count: null, until: null, byMonth: null, byMonthDay: null, byDay: null, bySetPos: null, wkst: 1 };
  for (const part of rrule.split(";")) {
    const [key, value = ""] = part.split("=") as [string, string?];
    switch (key) {
      case "FREQ":
        rule.freq = value as Freq;
        break;
      case "INTERVAL":
        rule.interval = intList(value, key, 1, 1000)[0]!;
        break;
      case "COUNT":
        rule.count = intList(value, key, 1, 9999)[0]!;
        break;
      case "UNTIL":
        rule.until = parseUntil(value);
        break;
      case "BYMONTH":
        rule.byMonth = intList(value, key, 1, 12);
        break;
      case "BYMONTHDAY":
        rule.byMonthDay = intList(value, key, 1, 31, true);
        break;
      case "BYSETPOS":
        rule.bySetPos = intList(value, key, 1, 366, true);
        break;
      case "WKST":
        rule.wkst = WEEKDAYS.indexOf(value);
        if (rule.wkst < 0) throw bad("WKST needs a weekday, like MO.");
        break;
      case "BYDAY":
        rule.byDay = value.split(",").map((item) => {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
          const n = Number(m?.[1] ?? 0);
          if (!m || Math.abs(n) > 53) throw bad(`"${item}" isn't a day, like MO or 1MO.`);
          return { weekday: WEEKDAYS.indexOf(m[2]!), n };
        });
        break;
    }
  }
  return rule;
}

const ALLOWED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST", "COUNT", "UNTIL"]);
const ALLOWED_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

/**
 * Normalise an RRULE string: optional "RRULE:" prefix, upper case. Only
 * calendar-day parts are allowed, since a task's due date is a day. Throws a
 * message fit for whoever typed it.
 */
export function parseRrule(raw: string): string {
  const text = raw.trim().replace(/^RRULE:/i, "").toUpperCase();
  if (!text || text.length > 200) throw bad("Enter a repeat rule, like FREQ=MONTHLY;BYDAY=1MO.");
  const parts = text.split(";").filter(Boolean);
  const seen = new Set<string>();
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (!key || !value || !ALLOWED_KEYS.has(key)) throw bad(`Repeat rules can't use "${key ?? part}".`);
    if (seen.has(key)) throw bad(`"${key}" appears twice in the repeat rule.`);
    seen.add(key);
    if (key === "FREQ" && !ALLOWED_FREQ.has(value)) throw bad("Repeat rules go by day, week, month or year.");
  }
  if (!seen.has("FREQ")) throw bad("A repeat rule needs a FREQ, like FREQ=WEEKLY.");
  const normal = parts.join(";");
  compile(normal);
  return normal;
}

// ---- day numbers ---------------------------------------------------------------------

/** Days since 1970-01-01. */
const toDay = (date: string) => dateToUtc(date).getTime() / 86_400_000;
const fromDay = (day: number) => utcToDate(new Date(day * 86_400_000));

function ymd(day: number): { y: number; m: number; d: number; weekday: number } {
  const date = new Date(day * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), weekday: date.getUTCDay() };
}

const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const monthLength = (y: number, m: number) => dayOf(y, m + 1, 1) - dayOf(y, m, 1);

/** Is this the nth weekday of the span? n < 0 counts from its end. */
function isNth(day: number, weekday: number, n: number, first: number, last: number): boolean {
  if (ymd(day).weekday !== weekday) return false;
  if (n > 0) return Math.floor((day - first) / 7) === n - 1;
  return Math.floor((last - day) / 7) === -n - 1;
}

/** The dates of one period that pass the rule's filters, in order. */
function periodDays(rule: Rule, first: number, last: number, anchor: ReturnType<typeof ymd>): number[] {
  // RFC 5545: what isn't said comes from the start date.
  const needsDay = !rule.byDay && !rule.byMonthDay;
  const byMonthDay = rule.byMonthDay ?? (needsDay && (rule.freq === "MONTHLY" || rule.freq === "YEARLY") ? [anchor.d] : null);
  const byDay = rule.byDay ?? (needsDay && rule.freq === "WEEKLY" ? [{ weekday: anchor.weekday, n: 0 }] : null);
  const byMonth = rule.byMonth ?? (needsDay && rule.freq === "YEARLY" ? [anchor.m] : null);

  const out: number[] = [];
  for (let day = first; day <= last; day++) {
    const { y, m, d, weekday } = ymd(day);
    if (byMonth && !byMonth.includes(m)) continue;
    if (byMonthDay) {
      const length = monthLength(y, m);
      if (!byMonthDay.some((n) => (n > 0 ? n === d : length + n + 1 === d))) continue;
    }
    if (byDay) {
      // An ordinal counts within the month, or the year for a yearly rule with no months.
      const inYear = rule.freq === "YEARLY" && !rule.byMonth;
      const spanFirst = inYear ? dayOf(y, 1, 1) : dayOf(y, m, 1);
      const spanLast = inYear ? dayOf(y + 1, 1, 1) - 1 : dayOf(y, m + 1, 1) - 1;
      if (!byDay.some((b) => (b.n === 0 ? b.weekday === weekday : isNth(day, b.weekday, b.n, spanFirst, spanLast)))) continue;
    }
    out.push(day);
  }
  if (!rule.bySetPos) return out;
  const positions = rule.bySetPos.map((p) => (p > 0 ? out[p - 1] : out[out.length + p])).filter((d): d is number => d !== undefined);
  return [...new Set(positions)].sort((a, b) => a - b);
}

/** The first and last day of period k, counted from the one holding the anchor. */
function periodSpan(rule: Rule, anchorDay: number, a: ReturnType<typeof ymd>, k: number): [number, number] {
  const step = k * rule.interval;
  switch (rule.freq) {
    case "DAILY":
      return [anchorDay + step, anchorDay + step];
    case "WEEKLY": {
      const start = anchorDay - ((a.weekday - rule.wkst + 7) % 7) + step * 7;
      return [start, start + 6];
    }
    case "MONTHLY": {
      const first = dayOf(a.y, a.m + step, 1);
      return [first, dayOf(a.y, a.m + step + 1, 1) - 1];
    }
    case "YEARLY":
      return [dayOf(a.y + step, 1, 1), dayOf(a.y + step + 1, 1, 1) - 1];
  }
}

/** How many periods can be skipped to reach `day`, when nothing needs counting. */
function periodsToSkip(rule: Rule, anchorDay: number, a: ReturnType<typeof ymd>, day: number): number {
  const b = ymd(day);
  const whole =
    rule.freq === "DAILY"
      ? day - anchorDay
      : rule.freq === "WEEKLY"
        ? Math.floor((day - anchorDay) / 7)
        : rule.freq === "MONTHLY"
          ? (b.y - a.y) * 12 + (b.m - a.m)
          : b.y - a.y;
  return Math.max(0, Math.floor(whole / rule.interval) - 1);
}

/** The first date of the rule strictly after `after`, or null when there isn't one in reach. */
export function nextScheduled(rrule: string, anchorDate: string, after: string): string | null {
  const rule = compile(rrule);
  const anchorDay = toDay(anchorDate);
  const anchor = ymd(anchorDay);
  const afterDay = toDay(after);
  const horizon = Math.max(afterDay, anchorDay) + HORIZON_DAYS;
  const until = rule.until ? toDay(rule.until) : Number.POSITIVE_INFINITY;

  // COUNT numbers every occurrence from the start, so those have to be walked.
  let k = rule.count == null ? periodsToSkip(rule, anchorDay, anchor, afterDay) : 0;
  let counted = 0;
  let budget = DAY_BUDGET;
  for (; budget > 0; k++) {
    const [first, last] = periodSpan(rule, anchorDay, anchor, k);
    if (first > horizon || first > until) return null;
    budget -= last - first + 1;
    for (const day of periodDays(rule, first, last, anchor)) {
      if (day < anchorDay) continue;
      if (day > until || day > horizon) return null;
      counted++;
      if (rule.count != null && counted > rule.count) return null;
      if (day > afterDay) return fromDay(day);
    }
  }
  return null;
}

/** The first date of the rule on or after `date`. */
export function firstScheduled(rrule: string, anchorDate: string, date: string): string | null {
  return nextScheduled(rrule, anchorDate, addDays(date, -1));
}

/** Check a rule can produce a date at all. Returns the first. */
export function validateSchedule(rrule: string, anchorDate: string): string {
  const first = firstScheduled(rrule, anchorDate, anchorDate);
  if (!first) throw bad("That repeat rule never lands on a date.");
  return first;
}

export function validateInterval(days: unknown): number {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > RECURRENCE_MAX_INTERVAL_DAYS) {
    throw bad(`Repeat after 1 to ${RECURRENCE_MAX_INTERVAL_DAYS} days.`);
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

/** "every month on the 1st Monday", "30 days after it's done". */
export function describeRecurrence(spec: RecurrenceSpec): string {
  if (spec.kind === "after_completion") {
    return spec.intervalDays === 1 ? "every day after it's done" : `${spec.intervalDays} days after it's done`;
  }
  try {
    return new RRule({ ...RRule.parseString(spec.rrule), dtstart: dateToUtc(spec.anchorDate) }).toText();
  } catch {
    return spec.rrule;
  }
}

export function isValidAnchor(value: unknown): value is string {
  return isDate(value);
}
