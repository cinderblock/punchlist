/**
 * Wall-clock helpers. Pure, so the browser and the server format identically.
 *
 * Everything hinges on one distinction: an *instant* (epoch ms, UTC) versus a
 * *date* (a calendar day in the deployment's zone). Evening in
 * America/Los_Angeles is already tomorrow in UTC, so a date is never derived
 * with `toISOString().slice(0, 10)`, and adding days to a date is done on the
 * date, not on an instant, so DST never moves it.
 *
 * Every function takes the zone explicitly. The server gets it from
 * `config.timezone`, the browser from the root loader.
 */

/** 'YYYY-MM-DD' for an instant, in the zone. */
export function dateOf(instant: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is what we want and what sorts.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date, not merely the right shape. */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The date as a UTC-midnight Date: a neutral carrier for calendar arithmetic. */
export function dateToUtc(date: string): Date {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function utcToDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = dateToUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToDate(d);
}

/** Whole days from `a` to `b`: positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateToUtc(b).getTime() - dateToUtc(a).getTime()) / 86_400_000);
}

/** "Mon, Nov 2", with the year when it isn't this year's. */
export function formatDate(date: string, today?: string): string {
  const d = dateToUtc(date);
  const sameYear = today ? today.slice(0, 4) === date.slice(0, 4) : true;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** "Today", "Tomorrow", "Yesterday", or the date. For a due date in a list. */
export function formatDue(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return formatDate(date, today);
}

/** "1:54 PM". */
export function formatClock(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(instant));
}

/** "PDT", "PST": the zone's abbreviation at that instant. */
export function zoneName(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(instant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "Mon, Nov 2, 1:54 PM PST". */
export function formatInstant(instant: number, timeZone: string, today?: string): string {
  return `${formatDate(dateOf(instant, timeZone), today)}, ${formatClock(instant, timeZone)} ${zoneName(instant, timeZone)}`;
}

/** Minutes past midnight in the zone. */
export function minutesOfDay(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(
    new Date(instant),
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** "17:30" to minutes past midnight. */
export function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h) * 60 + Number(m);
}

/** "17:30" to "5:30 PM". */
export function formatClockValue(clock: string): string {
  const minutes = clockToMinutes(clock);
  const hour = Math.floor(minutes / 60);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}
