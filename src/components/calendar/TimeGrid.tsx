// Week and day views: an all-day strip (projects and untimed tasks as bars)
// above an hourly grid for tasks with a start time.

import { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "../../lib/api";
import { CalItem, fromMinutes, layoutTimed } from "../../lib/calendar";
import { parseDate } from "../../lib/dates";
import { timeRange } from "../../lib/format";
import { usePlanner } from "../../lib/planner";
import { Icon } from "../Icon";
import { SpanRow } from "./SpanRow";
import { DragKind, HOUR_PX, PX_PER_MIN } from "./useCalendarDrag";

const GUTTER = 56;
const FIRST_VISIBLE_HOUR = 7;

interface Props {
  days: string[];
  allDayItems: CalItem[];
  timed: Task[];
  draggedId: number | null;
  justDragged: RefObject<boolean>;
  onBeginDrag: (e: ReactPointerEvent, task: Task, kind: DragKind) => void;
  onShowDay: (date: string) => void;
}

function useNowMinutes(): number {
  const now = () => new Date().getHours() * 60 + new Date().getMinutes();
  const [min, setMin] = useState(now);
  useEffect(() => {
    const t = setInterval(() => setMin(now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return min;
}

export function TimeGrid({ days, allDayItems, timed, draggedId, justDragged, onBeginDrag, onShowDay }: Props) {
  const { today, openEditor, categoryById } = usePlanner();
  const scrollRef = useRef<HTMLDivElement>(null);
  const nowMin = useNowMinutes();
  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`;

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX - 8;
  }, [days.length]);

  function newAt(date: string, e: MouseEvent<HTMLDivElement>) {
    if (justDragged.current) return;
    const min = (e.clientY - e.currentTarget.getBoundingClientRect().top) / PX_PER_MIN;
    const start = Math.min(23 * 60, Math.floor(min / 30) * 30);
    openEditor({ defaults: { date, startTime: fromMinutes(start), durationMin: 60 } });
  }

  return (
    <div className="tg">
      <div className="tg-head" style={{ gridTemplateColumns: cols }}>
        <div />
        {days.map((d) => {
          const date = parseDate(d);
          return (
            <button key={d} className={`tg-day ${d === today ? "today" : ""}`} onClick={() => onShowDay(d)}>
              <span>{date.toLocaleDateString("en-GB", { weekday: "short" })}</span>
              <b>{date.getDate()}</b>
            </button>
          );
        })}
      </div>

      <div className="tg-allday" style={{ gridTemplateColumns: `${GUTTER}px minmax(0, 1fr)` }}>
        <div className="tg-gutter-label">All day</div>
        <SpanRow
          days={days}
          items={allDayItems}
          draggedId={draggedId}
          onBeginDrag={onBeginDrag}
          onDayClick={(date) => !justDragged.current && openEditor({ defaults: { date } })}
        />
      </div>

      <div className="tg-scroll" ref={scrollRef}>
        <div className="tg-body" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          <div className="tg-hours">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} style={{ top: (i + 1) * HOUR_PX }}>{fromMinutes((i + 1) * 60)}</span>
            ))}
          </div>
          {days.map((d) => (
            <div key={d} className={`tg-col ${d === today ? "today" : ""}`} data-date={d} data-timecol="" onClick={(e) => newAt(d, e)}>
              {layoutTimed(timed.filter((t) => t.date === d)).map((b) => {
                const t = b.task;
                const colour = categoryById(t.categoryId)?.colour ?? "#4f5bd5";
                const height = Math.max((b.endMin - b.startMin) * PX_PER_MIN, 20);
                const style: CSSProperties & Record<string, string | number> = {
                  top: b.startMin * PX_PER_MIN,
                  height,
                  left: `calc(${b.col} / ${b.cols} * 100% + 2px)`,
                  width: `calc(100% / ${b.cols} - 4px)`,
                  "--c": colour,
                };
                return (
                  <div
                    key={t.id}
                    className={`tg-block ${t.status === "done" ? "done" : ""} ${t.id === draggedId ? "dragging" : ""} ${height < 36 ? "compact" : ""}`}
                    style={style}
                    title={`${timeRange(t.startTime!, t.durationMin)} ${t.title}`}
                    onPointerDown={(e) => onBeginDrag(e, t, "timeMove")}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="tg-block-title">
                      {t.title}
                      {t.requiresPrep && !t.prepDone && <Icon name="prep" size={12} />}
                    </div>
                    <div className="tg-block-time">{height < 36 ? t.startTime : timeRange(t.startTime!, t.durationMin)}</div>
                    <div className="tg-resize" onPointerDown={(e) => onBeginDrag(e, t, "timeResize")} />
                  </div>
                );
              })}
              {d === today && <div className="now-line" style={{ top: nowMin * PX_PER_MIN }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
