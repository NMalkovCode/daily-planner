import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FocusProvider, FocusWidget } from "./components/FocusTimer";
import { Icon, IconName } from "./components/Icon";
import { SearchDialog } from "./components/SearchDialog";
import { TaskEditor } from "./components/TaskEditor";
import { api } from "./lib/api";
import { plural } from "./lib/format";
import { PlannerProvider, usePlanner } from "./lib/planner";
import { CalendarView } from "./views/CalendarView";
import { SettingsView } from "./views/SettingsView";
import { TodayView } from "./views/TodayView";
import "./styles.css";

type View = "today" | "calendar" | "settings";

const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: "today", label: "Today", icon: "sun" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function Shell() {
  const { editor, openEditor, today, toast, version, notify } = usePlanner();
  const [view, setView] = useState<View>("today");
  const [searching, setSearching] = useState(false);

  // Ctrl+N: new task, Ctrl+K: search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || editor) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        setSearching(false);
        openEditor({ defaults: { date: today } });
      } else if (key === "k" || key === "f") {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, openEditor, today]);

  // Requests from the tray menu and the tray pop-up.
  useEffect(() => {
    const unlisten = [
      listen("new-task", () => openEditor({ defaults: { date: today } })),
      listen<number>("open-task", (e) =>
        api.task(e.payload).then((task) => openEditor({ task })).catch((err) => notify(String(err))),
      ),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, [openEditor, today, notify]);

  // Tray icon tooltip, e.g. "Daily Planner — 3 tasks left today".
  useEffect(() => {
    api
      .daySummary(today)
      .then((s) => {
        const left = s.tasks.filter((t) => t.status === "open").length;
        const parts = [left ? `${plural(left, "task")} left today` : "All done for today"];
        if (s.prepDue.length) parts.push(`${s.prepDue.length} to prepare`);
        if (s.overdue.length) parts.push(`${s.overdue.length} overdue`);
        return api.setTrayTooltip(`Daily Planner — ${parts.join(", ")}`);
      })
      .catch(() => {});
  }, [today, version]);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="check" size={17} /></span>
          Daily Planner
        </div>
        <button className="search-trigger" onClick={() => setSearching(true)}>
          <Icon name="search" /> Search <kbd>Ctrl K</kbd>
        </button>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
            <Icon name={n.icon} />
            {n.label}
          </button>
        ))}
        <FocusWidget />
        <div className="sidebar-foot">Ctrl+N — new task</div>
      </nav>

      <main className={`main ${view === "calendar" ? "full" : ""}`}>
        {view === "today" && <TodayView />}
        {view === "calendar" && <CalendarView />}
        {view === "settings" && <SettingsView />}
      </main>

      {searching && <SearchDialog onClose={() => setSearching(false)} />}
      {editor && <TaskEditor request={editor} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export default function App() {
  return (
    <PlannerProvider>
      <FocusProvider>
        <Shell />
      </FocusProvider>
    </PlannerProvider>
  );
}
