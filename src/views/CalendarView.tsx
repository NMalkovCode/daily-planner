import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { DATE_H, LANE_H, SpanRow } from "../components/calendar/SpanRow";
import { TimeGrid } from "../components/calendar/TimeGrid";
import { useCalendarDrag } from "../components/calendar/useCalendarDrag";
import { api, Task, taskToInput } from "../lib/api";
import { addMonths, CalItem, deadlineItems, monthWeeks, taskItem, weekDays } from "../lib/calendar";
import { addDays, parseDate } from "../lib/dates";
import { longDate } from "../lib/format";
import { usePlanner } from "../lib/planner";

type Mode = "month" | "week" | "day";
const MODES: Mode[] = ["month", "week", "day"];
const MODE_KEY = "calendar.mode";

function savedMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY) as Mode | null;
    return m && MODES.includes(m) ? m : "month";
  } catch {
    return "month";
  }
}

const fmt = (s: string, o: Intl.DateTimeFormatOptions) => parseDate(s).toLocaleDateString("en-GB", o);

export function CalendarView() {
  const { today, version, refresh, notify, openEditor, editor, weekStart } = usePlanner();
  const [mode, setModeState] = useState<Mode>(savedMode);
  const [anchor, setAnchor] = useState(today);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [deadlines, setDeadlines] = useState<Task[]>([]);
  /** Dates/times saved by a drag, shown until the reload brings them back. */
  const [pending, setPending] = useState<Record<number, Partial<Task>>>({});

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* per-viewer convenience only */
    }
  };

  const weeks = useMemo(() => monthWeeks(anchor, weekStart), [anchor, weekStart]);
  const days = useMemo(
    () => (mode === "month" ? weeks.flat() : mode === "week" ? weekDays(anchor, weekStart) : [anchor]),
    [mode, weeks, anchor, weekStart],
  );
  const from = days[0];
  const to = days[days.length - 1];

  useEffect(() => {
    let live = true;
    Promise.all([api.tasksBetween(from, to), api.deadlinesBetween(from, to)])
      .then(([t, d]) => {
        if (!live) return;
        setTasks(t);
        setDeadlines(d);
        setPending({});
      })
      .catch((e) => notify(String(e)));
    return () => {
      live = false;
    };
  }, [from, to, version, notify]);

  async function commit(task: Task, changes: Partial<Task>) {
    setPending((p) => ({ ...p, [task.id]: changes }));
    try {
      if ("startTime" in changes || "durationMin" in changes) {
        await api.updateTask(task.id, { ...taskToInput(task), ...changes });
      } else {
        await api.setTaskDates(task.id, changes.date ?? null, changes.endDate ?? null);
      }
    } catch (e) {
      notify(String(e));
    }
    refresh();
  }

  const drag = useCalendarDrag(commit, (task) => openEditor({ task }));

  const shown = useMemo(
    () =>
      tasks.map((t) => {
        const p = drag.dragged?.id === t.id ? drag.dragged.preview : pending[t.id];
        return p ? { ...t, ...p } : t;
      }),
    [tasks, pending, drag.dragged],
  );

  const items: CalItem[] = useMemo(() => {
    const spanOrUntimed = mode === "month" ? shown : shown.filter((t) => t.endDate || !t.startTime);
    return [...spanOrUntimed.filter((t) => t.date).map(taskItem), ...deadlineItems(deadlines)];
  }, [mode, shown, deadlines]);
  const timed = useMemo(() => shown.filter((t) => t.startTime && !t.endDate), [shown]);

  const step = (dir: number) =>
    setAnchor((a) => (mode === "month" ? addMonths(a, dir) : addDays(a, mode === "week" ? 7 * dir : dir)));
  const showDay = (d: string) => {
    setAnchor(d);
    setMode("day");
  };

  // ← → previous/next, T today, M/W/D switch view
  const keys = useRef({ step, setMode, setAnchor, today });
  keys.current = { step, setMode, setAnchor, today };
  useEffect(() => {
    if (editor) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.ctrlKey || e.altKey || target.closest("input, textarea, select")) return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      if (e.key === "ArrowLeft") k.step(-1);
      else if (e.key === "ArrowRight") k.step(1);
      else if (key === "t") k.setAnchor(k.today);
      else if (key === "m") k.setMode("month");
      else if (key === "w") k.setMode("week");
      else if (key === "d") k.setMode("day");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  const title =
    mode === "month"
      ? fmt(anchor, { month: "long", year: "numeric" })
      : mode === "week"
        ? `${fmt(from, { day: "numeric", month: "short" })} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`
        : `${longDate(anchor)} ${parseDate(anchor).getFullYear()}`;

  const newTaskDate = from <= today && today <= to ? today : mode === "month" ? addMonths(anchor, 0) : from;
  const dayClick = (date: string) => !drag.justDragged.current && openEditor({ defaults: { date } });
  const draggedId = drag.dragged?.id ?? null;

  return (
    <div className={`calendar ${drag.dragged ? `dragging drag-${drag.dragged.kind}` : ""}`}>
      <header className="cal-toolbar">
        <button className="btn small" onClick={() => setAnchor(today)} title="Go to today (T)">Today</button>
        <div className="cal-arrows">
          <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous" title="Previous (←)">
            <Icon name="chevL" size={18} />
          </button>
          <button className="icon-btn" onClick={() => step(1)} aria-label="Next" title="Next (→)">
            <Icon name="chevR" size={18} />
          </button>
        </div>
        <h1>{title}</h1>
        <div className="segmented" role="tablist" aria-label="Calendar view">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn small primary" onClick={() => openEditor({ defaults: { date: newTaskDate } })}>
          <Icon name="plus" size={14} /> New task
        </button>
      </header>

      <div className="cal-body">
        {mode === "month" ? (
          <MonthGrid
            weeks={weeks}
            month={parseDate(anchor).getMonth()}
            items={items}
            draggedId={draggedId}
            onBeginDrag={drag.begin}
            onDayClick={dayClick}
            onShowDay={showDay}
          />
        ) : (
          <TimeGrid
            days={days}
            allDayItems={items}
            timed={timed}
            draggedId={draggedId}
            justDragged={drag.justDragged}
            onBeginDrag={drag.begin}
            onShowDay={showDay}
          />
        )}
      </div>
    </div>
  );
}

interface MonthProps {
  weeks: string[][];
  month: number;
  items: CalItem[];
  draggedId: number | null;
  onBeginDrag: ReturnType<typeof useCalendarDrag>["begin"];
  onDayClick: (date: string) => void;
  onShowDay: (date: string) => void;
}

function MonthGrid({ weeks, month, items, ...rowProps }: MonthProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = bodyRef.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxLanes = Math.max(1, Math.floor((height / weeks.length - DATE_H - 4) / LANE_H));

  return (
    <div className="month">
      <div className="month-head">
        {weeks[0].map((d) => (
          <div key={d}>{fmt(d, { weekday: "short" })}</div>
        ))}
      </div>
      <div className="month-body" ref={bodyRef} style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((w) => (
          <SpanRow key={w[0]} days={w} items={items} maxLanes={maxLanes} month={month} {...rowProps} />
        ))}
      </div>
    </div>
  );
}
