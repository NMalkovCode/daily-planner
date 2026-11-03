// One row of consecutive days (a month-view week, or the all-day strip of the
// week/day view). Multi-day projects are drawn as one continuous bar across
// the days they cover; single-day tasks and deadlines as compact chips.

import { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { Task } from "../../lib/api";
import { CalItem, isSpan, layoutRow, overflow, Segment, textOn } from "../../lib/calendar";
import { parseDate } from "../../lib/dates";
import { shortDate } from "../../lib/format";
import { usePlanner } from "../../lib/planner";
import { Icon } from "../Icon";
import { DragKind } from "./useCalendarDrag";

export const LANE_H = 22;
export const DATE_H = 26;
const FALLBACK_COLOUR = "#4f5bd5";

interface Props {
  days: string[];
  items: CalItem[];
  /** month view: rows have a fixed height, extra items collapse into "+N more" */
  maxLanes?: number;
  /** month view: show the day number in each cell, dim days outside `month` */
  month?: number;
  draggedId: number | null;
  onBeginDrag: (e: ReactPointerEvent, task: Task, kind: DragKind) => void;
  onDayClick: (date: string) => void;
  onShowDay?: (date: string) => void;
}

export function SpanRow({ days, items, maxLanes, month, draggedId, onBeginDrag, onDayClick, onShowDay }: Props) {
  const { today, openEditor } = usePlanner();
  const showDates = month != null;
  const n = days.length;
  const { segments, laneCount } = layoutRow(items, days);
  const { visible, hidden } = maxLanes
    ? overflow(segments, laneCount, maxLanes, n)
    : { visible: segments, hidden: new Array(n).fill(0) };
  const top = showDates ? DATE_H : 3;

  return (
    <div
      className="cal-row"
      style={{
        gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
        minHeight: maxLanes ? undefined : top + Math.max(1, laneCount) * LANE_H + 4,
      }}
    >
      {days.map((d, i) => {
        const date = parseDate(d);
        const cls = [
          "cal-cell",
          d === today && "today",
          month != null && date.getMonth() !== month && "outside",
          (date.getDay() === 0 || date.getDay() === 6) && "weekend",
        ];
        return (
          <div key={d} className={cls.filter(Boolean).join(" ")} data-date={d} onClick={() => onDayClick(d)}>
            {showDates && (
              <button
                className="cal-date"
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDay?.(d);
                }}
                title={`Open ${shortDate(d)}`}
              >
                {date.getDate() === 1 ? date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : date.getDate()}
              </button>
            )}
            {hidden[i] > 0 && (
              <button
                className="cal-more"
                style={{ top: top + (maxLanes! - 1) * LANE_H }}
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDay?.(d);
                }}
              >
                +{hidden[i]} more
              </button>
            )}
          </div>
        );
      })}
      {visible.map((s) => (
        <SegmentView
          key={s.item.key}
          seg={s}
          n={n}
          top={top + s.lane * LANE_H}
          dragging={s.item.task.id === draggedId && s.item.kind === "task"}
          onBeginDrag={onBeginDrag}
          onOpen={(task) => openEditor({ task })}
        />
      ))}
    </div>
  );
}

interface SegmentProps {
  seg: Segment;
  n: number;
  top: number;
  dragging: boolean;
  onBeginDrag: Props["onBeginDrag"];
  onOpen: (task: Task) => void;
}

function SegmentView({ seg, n, top, dragging, onBeginDrag, onOpen }: SegmentProps) {
  const { categoryById } = usePlanner();
  const { item } = seg;
  const t = item.task;
  const colour = categoryById(t.categoryId)?.colour ?? FALLBACK_COLOUR;
  const span = item.kind === "task" && isSpan(item);
  const kind = item.kind === "deadline" ? "deadline" : span ? "span" : "single";

  const cls = [
    "cal-seg",
    kind,
    t.status === "done" && "done",
    !seg.startsHere && "cont-left",
    !seg.endsHere && "cont-right",
    dragging && "dragging",
  ];
  // bars that continue into the previous/next row run to the edge of the cell
  const inL = seg.startsHere ? 3 : 0;
  const inR = seg.endsHere ? 3 : 0;
  const style: CSSProperties & Record<string, string | number> = {
    left: `calc(${seg.startCol} / ${n} * 100% + ${inL}px)`,
    width: `calc(${seg.span} / ${n} * 100% - ${inL + inR}px)`,
    top,
    "--c": colour,
  };
  if (span) {
    style.background = colour;
    style.color = textOn(colour);
  }

  const tooltip =
    item.kind === "deadline"
      ? `Deadline: ${t.title}`
      : span
        ? `${t.title} (${shortDate(t.date!)} – ${shortDate(t.endDate!)})`
        : t.title;

  if (item.kind === "deadline") {
    return (
      <div className={cls.filter(Boolean).join(" ")} style={style} title={tooltip} onClick={() => onOpen(t)}>
        <Icon name="hourglass" size={12} />
        <span className="seg-title">{t.title}</span>
      </div>
    );
  }

  return (
    <div
      className={cls.filter(Boolean).join(" ")}
      style={style}
      title={tooltip}
      onPointerDown={(e) => onBeginDrag(e, t, "move")}
    >
      {seg.startsHere && <span className="seg-handle left" onPointerDown={(e) => onBeginDrag(e, t, "start")} />}
      {!span && <i className="dot" style={{ background: colour }} />}
      {!span && t.startTime && <span className="seg-time">{t.startTime}</span>}
      <span className="seg-title">{t.title}</span>
      {t.seriesId != null && <Icon name="repeat" size={11} />}
      {t.requiresPrep && !t.prepDone && <Icon name="prep" size={12} />}
      {seg.endsHere && <span className="seg-handle right" onPointerDown={(e) => onBeginDrag(e, t, "end")} />}
    </div>
  );
}
