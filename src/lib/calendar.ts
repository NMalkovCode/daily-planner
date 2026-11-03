// Calendar layout: which days a view shows, which lane each bar sits in,
// and how overlapping timed tasks share a column. Pure functions, no React.

import type { Task } from "./api";
import { addDays, formatDate, parseDate } from "./dates";
import { daysBetween } from "./format";

/** 0 = Sunday, 1 = Monday. */
export const WEEK_START = 1;

export function startOfWeek(s: string, weekStart = WEEK_START): string {
  const diff = (parseDate(s).getDay() - weekStart + 7) % 7;
  return addDays(s, -diff);
}

export function weekDays(s: string, weekStart = WEEK_START): string[] {
  const start = startOfWeek(s, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The weeks (rows of 7 days) a month view shows for the month containing `s`. */
export function monthWeeks(s: string, weekStart = WEEK_START): string[][] {
  const d = parseDate(s);
  const last = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const weeks: string[][] = [];
  let cur = startOfWeek(formatDate(new Date(d.getFullYear(), d.getMonth(), 1)), weekStart);
  while (cur <= last) {
    weeks.push(weekDays(cur, weekStart));
    cur = addDays(cur, 7);
  }
  return weeks;
}

export function addMonths(s: string, n: number): string {
  const d = parseDate(s);
  return formatDate(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

/** Something drawn in a day/week row: a task (one day or a span) or a deadline marker. */
export interface CalItem {
  key: string;
  task: Task;
  kind: "task" | "deadline";
  start: string;
  end: string;
}

export function taskItem(t: Task): CalItem {
  return { key: `t${t.id}`, task: t, kind: "task", start: t.date!, end: t.endDate ?? t.date! };
}

/** Deadline markers for tasks whose deadline isn't already on the task's own day. */
export function deadlineItems(tasks: Task[]): CalItem[] {
  return tasks
    .filter((t) => t.deadline && t.deadline.slice(0, 10) !== t.date)
    .map((t) => {
      const day = t.deadline!.slice(0, 10);
      return { key: `d${t.id}`, task: t, kind: "deadline", start: day, end: day };
    });
}

export const isSpan = (i: CalItem) => i.end > i.start;

export interface Segment {
  item: CalItem;
  startCol: number;
  span: number;
  lane: number;
  /** false when the bar continues from the previous row (flat left edge) */
  startsHere: boolean;
  /** false when the bar continues on the next row (flat right edge) */
  endsHere: boolean;
}

function rowOrder(a: CalItem, b: CalItem): number {
  return (
    Number(isSpan(b)) - Number(isSpan(a)) || // multi-day bars take the top lanes
    a.start.localeCompare(b.start) ||
    b.end.localeCompare(a.end) || // longer first
    Number(a.kind === "deadline") - Number(b.kind === "deadline") ||
    Number(a.task.startTime == null) - Number(b.task.startTime == null) ||
    (a.task.startTime ?? "").localeCompare(b.task.startTime ?? "") ||
    a.task.id - b.task.id
  );
}

/** Packs items into lanes for one row of consecutive `days`. */
export function layoutRow(items: CalItem[], days: string[]): { segments: Segment[]; laneCount: number } {
  const first = days[0];
  const last = days[days.length - 1];
  const lanes: boolean[][] = [];
  const segments: Segment[] = [];

  for (const item of items.filter((i) => i.start <= last && i.end >= first).sort(rowOrder)) {
    const startCol = Math.max(0, daysBetween(first, item.start));
    const endCol = Math.min(days.length - 1, daysBetween(first, item.end));
    let lane = lanes.findIndex((occupied) => !occupied.slice(startCol, endCol + 1).some(Boolean));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(new Array(days.length).fill(false));
    }
    lanes[lane].fill(true, startCol, endCol + 1);
    segments.push({
      item,
      startCol,
      span: endCol - startCol + 1,
      lane,
      startsHere: item.start >= first,
      endsHere: item.end <= last,
    });
  }
  return { segments, laneCount: lanes.length };
}

/**
 * When a row has more lanes than fit, keeps `maxLanes - 1` lanes and returns
 * how many items each day hides (shown as "+N more" in the last lane).
 */
export function overflow(
  segments: Segment[],
  laneCount: number,
  maxLanes: number,
  dayCount: number,
): { visible: Segment[]; hidden: number[] } {
  if (laneCount <= maxLanes) return { visible: segments, hidden: new Array(dayCount).fill(0) };
  const keep = Math.max(0, maxLanes - 1);
  const hidden = new Array(dayCount).fill(0);
  for (const s of segments) {
    if (s.lane < keep) continue;
    for (let c = s.startCol; c < s.startCol + s.span; c++) hidden[c]++;
  }
  return { visible: segments.filter((s) => s.lane < keep), hidden };
}

// ---- timed tasks (week / day grid) ----

export const DEFAULT_DURATION = 30;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const fromMinutes = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export interface TimedBlock {
  task: Task;
  startMin: number;
  endMin: number;
  col: number;
  cols: number;
}

/** Side-by-side columns for overlapping timed tasks on one day. */
export function layoutTimed(tasks: Task[]): TimedBlock[] {
  const blocks = tasks
    .filter((t) => t.startTime)
    .map((t) => {
      const startMin = toMinutes(t.startTime!);
      return { task: t, startMin, endMin: Math.min(24 * 60, startMin + (t.durationMin ?? DEFAULT_DURATION)), col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.task.id - b.task.id);

  let cluster: TimedBlock[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => cluster.forEach((b) => (b.cols = colEnds.length));

  for (const b of blocks) {
    if (b.startMin >= clusterEnd) {
      close();
      cluster = [];
      colEnds = [];
    }
    let col = colEnds.findIndex((end) => end <= b.startMin);
    if (col === -1) col = colEnds.push(0) - 1;
    colEnds[col] = b.endMin;
    b.col = col;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  close();
  return blocks;
}

// ---- colours ----

function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** Black or white, whichever reads better on `hex` (#rrggbb). */
export function textOn(hex: string): string {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#10131a" : "#ffffff";
}
