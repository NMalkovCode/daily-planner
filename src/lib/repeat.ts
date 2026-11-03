// Repeat rules, in the same format as src-tauri/src/db/recurrence.rs:
// "<freq>[/<interval>][:<weekdays>][;until=YYYY-MM-DD]", weekdays 1 = Mon … 7 = Sun.

import { parseDate } from "./dates";

export type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export interface RepeatRule {
  freq: Freq;
  interval: number;
  /** weekly only; empty = the weekday of the task's date */
  days: number[];
  until: string | null;
}

const FREQS: Freq[] = ["daily", "weekdays", "weekly", "monthly", "yearly"];
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function parseRule(s: string | null | undefined): RepeatRule | null {
  if (!s) return null;
  const [main, ...opts] = s.split(";");
  const [head, days] = main.split(":");
  const [name, every] = head.split("/");
  if (!FREQS.includes(name as Freq)) return null;
  const until = opts.find((o) => o.startsWith("until="))?.slice(6) ?? null;
  return {
    freq: name as Freq,
    interval: every ? Number(every) : 1,
    days: days ? days.split(",").map(Number) : [],
    until,
  };
}

export function formatRule(r: RepeatRule): string {
  let s: string = r.freq;
  if (r.interval > 1 && r.freq !== "weekdays") s += `/${r.interval}`;
  if (r.freq === "weekly" && r.days.length) s += `:${[...r.days].sort((a, b) => a - b).join(",")}`;
  if (r.until) s += `;until=${r.until}`;
  return s;
}

/** ISO weekday of a date string: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  return ((parseDate(date).getDay() + 6) % 7) + 1;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

const UNITS: Record<Freq, string> = { daily: "day", weekdays: "weekday", weekly: "week", monthly: "month", yearly: "year" };

export function unit(freq: Freq, n: number): string {
  return UNITS[freq] + (n === 1 ? "" : "s");
}

/** "Every weekday", "Every 2 weeks on Mon, Wed", "Every month on the 3rd until 1 Mar" */
export function describeRule(r: RepeatRule, date: string | null): string {
  const every = r.interval > 1 ? `Every ${r.interval} ${unit(r.freq, r.interval)}` : `Every ${UNITS[r.freq]}`;
  let s = every;
  if (r.freq === "weekly") {
    const days = r.days.length ? r.days : date ? [isoWeekday(date)] : [];
    if (days.length === 7) s = r.interval > 1 ? every : "Every day";
    else if (days.length) s += ` on ${days.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}`;
  } else if (r.freq === "monthly" && date) {
    s += ` on the ${ordinal(parseDate(date).getDate())}`;
  } else if (r.freq === "yearly" && date) {
    s += ` on ${parseDate(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  }
  if (r.until) s += ` until ${parseDate(r.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  return s;
}
