import { useEffect, useState } from "react";
import { DayNote, Habits, RolloverBanner } from "../components/DayExtras";
import { Icon } from "../components/Icon";
import { Panel } from "../components/Panel";
import { QuickAddInput } from "../components/QuickAddInput";
import { TaskRow, RowVariant } from "../components/TaskRow";
import { api, DaySummary, Task, TaskInput } from "../lib/api";
import { longDate } from "../lib/format";
import { usePlanner } from "../lib/planner";

export function TodayView() {
  const { today, version, refresh, notify, openEditor } = usePlanner();
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [unscheduled, setUnscheduled] = useState<Task[]>([]);

  useEffect(() => {
    let live = true;
    Promise.all([api.daySummary(today), api.unscheduledTasks()])
      .then(([s, u]) => {
        if (!live) return;
        setSummary(s);
        setUnscheduled(u);
      })
      .catch((e) => notify(String(e)));
    return () => {
      live = false;
    };
  }, [today, version, notify]);

  async function run(action: Promise<unknown>) {
    try {
      await action;
      refresh();
    } catch (e) {
      notify(String(e));
    }
  }

  const toggleDone = (t: Task) => run(api.setTaskDone(t.id, t.status !== "done"));
  const togglePrep = (t: Task) => run(api.setPrepDone(t.id, !t.prepDone));

  async function quickAdd(input: TaskInput) {
    await run(api.createTask(input));
    notify(input.date === today ? "Added to today" : "Task added");
  }

  if (!summary) return null;

  const open = summary.tasks.filter((t) => t.status === "open");
  const completed = summary.tasks.filter((t) => t.status === "done");
  const total = summary.tasks.length;
  const pct = total ? Math.round((completed.length / total) * 100) : 0;
  // don't repeat tasks the deadline panels already show
  const shown = new Set([...summary.overdue, ...summary.upcomingDeadlines].map((t) => t.id));
  const noDate = unscheduled.filter((t) => !shown.has(t.id));

  const list = (tasks: Task[], variant: RowVariant, onToggle = toggleDone) =>
    tasks.map((t) => <TaskRow key={t.id} task={t} variant={variant} onToggle={onToggle} />);

  return (
    <div className="today-view">
      <header className="today-head">
        <div>
          <div className="eyebrow">Today</div>
          <h1>{longDate(today)}</h1>
        </div>
        {total > 0 && (
          <div className="progress" aria-label={`${completed.length} of ${total} tasks done`}>
            <div className="progress-label">
              <span>{completed.length} of {total} done</span>
              <span>{pct}%</span>
            </div>
            <div className="progress-bar"><div style={{ width: `${pct}%` }} /></div>
          </div>
        )}
      </header>

      <RolloverBanner />

      <div className="today-grid">
        <div className="main-stack">
        <Panel
          title="Today's tasks"
          icon="sun"
          count={open.length}
          actions={
            <button className="btn small primary" onClick={() => openEditor({ defaults: { date: today } })}>
              <Icon name="plus" size={14} /> New task
            </button>
          }
        >
          <QuickAddInput placeholder="Quick add, e.g. Dentist tomorrow 3pm #health — press Enter" onAdd={quickAdd} />
          <div className="panel-body">
            {total === 0 && <div className="empty">Nothing planned for today yet.</div>}
            {total > 0 && open.length === 0 && <div className="empty">All done for today. Nice work!</div>}
            {list(open, "today")}
            {completed.length > 0 && (
              <>
                <div className="section-label">Completed</div>
                {list(completed, "today")}
              </>
            )}
          </div>
        </Panel>
        <DayNote />
        </div>

        <div className="side-stack">
          {summary.overdue.length > 0 && (
            <Panel title="Overdue" icon="alert" tone="danger" count={summary.overdue.length}>
              <div className="panel-body">{list(summary.overdue, "dated")}</div>
            </Panel>
          )}

          <Panel title="Prepare for tomorrow" icon="prep" tone="prep" count={summary.prepDue.length}>
            <div className="panel-body">
              {summary.prepDue.length === 0 ? (
                <div className="empty">Nothing to prepare. Tick “Task requires preparation” on a task to see it here.</div>
              ) : (
                list(summary.prepDue, "prep", togglePrep)
              )}
            </div>
          </Panel>

          <Panel title="Upcoming deadlines" icon="hourglass" tone="warn" count={summary.upcomingDeadlines.length}>
            <div className="panel-body">
              {summary.upcomingDeadlines.length === 0 ? (
                <div className="empty">No deadlines in the next 7 days.</div>
              ) : (
                list(summary.upcomingDeadlines, "dated")
              )}
            </div>
          </Panel>

          <Habits />

          {noDate.length > 0 && (
            <Panel title="No date yet" icon="inbox" count={noDate.length}>
              <div className="panel-body">{list(noDate, "dated")}</div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
