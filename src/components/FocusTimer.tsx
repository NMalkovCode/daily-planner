// Focus timer (Pomodoro): a focus block, optionally for a task, then a short
// break. Lives in the sidebar; a Windows notification marks the end of each part.

import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { api, Task } from "../lib/api";
import { Icon } from "./Icon";

type Phase = "focus" | "break";

interface Session {
  phase: Phase;
  task: Task | null;
  /** epoch ms when the phase ends; null while paused */
  endsAt: number | null;
  /** ms left when paused */
  left: number;
  total: number;
}

interface Focus {
  session: Session | null;
  minutes: number;
  setMinutes: (m: number) => void;
  start: (task?: Task | null) => void;
  setSession: (s: Session | null) => void;
}

const LENGTHS = [15, 25, 45, 60];
const BREAK_MIN = 5;
const MINUTES_KEY = "focus.minutes";

const Ctx = createContext<Focus | null>(null);

/** null outside the main window */
export const useFocus = () => useContext(Ctx);

function savedMinutes(): number {
  try {
    const m = Number(localStorage.getItem(MINUTES_KEY));
    return LENGTHS.includes(m) ? m : 25;
  } catch {
    return 25;
  }
}

function msLeft(s: Session, now: number) {
  return s.endsAt == null ? s.left : Math.max(0, s.endsAt - now);
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [minutes, setMinutesState] = useState(savedMinutes);

  const setMinutes = (m: number) => {
    setMinutesState(m);
    try {
      localStorage.setItem(MINUTES_KEY, String(m));
    } catch {
      /* per-viewer convenience only */
    }
  };

  const start = (task: Task | null = null) => {
    const total = minutes * 60_000;
    setSession({ phase: "focus", task, endsAt: Date.now() + total, left: total, total });
  };

  return (
    <Ctx.Provider value={{ session, minutes, setMinutes, start, setSession }}>
      {children}
      <FocusTicker session={session} setSession={setSession} />
    </Ctx.Provider>
  );
}

/** Moves from focus to break to done, with a notification at each step. */
function FocusTicker({ session, setSession }: { session: Session | null; setSession: (s: Session | null) => void }) {
  useEffect(() => {
    if (!session || session.endsAt == null) return;
    const t = setTimeout(() => {
      if (session.phase === "focus") {
        const total = BREAK_MIN * 60_000;
        api.showNotification("Focus session done", `${session.task ? session.task.title + " — " : ""}time for a ${BREAK_MIN}-minute break.`);
        setSession({ phase: "break", task: session.task, endsAt: Date.now() + total, left: total, total });
      } else {
        api.showNotification("Break over", "Ready for the next one?");
        setSession(null);
      }
    }, Math.max(0, session.endsAt - Date.now()));
    return () => clearTimeout(t);
  }, [session, setSession]);
  return null;
}

const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** The sidebar widget. */
export function FocusWidget() {
  const focus = useContext(Ctx)!;
  const [now, setNow] = useState(Date.now());
  const s = focus.session;

  useEffect(() => {
    if (!s || s.endsAt == null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [s]);

  if (!s) {
    return (
      <div className="focus idle">
        <button className="btn small" onClick={() => focus.start()}>
          <Icon name="clock" size={14} /> Focus
        </button>
        <select
          value={focus.minutes}
          onChange={(e) => focus.setMinutes(Number(e.target.value))}
          aria-label="Focus length"
        >
          {LENGTHS.map((m) => <option key={m} value={m}>{m} min</option>)}
        </select>
      </div>
    );
  }

  const left = msLeft(s, now);
  const pct = 100 - (left / s.total) * 100;
  const paused = s.endsAt == null;

  return (
    <div className={`focus running phase-${s.phase}`}>
      <div className="focus-label">{s.phase === "focus" ? "Focusing" : "Break"}{paused ? " (paused)" : ""}</div>
      {s.task && <div className="focus-task" title={s.task.title}>{s.task.title}</div>}
      <div className="focus-time">{mmss(left)}</div>
      <div className="progress-bar"><div style={{ width: `${pct}%` }} /></div>
      <div className="focus-actions">
        <button
          className="btn small"
          onClick={() =>
            focus.setSession(paused ? { ...s, endsAt: Date.now() + s.left } : { ...s, endsAt: null, left })
          }
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="btn small" onClick={() => focus.setSession(null)}>Stop</button>
      </div>
    </div>
  );
}
