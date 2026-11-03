import { FormEvent, useEffect, useRef, useState } from "react";
import { api, Priority, Task, TaskInput } from "../lib/api";
import { addDays } from "../lib/dates";
import { daysBetween, duration, plural, shortDate } from "../lib/format";
import { describeRule, formatRule, Freq, isoWeekday, parseRule, unit, WEEKDAY_SHORT } from "../lib/repeat";
import { EditorRequest, usePlanner } from "../lib/planner";
import { useFocus } from "./FocusTimer";
import { Icon } from "./Icon";

interface Form {
  title: string;
  notes: string;
  date: string;
  multiDay: boolean;
  endDate: string;
  startTime: string;
  durationMin: string;
  deadlineDate: string;
  deadlineTime: string;
  priority: Priority;
  categoryId: string;
  requiresPrep: boolean;
  prepNotes: string;
  prepDaysBefore: string;
  repeatFreq: Freq | "";
  repeatInterval: string;
  repeatDays: number[];
  repeatUntil: string;
}

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

function toForm(t: Partial<TaskInput>): Form {
  const r = parseRule(t.recurrenceRule);
  return {
    repeatFreq: r?.freq ?? "",
    repeatInterval: String(r?.interval ?? 1),
    repeatDays: r?.days ?? [],
    repeatUntil: r?.until ?? "",
    title: t.title ?? "",
    notes: t.notes ?? "",
    date: t.date ?? "",
    multiDay: !!t.endDate,
    endDate: t.endDate ?? "",
    startTime: t.startTime ?? "",
    durationMin: t.durationMin ? String(t.durationMin) : "",
    deadlineDate: t.deadline?.slice(0, 10) ?? "",
    deadlineTime: t.deadline?.slice(11) ?? "",
    priority: t.priority ?? "medium",
    categoryId: t.categoryId != null ? String(t.categoryId) : "",
    requiresPrep: t.requiresPrep ?? false,
    prepNotes: t.prepNotes ?? "",
    prepDaysBefore: String(t.prepDaysBefore ?? 1),
  };
}

function toInput(f: Form, parentTaskId: number | null): TaskInput {
  const or = (s: string) => (s.trim() ? s.trim() : null);
  return {
    title: f.title,
    notes: f.notes,
    date: or(f.date),
    endDate: f.multiDay ? or(f.endDate) : null,
    startTime: or(f.startTime),
    durationMin: f.durationMin ? Number(f.durationMin) : null,
    deadline: f.deadlineDate ? (f.deadlineTime ? `${f.deadlineDate} ${f.deadlineTime}` : f.deadlineDate) : null,
    priority: f.priority,
    categoryId: f.categoryId ? Number(f.categoryId) : null,
    requiresPrep: f.requiresPrep,
    prepNotes: f.prepNotes,
    prepDaysBefore: Number(f.prepDaysBefore) || 1,
    recurrenceRule: repeatRule(f),
    parentTaskId,
  };
}

function repeatRule(f: Form): string | null {
  if (!f.repeatFreq || !f.date) return null;
  return formatRule({
    freq: f.repeatFreq,
    interval: Math.max(1, Math.min(99, Number(f.repeatInterval) || 1)),
    days: f.repeatFreq === "weekly" ? f.repeatDays : [],
    until: f.repeatUntil || null,
  });
}

export function TaskEditor({ request }: { request: EditorRequest }) {
  const { closeEditor, refresh, notify, categories } = usePlanner();
  const existing = "task" in request ? request.task : null;
  const [form, setForm] = useState<Form>(() => toForm("task" in request ? request.task : request.defaults));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // repeating tasks: change just this one, or this and the later repeats
  const [laterToo, setLaterToo] = useState(false);
  const repeats = existing?.seriesId != null;
  const ruleChanged = !!existing && repeatRule(form) !== (existing.recurrenceRule ?? null);
  const applyLater = laterToo || (repeats && ruleChanged);
  const titleRef = useRef<HTMLInputElement>(null);
  const focus = useFocus();
  const pressStartedOnBackdrop = useRef(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => titleRef.current?.focus(), []);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (saving) return;
    if (form.multiDay && !form.endDate) return setError("Choose an end date, or untick “Spans several days”.");
    setSaving(true);
    setError(null);
    try {
      const input = toInput(form, existing?.parentTaskId ?? null);
      const saved = existing ? await api.updateTask(existing.id, input, applyLater) : await api.createTask(input);
      for (const title of pendingSubtasks) {
        await api.createTask({ title, parentTaskId: saved.id });
      }
      notify(existing ? "Task updated" : "Task added");
      refresh();
      closeEditor();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing) return;
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await api.deleteTask(existing.id, laterToo);
      notify("Task deleted");
      refresh();
      closeEditor();
    } catch (err) {
      setError(String(err));
    }
  }

  // Esc closes, Ctrl+Enter saves from anywhere in the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEditor();
      if (e.key === "Enter" && e.ctrlKey) save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Subtasks: saved straight away for an existing task, after saving for a new one.
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [pendingSubtasks, setPendingSubtasks] = useState<string[]>([]);
  const [newSubtask, setNewSubtask] = useState("");
  const isSubtask = existing?.parentTaskId != null;

  useEffect(() => {
    if (existing && !isSubtask) api.subtasks(existing.id).then(setSubtasks).catch(() => {});
  }, [existing, isSubtask]);

  async function addSubtask() {
    const title = newSubtask.trim();
    if (!title) return;
    setNewSubtask("");
    if (!existing) return setPendingSubtasks((p) => [...p, title]);
    const created = await api.createTask({ title, parentTaskId: existing.id });
    setSubtasks((s) => [...s, created]);
  }

  async function toggleSubtask(t: Task) {
    const updated = await api.setTaskDone(t.id, t.status !== "done");
    setSubtasks((s) => s.map((x) => (x.id === t.id ? updated : x)));
  }

  async function deleteSubtask(t: Task) {
    await api.deleteTask(t.id);
    setSubtasks((s) => s.filter((x) => x.id !== t.id));
  }

  const spanDays = form.multiDay && form.date && form.endDate ? daysBetween(form.date, form.endDate) + 1 : 0;
  const prepDays = Number(form.prepDaysBefore) || 1;
  const durations = form.durationMin && !DURATIONS.includes(Number(form.durationMin))
    ? [...DURATIONS, Number(form.durationMin)].sort((a, b) => a - b)
    : DURATIONS;

  return (
    <div
      className="backdrop"
      onMouseDown={(e) => (pressStartedOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (pressStartedOnBackdrop.current && e.target === e.currentTarget) closeEditor();
      }}
    >
      <form className="modal" onSubmit={save} role="dialog" aria-label={existing ? "Edit task" : "New task"}>
        <div className="modal-head">
          <h2>{existing ? (isSubtask ? "Edit subtask" : "Edit task") : "New task"}</h2>
          <button type="button" className="icon-btn" onClick={closeEditor} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className="modal-body">
          <input
            ref={titleRef}
            className="input title"
            placeholder="What needs doing?"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />

          <div className="field-row">
            <div className="field">
              <label htmlFor="f-date">{form.multiDay ? "Start date" : "Date"}</label>
              <input
                id="f-date"
                type="date"
                className="input"
                value={form.date}
                onChange={(e) => {
                  const date = e.target.value;
                  // keep a project's length when its start moves
                  if (form.multiDay && form.date && form.endDate && date) {
                    set("endDate", addDays(date, daysBetween(form.date, form.endDate)));
                  }
                  set("date", date);
                }}
              />
            </div>
            {form.multiDay && (
              <div className="field">
                <label htmlFor="f-end">End date</label>
                <input
                  id="f-end"
                  type="date"
                  className="input"
                  min={form.date ? addDays(form.date, 1) : undefined}
                  value={form.endDate}
                  onChange={(e) => set("endDate", e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="f-time">Start time</label>
              <input
                id="f-time"
                type="time"
                className="input"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="f-dur">Duration</label>
              <select id="f-dur" value={form.durationMin} onChange={(e) => set("durationMin", e.target.value)}>
                <option value="">—</option>
                {durations.map((d) => (
                  <option key={d} value={d}>{duration(d)}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.multiDay}
              disabled={!form.date}
              onChange={(e) => {
                set("multiDay", e.target.checked);
                if (e.target.checked && !form.endDate && form.date) set("endDate", addDays(form.date, 1));
              }}
            />
            <Icon name="span" /> Spans several days (project)
            {spanDays > 1 && <span className="pill accent">{plural(spanDays, "day")}</span>}
          </label>

          {!isSubtask && (
            <div className="repeat-row">
              <label className="field-label" htmlFor="f-repeat"><Icon name="repeat" size={14} /> Repeat</label>
              <select
                id="f-repeat"
                className="repeat-select"
                value={form.repeatFreq}
                disabled={!form.date}
                onChange={(e) => {
                  const v = e.target.value as Freq | "";
                  set("repeatFreq", v);
                  if (v === "weekly" && form.repeatDays.length === 0 && form.date) set("repeatDays", [isoWeekday(form.date)]);
                }}
              >
                <option value="">Doesn’t repeat</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Every weekday (Mon–Fri)</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              {form.repeatFreq && form.repeatFreq !== "weekdays" && (
                <span className="inline">
                  every
                  <input
                    type="number"
                    className="input num"
                    min={1}
                    max={99}
                    value={form.repeatInterval}
                    onChange={(e) => set("repeatInterval", e.target.value)}
                    aria-label="Repeat interval"
                  />
                  {unit(form.repeatFreq, Number(form.repeatInterval) || 1)}
                </span>
              )}
              {form.repeatFreq === "weekly" && (
                <div className="day-chips" role="group" aria-label="Repeat on">
                  {WEEKDAY_SHORT.map((name, i) => {
                    const day = i + 1;
                    const on = form.repeatDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={on ? "on" : ""}
                        aria-pressed={on}
                        onClick={() => {
                          const days = on ? form.repeatDays.filter((d) => d !== day) : [...form.repeatDays, day];
                          set("repeatDays", days.length ? days : form.repeatDays);
                        }}
                      >
                        {name.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
              )}
              {form.repeatFreq && (
                <span className="inline">
                  until
                  <input
                    type="date"
                    className="input"
                    min={form.date || undefined}
                    value={form.repeatUntil}
                    onChange={(e) => set("repeatUntil", e.target.value)}
                    aria-label="Repeat until"
                  />
                </span>
              )}
              {!form.date && <span className="note">Set a date to make the task repeat.</span>}
              {form.repeatFreq && form.date && (
                <span className="note">{describeRule(parseRule(repeatRule(form))!, form.date)}</span>
              )}
            </div>
          )}

          <div className="field-row">
            <div className="field">
              <label htmlFor="f-deadline">Deadline</label>
              <input
                id="f-deadline"
                type="date"
                className="input"
                value={form.deadlineDate}
                onChange={(e) => set("deadlineDate", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="f-deadline-time">Deadline time</label>
              <input
                id="f-deadline-time"
                type="time"
                className="input"
                disabled={!form.deadlineDate}
                value={form.deadlineTime}
                onChange={(e) => set("deadlineTime", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <span className="field-label">Priority</span>
            <div className="segmented" role="radiogroup" aria-label="Priority">
              {(["low", "medium", "high"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={form.priority === p}
                  className={`${form.priority === p ? "on" : ""} ${p}`}
                  onClick={() => set("priority", p)}
                >
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className={`prep-box ${form.requiresPrep ? "on" : ""}`}>
            <label className="checkbox prep">
              <input
                type="checkbox"
                checked={form.requiresPrep}
                onChange={(e) => set("requiresPrep", e.target.checked)}
              />
              Task requires preparation
            </label>
            {form.requiresPrep && (
              <>
                <div className="inline">
                  Start preparing
                  <input
                    type="number"
                    className="input"
                    min={1}
                    max={60}
                    value={form.prepDaysBefore}
                    onChange={(e) => set("prepDaysBefore", e.target.value)}
                    aria-label="Days before"
                  />
                  {prepDays === 1 ? "day" : "days"} before
                </div>
                <textarea
                  placeholder="What needs preparing? e.g. print the slides, pack the kit"
                  value={form.prepNotes}
                  onChange={(e) => set("prepNotes", e.target.value)}
                />
                {form.date ? (
                  <span className="note">
                    Shows in “Prepare for tomorrow” from {shortDate(addDays(form.date, -prepDays))}.
                  </span>
                ) : (
                  <span className="note warn">Set a date so the planner knows when to remind you.</span>
                )}
              </>
            )}
          </div>

          <div className="field">
            <label htmlFor="f-notes">Notes</label>
            <textarea id="f-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          {!isSubtask && (
            <div className="field">
              <span className="field-label">Subtasks</span>
              <div className="subtasks">
                {subtasks.map((s) => (
                  <div key={s.id} className={`subtask ${s.status === "done" ? "done" : ""}`}>
                    <button
                      type="button"
                      className={`check ${s.status === "done" ? "on" : ""}`}
                      onClick={() => toggleSubtask(s)}
                      aria-label={s.status === "done" ? "Mark not done" : "Mark done"}
                    >
                      <Icon name="check" size={12} />
                    </button>
                    <span>{s.title}</span>
                    <button type="button" className="icon-btn" onClick={() => deleteSubtask(s)} aria-label="Delete subtask">
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
                {pendingSubtasks.map((title, i) => (
                  <div key={`p${i}`} className="subtask">
                    <span className="check" />
                    <span>{title}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingSubtasks((p) => p.filter((_, j) => j !== i))}
                      aria-label="Remove subtask"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
                <input
                  className="input"
                  placeholder="Add a subtask and press Enter"
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey) {
                      e.preventDefault();
                      addSubtask();
                    }
                  }}
                />
              </div>
            </div>
          )}

          {repeats && (
            <div className="scope">
              <Icon name="repeat" size={14} />
              <span>This task repeats. Apply changes to</span>
              <div className="segmented" role="radiogroup" aria-label="Apply changes to">
                <button type="button" role="radio" aria-checked={!applyLater} className={applyLater ? "" : "on"} disabled={ruleChanged} onClick={() => setLaterToo(false)}>
                  This task
                </button>
                <button type="button" role="radio" aria-checked={applyLater} className={applyLater ? "on" : ""} onClick={() => setLaterToo(true)}>
                  This and later ones
                </button>
              </div>
              {ruleChanged && <span className="note">Changing the repeat applies to later ones.</span>}
            </div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          {existing && (
            <button type="button" className="btn danger" onClick={remove} onBlur={() => setConfirmDelete(false)}>
              <Icon name="trash" />
              {confirmDelete ? "Click again to delete" : "Delete"}
            </button>
          )}
          {existing && focus && existing.status === "open" && !focus.session && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                focus.start(existing);
                closeEditor();
              }}
              title={`Start a ${focus.minutes}-minute focus session on this task`}
            >
              <Icon name="clock" /> Focus
            </button>
          )}
          <span className="spacer" />
          <span className="hint">Ctrl+Enter to save</span>
          <button type="button" className="btn" onClick={closeEditor}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || !form.title.trim()}>
            {existing ? "Save" : "Add task"}
          </button>
        </div>
      </form>
    </div>
  );
}
