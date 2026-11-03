import { ReactNode } from "react";
import { Task } from "../lib/api";
import { daysBetween, deadlineLabel, plural, relativeDay, shortDate, timeRange } from "../lib/format";
import { usePlanner } from "../lib/planner";
import { describeRule, parseRule } from "../lib/repeat";
import { Icon } from "./Icon";

/**
 * - `today`: a task on today's list (shows its day within a multi-day project)
 * - `dated`: a task shown away from its own day (shows when it is)
 * - `prep`: the tick-box marks the preparation done rather than the task
 */
export type RowVariant = "today" | "dated" | "prep";

interface Props {
  task: Task;
  variant: RowVariant;
  onToggle: (task: Task) => void;
}

export function TaskRow({ task, variant, onToggle }: Props) {
  const { today, categoryById, openEditor } = usePlanner();
  const category = categoryById(task.categoryId);
  const done = variant === "prep" ? task.prepDone : task.status === "done";
  const isSpan = task.date && task.endDate;

  const meta: ReactNode[] = [];
  if (variant !== "today" && task.date) {
    meta.push(
      <span key="when">
        <Icon name="calendar" size={13} />
        {isSpan ? `${shortDate(task.date)} – ${shortDate(task.endDate!)}` : relativeDay(today, task.date)}
      </span>,
    );
  }
  if (task.startTime) {
    meta.push(
      <span key="time">
        <Icon name="clock" size={13} />
        {timeRange(task.startTime, task.durationMin)}
      </span>,
    );
  }
  if (variant === "today" && isSpan) {
    const day = daysBetween(task.date!, today) + 1;
    const total = daysBetween(task.date!, task.endDate!) + 1;
    meta.push(
      <span key="span" className="pill accent">
        <Icon name="span" size={12} />
        Day {day} of {total}
        {day < total ? ` · until ${shortDate(task.endDate!)}` : " · last day"}
      </span>,
    );
  }
  const rule = parseRule(task.recurrenceRule);
  if (rule) {
    meta.push(
      <span key="repeat" title={describeRule(rule, task.date)}>
        <Icon name="repeat" size={13} />
        {describeRule({ ...rule, until: null }, task.date)}
      </span>,
    );
  }
  if (category) {
    meta.push(
      <span key="cat">
        <i className="dot" style={{ background: category.colour }} />
        {category.name}
      </span>,
    );
  }
  if (task.priority === "high") {
    meta.push(
      <span key="prio" className="pill danger">
        <Icon name="flag" size={12} /> High
      </span>,
    );
  }
  if (task.deadline && task.status === "open") {
    const d = deadlineLabel(today, task.deadline);
    meta.push(
      <span key="deadline" className={`pill ${d.tone === "neutral" ? "" : d.tone}`}>
        <Icon name="hourglass" size={12} /> {d.text}
      </span>,
    );
  }
  if (variant === "today" && task.requiresPrep) {
    meta.push(
      <span key="prep" className="pill prep">
        <Icon name="prep" size={12} /> {task.prepDone ? "Prepared" : "Needs prep"}
      </span>,
    );
  }
  if (variant === "prep" && task.date) {
    const n = daysBetween(today, task.date);
    if (n > 1) meta.push(<span key="lead" className="pill prep">{plural(n, "day")} to go</span>);
  }

  const label =
    variant === "prep"
      ? done ? "Mark preparation not done" : "Mark preparation done"
      : done ? "Mark not done" : "Mark done";

  return (
    <div className={`task-row ${done ? "done" : ""}`} onClick={() => openEditor({ task })}>
      {category && <i className="cat-edge" style={{ background: category.colour }} />}
      <button
        className={`check ${variant === "prep" ? "prep" : ""} ${done ? "on" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task);
        }}
        aria-label={label}
        title={label}
      >
        <Icon name="check" size={12} />
      </button>
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        {meta.length > 0 && <div className="task-meta">{meta}</div>}
        {variant === "prep" && task.prepNotes && <div className="prep-notes">{task.prepNotes}</div>}
      </div>
    </div>
  );
}
