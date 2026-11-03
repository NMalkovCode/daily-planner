// Today-view extras: unfinished tasks from earlier days, the day's note and habits.

import { useEffect, useRef, useState } from "react";
import { api, Habit, Task } from "../lib/api";
import { plural } from "../lib/format";
import { usePlanner } from "../lib/planner";
import { Icon } from "./Icon";
import { Panel } from "./Panel";
import { TaskRow } from "./TaskRow";

const DISMISSED_KEY = "rollover.dismissed";

/** "3 unfinished tasks from earlier days — Move to today / Show / Not now" */
export function RolloverBanner() {
  const { today, version, refresh, notify } = usePlanner();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    Promise.all([api.unfinishedTasks(today), api.setting(DISMISSED_KEY)])
      .then(([t, d]) => {
        setTasks(t);
        setDismissed(d);
      })
      .catch(() => {});
  }, [today, version]);

  if (tasks.length === 0 || dismissed === today) return null;

  async function moveAll() {
    await api.moveTasks(tasks.map((t) => t.id), today);
    notify(`Moved ${plural(tasks.length, "task")} to today`);
    refresh();
  }

  async function notNow() {
    await api.setSetting(DISMISSED_KEY, today);
    setDismissed(today);
  }

  return (
    <div className="rollover">
      <div className="rollover-head">
        <Icon name="inbox" />
        <span>
          <b>{plural(tasks.length, "unfinished task")}</b> from earlier days
        </span>
        <span className="spacer" />
        <button className="btn small primary" onClick={moveAll}>Move all to today</button>
        <button className="btn small" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
        <button className="btn small" onClick={notNow} title="Hide until tomorrow">Not now</button>
      </div>
      {open && (
        <div className="rollover-list">
          {tasks.map((t) => (
            <div key={t.id} className="rollover-item">
              <TaskRow task={t} variant="dated" onToggle={(x) => api.setTaskDone(x.id, true).then(refresh)} />
              <button className="btn small" onClick={() => api.moveTasks([t.id], today).then(refresh)}>Move to today</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A free-text note for the day, saved as you type. */
export function DayNote() {
  const { today } = usePlanner();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<number>(undefined);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    loadedFor.current = null;
    api.note(today).then((n) => {
      setText(n);
      loadedFor.current = today;
    });
  }, [today]);

  function change(value: string) {
    setText(value);
    if (loadedFor.current !== today) return;
    setState("saving");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      await api.setNote(today, value);
      setState("saved");
    }, 600);
  }

  return (
    <Panel
      title="Notes for today"
      icon="list"
      actions={state !== "idle" && <span className="note">{state === "saving" ? "Saving…" : "Saved"}</span>}
    >
      <div className="panel-body">
        <textarea
          className="day-note"
          placeholder="Thoughts, ideas, things to remember…"
          value={text}
          onChange={(e) => change(e.target.value)}
          aria-label="Notes for today"
        />
      </div>
    </Panel>
  );
}

export function Habits() {
  const { today, version, notify } = usePlanner();
  const [habits, setHabits] = useState<Habit[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  const load = () => api.habits(today).then(setHabits).catch((e) => notify(String(e)));
  useEffect(() => {
    load();
  }, [today, version]);

  async function add() {
    if (!name.trim()) return setAdding(false);
    await api.createHabit(name);
    setName("");
    setAdding(false);
    load();
  }

  async function remove(h: Habit) {
    if (confirmRemove !== h.id) return setConfirmRemove(h.id);
    await api.archiveHabit(h.id);
    setConfirmRemove(null);
    load();
  }

  return (
    <Panel
      title="Habits"
      icon="repeat"
      actions={
        <button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add a habit" title="Add a habit">
          <Icon name="plus" />
        </button>
      }
    >
      <div className="panel-body">
        {habits.length === 0 && !adding && (
          <div className="empty">Track something daily, like reading or a walk. Click + to add one.</div>
        )}
        {habits.map((h) => (
          <div key={h.id} className="habit">
            <button
              className={`check ${h.doneToday ? "on" : ""}`}
              style={h.doneToday ? { background: h.colour, borderColor: h.colour } : { borderColor: h.colour }}
              onClick={() => api.toggleHabit(h.id, today).then(load)}
              aria-label={h.doneToday ? `Untick ${h.name}` : `Tick ${h.name} for today`}
            >
              <Icon name="check" size={12} />
            </button>
            <span className="habit-name">{h.name}</span>
            <span className="habit-week" aria-label="Last 7 days">
              {h.last7.map((on, i) => (
                <i key={i} style={on ? { background: h.colour } : undefined} />
              ))}
            </span>
            <span className="habit-streak" title="Days in a row">{h.streak > 0 ? `${h.streak}d` : ""}</span>
            <button
              className="icon-btn habit-remove"
              onClick={() => remove(h)}
              onBlur={() => setConfirmRemove(null)}
              aria-label={`Remove ${h.name}`}
              title={confirmRemove === h.id ? "Click again to remove" : "Remove"}
            >
              <Icon name={confirmRemove === h.id ? "trash" : "x"} size={14} />
            </button>
          </div>
        ))}
        {adding && (
          <form
            className="habit-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              className="input"
              autoFocus
              placeholder="New habit, e.g. Read 20 pages"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            />
          </form>
        )}
      </div>
    </Panel>
  );
}
