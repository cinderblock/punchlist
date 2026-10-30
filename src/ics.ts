import { addDays } from "./time.ts";

/**
 * A minimal RFC 5545 writer. All-day VEVENTs rather than VTODOs, because Google
 * Calendar ignores VTODO. All-day events are floating dates, so the calendar
 * shows them on the same day whatever zone it's in.
 */

export interface CalendarEvent {
  uid: string;
  title: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  updatedAt: number;
  description: string | null;
  location: string | null;
}

/** RFC 5545 section 3.3.11. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/** Fold at 75 octets, on a character boundary: a split UTF-8 sequence is a corrupt file. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // Continuation lines start with a space, which counts.
    const limit = out.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (instant: number) => new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const compactDate = (date: string) => date.replaceAll("-", "");

export function calendar(args: { name: string; host: string; now: number; events: readonly CalendarEvent[] }): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Punchlist//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(args.name)}`];
  for (const e of args.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@${args.host}`,
      `DTSTAMP:${stamp(e.updatedAt)}`,
      `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
      // DTEND is exclusive, so a one-day event ends the next day.
      `DTEND;VALUE=DATE:${compactDate(addDays(e.date, 1))}`,
      `SUMMARY:${escapeText(e.title)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
