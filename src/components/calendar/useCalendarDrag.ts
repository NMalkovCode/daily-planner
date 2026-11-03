// Dragging in the calendar: move a task or project, drag either end of a bar
// to change its start/end date, or move/resize a timed task in the time grid.
// The day (and minute, in the time grid) under the pointer is found from the
// `data-date` / `data-timecol` attributes on day cells and time columns.

import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { Task } from "../../lib/api";
import { DEFAULT_DURATION, fromMinutes, toMinutes } from "../../lib/calendar";
import { addDays } from "../../lib/dates";
import { daysBetween } from "../../lib/format";

export type DragKind = "move" | "start" | "end" | "timeMove" | "timeResize";

export const HOUR_PX = 48;
export const PX_PER_MIN = HOUR_PX / 60;
const SNAP_MIN = 15;
const DAY_MIN = 24 * 60;

interface Hit {
  date: string;
  /** minutes since midnight, only inside a time-grid column */
  min: number | null;
}

interface Drag {
  task: Task;
  kind: DragKind;
  grab: Hit;
  x0: number;
  y0: number;
  moved: boolean;
  preview: Partial<Task> | null;
}

function hitTest(x: number, y: number): Hit | null {
  const el = document
    .elementsFromPoint(x, y)
    .find((e): e is HTMLElement => e instanceof HTMLElement && e.dataset.date != null);
  if (!el) return null;
  const min = el.dataset.timecol != null ? (y - el.getBoundingClientRect().top) / PX_PER_MIN : null;
  return { date: el.dataset.date!, min };
}

const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function preview(d: Drag, hit: Hit): Partial<Task> | null {
  const t = d.task;
  const start = t.date!;
  const end = t.endDate ?? start;
  switch (d.kind) {
    case "move": {
      const delta = daysBetween(d.grab.date, hit.date);
      return { date: addDays(start, delta), endDate: t.endDate ? addDays(end, delta) : null };
    }
    case "start": {
      const s = hit.date < end ? hit.date : end;
      return { date: s, endDate: s === end ? null : end };
    }
    case "end": {
      const e = hit.date > start ? hit.date : start;
      return { date: start, endDate: e === start ? null : e };
    }
    case "timeMove": {
      if (hit.min == null || d.grab.min == null) return null;
      const s = clamp(snap(toMinutes(t.startTime!) + hit.min - d.grab.min), 0, DAY_MIN - SNAP_MIN);
      return { date: hit.date, startTime: fromMinutes(s) };
    }
    case "timeResize": {
      if (hit.min == null) return null;
      const s = toMinutes(t.startTime!);
      return { durationMin: clamp(snap(hit.min), s + SNAP_MIN, DAY_MIN) - s };
    }
  }
}

/** True if the preview actually changes the task. */
function changes(t: Task, p: Partial<Task>): boolean {
  return (Object.keys(p) as (keyof Task)[]).some((k) => {
    const current = k === "durationMin" ? (t.durationMin ?? DEFAULT_DURATION) : t[k];
    return p[k] !== current;
  });
}

export function useCalendarDrag(
  onCommit: (task: Task, changes: Partial<Task>) => void,
  onClick: (task: Task) => void,
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const handlers = useRef({ onCommit, onClick });
  handlers.current = { onCommit, onClick };
  /** Set briefly after a drag so the click that follows doesn't create a task. */
  const justDragged = useRef(false);

  const begin = (e: ReactPointerEvent, task: Task, kind: DragKind) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grab = hitTest(e.clientX, e.clientY);
    if (grab) setDrag({ task, kind, grab, x0: e.clientX, y0: e.clientY, moved: false, preview: null });
  };

  const active = drag != null;
  useEffect(() => {
    if (!active) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current!;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      const hit = hitTest(e.clientX, e.clientY);
      setDrag({ ...d, moved: true, preview: (hit && preview(d, hit)) ?? d.preview });
    };
    const up = () => {
      const d = dragRef.current!;
      setDrag(null);
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      if (!d.moved) handlers.current.onClick(d.task);
      else if (d.preview && changes(d.task, d.preview)) handlers.current.onCommit(d.task, d.preview);
    };
    const cancel = (e: KeyboardEvent) => e.key === "Escape" && setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", cancel);
    };
  }, [active]);

  return {
    begin,
    /** the task being dragged and where it would land */
    dragged: drag?.moved ? { id: drag.task.id, preview: drag.preview, kind: drag.kind } : null,
    justDragged,
  };
}
