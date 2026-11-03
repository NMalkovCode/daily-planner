// The summary pop-up that opens from the tray icon: today's progress, what's
// next, what to prepare and the nearest deadlines, with tick-boxes and quick add.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { QuickAddInput } from "../components/QuickAddInput";
import { api, DaySummary, Task } from "../lib/api";
import { DEFAULT_DURATION, toMinutes } from "../lib/calendar";
import { deadlineLabel, longDate, plural, relativeDay, timeRange } from "../lib/format";
import { PlannerProvider, usePlanner } from "../lib/planner";
import "../styles.css";
import "./overlay.css";

const MAX_TODAY = 5;

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** The task in progress or starting next; otherwise the first untimed task left. */
function nextUp(open: Task[]): Task | undefined {
  const now = nowMinutes();
  const timed = open.filter((t) => t.startTime && !t.endDate);
  return (
    timed.find((t) => toMinutes(t.startTime!) + (t.durationMin ?? DEFAULT_DURATION) > now) ??
    open.find((t) => !t.startTime)
  );
}

function Overlay() {
  const { today, version, refresh, notify, categoryById } = usePlanner();
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.daySummary(today).then(setSummary).catch((e) => setError(String(e)));
  }, [today, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && api.hideOverlay();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function run(action: Promise<unknown>) {
    try {
      await action;
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  if (error) return <div className="ov ov-error">{error}</div>;
  if (!summary) return <div className="ov" />;

  const open = summary.tasks.filter((t) => t.status === "open");
  const done = summary.tasks.length - open.length;
  const total = summary.tasks.length;
  const next = nextUp(open);
  const rest = open.filter((t) => t !== next);
  const deadlines = [...summary.overdue, ...summary.upcomingDeadlines].slice(0, 3);
  const openTask = (t: Task) => api.openMain({ taskId: t.id });

  const row = (t: Task, opts: { prep?: boolean; meta?: string; tone?: string } = {}) => {
    const checked = opts.prep ? t.prepDone : t.status === "done";
    const colour = categoryById(t.categoryId)?.colour;
    return (
      <div key={`${opts.prep ? "p" : "t"}${t.id}`} className="ov-row">
        <button
          className={`check ${opts.prep ? "prep" : ""} ${checked ? "on" : ""}`}
          aria-label={opts.prep ? "Mark preparation done" : "Mark done"}
          onClick={() => run(opts.prep ? api.setPrepDone(t.id, !t.prepDone) : api.setTaskDone(t.id, !checked))}
        >
          <Icon name="check" size={12} />
        </button>
        <button className="ov-row-main" onClick={() => openTask(t)} title="Open in planner">
          <span className="ov-title">
            {colour && <i className="dot" style={{ background: colour }} />}
            {t.title}
          </span>
          {opts.meta && <span className={`ov-meta ${opts.tone ?? ""}`}>{opts.meta}</span>}
        </button>
      </div>
    );
  };

  return (
    <div className="ov">
      <header className="ov-head">
        <div>
          <div className="eyebrow">Today</div>
          <h1>{longDate(today)}</h1>
        </div>
        <button className="icon-btn" onClick={() => api.hideOverlay()} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      {total > 0 && (
        <div className="ov-progress">
          <div className="progress-bar"><div style={{ width: `${(done / total) * 100}%` }} /></div>
          <span>{done} of {total} done</span>
        </div>
      )}

      <div className="ov-body">
        {next && (
          <section className="ov-next" onClick={() => openTask(next)}>
            <div className="ov-label">Next up</div>
            <div className="ov-next-title">{next.title}</div>
            {next.startTime && (
              <div className="ov-meta">
                <Icon name="clock" size={12} /> {timeRange(next.startTime, next.durationMin)}
              </div>
            )}
          </section>
        )}

        <section>
          <div className="ov-label">
            <Icon name="sun" size={13} /> Today {open.length > 0 && <span className="count">{open.length} left</span>}
          </div>
          {total === 0 && <div className="empty">Nothing planned for today.</div>}
          {total > 0 && open.length === 0 && <div className="empty">All done for today. Nice work!</div>}
          {rest.slice(0, MAX_TODAY).map((t) => row(t, { meta: t.startTime ? timeRange(t.startTime, t.durationMin) : undefined }))}
          {rest.length > MAX_TODAY && (
            <button className="ov-more" onClick={() => api.openMain()}>
              +{plural(rest.length - MAX_TODAY, "more task")}
            </button>
          )}
        </section>

        {summary.prepDue.length > 0 && (
          <section>
            <div className="ov-label prep"><Icon name="prep" size={13} /> Prepare for tomorrow</div>
            {summary.prepDue.slice(0, 3).map((t) =>
              row(t, { prep: true, meta: [relativeDay(today, t.date!), t.prepNotes].filter(Boolean).join(" · ") }),
            )}
          </section>
        )}

        {deadlines.length > 0 && (
          <section>
            <div className="ov-label warn">
              <Icon name="hourglass" size={13} /> Deadlines
              {summary.overdue.length > 0 && <span className="pill danger">{summary.overdue.length} overdue</span>}
            </div>
            {deadlines.map((t) => {
              const d = deadlineLabel(today, t.deadline!);
              return row(t, { meta: d.text, tone: d.tone });
            })}
          </section>
        )}
      </div>

      <footer className="ov-foot">
        <QuickAddInput className="ov-quick" placeholder="Add a task, e.g. Call mum 6pm" onAdd={(input) => run(api.createTask(input))} />
        <button className="btn primary" onClick={() => api.openMain()}>Open planner</button>
      </footer>
    </div>
  );
}

export function OverlayApp() {
  return (
    <PlannerProvider>
      <Overlay />
    </PlannerProvider>
  );
}
