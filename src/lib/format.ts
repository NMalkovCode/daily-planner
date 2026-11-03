// Human-readable labels for dates, times and deadlines (en-GB, 24-hour).

import { parseDate } from "./dates";

const LOCALE = "en-GB";

/** "Tuesday 3 November" */
export function longDate(s: string): string {
  return parseDate(s).toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
}

/** "Tue 3 Nov" */
export function shortDate(s: string): string {
  return parseDate(s).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
}

/** Whole calendar days from `a` to `b` (negative if `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "in 3 days", "2 days ago", or a short date when it's far off. */
export function relativeDay(today: string, s: string): string {
  const n = daysBetween(today, s);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return `in ${n} days`;
  if (n < -1 && n > -7) return `${-n} days ago`;
  return shortDate(s);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "09:00–10:30", or just "09:00" with no duration. */
export function timeRange(start: string, durationMin: number | null): string {
  if (!durationMin) return start;
  const [h, m] = start.split(":").map(Number);
  const end = h * 60 + m + durationMin;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${start}–${pad(Math.floor(end / 60) % 24)}:${pad(end % 60)}`;
}

/** "1h 30m", "45m" */
export function duration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ");
}

export type Tone = "danger" | "warn" | "accent" | "neutral";

export function deadlineLabel(today: string, deadline: string): { text: string; tone: Tone } {
  const day = deadline.slice(0, 10);
  const time = deadline.length > 10 ? ` ${deadline.slice(11)}` : "";
  const n = daysBetween(today, day);
  if (n < 0) return { text: `Overdue by ${plural(-n, "day")}`, tone: "danger" };
  if (n === 0) return { text: `Due today${time}`, tone: "warn" };
  if (n === 1) return { text: `Due tomorrow${time}`, tone: "warn" };
  if (n < 7) return { text: `Due ${shortDate(day)}${time}`, tone: "accent" };
  return { text: `Due ${shortDate(day)}`, tone: "neutral" };
}
