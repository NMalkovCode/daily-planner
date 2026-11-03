// App-wide state shared by every view: today's date, categories, the task
// editor and a refresh signal that views reload their data on.

import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, Category, Task, TaskInput } from "./api";
import { todayString } from "./dates";

const DATA_CHANGED = "data-changed";
/** "main" or "overlay" */
export const WINDOW = getCurrentWindow().label;

export type EditorRequest = { task: Task } | { defaults: Partial<TaskInput> };

interface Planner {
  today: string;
  categories: Category[];
  categoryById: (id: number | null) => Category | undefined;
  /** Bumped after every change; views put it in their effect deps to reload. */
  version: number;
  refresh: () => void;
  editor: EditorRequest | null;
  openEditor: (req: EditorRequest) => void;
  closeEditor: () => void;
  notify: (message: string) => void;
  toast: string | null;
  /** 1 = weeks start on Monday, 0 = Sunday */
  weekStart: 0 | 1;
}

const Ctx = createContext<Planner | null>(null);

export function usePlanner(): Planner {
  const p = useContext(Ctx);
  if (!p) throw new Error("usePlanner outside PlannerProvider");
  return p;
}

/** Keeps `today` correct across midnight and when the PC wakes from sleep. */
function useToday(): string {
  const [today, setToday] = useState(todayString);
  useEffect(() => {
    const check = () => setToday((prev) => (prev === todayString() ? prev : todayString()));
    const timer = setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

export function PlannerProvider({ children }: { children: ReactNode }) {
  const today = useToday();
  const [categories, setCategories] = useState<Category[]>([]);
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(undefined);

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // A change in one window (main or tray pop-up) reloads the other one too.
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    emit(DATA_CHANGED, { from: WINDOW }).catch(() => {});
  }, []);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const unlisten = [
      listen<{ from: string }>(DATA_CHANGED, (e) => e.payload.from !== WINDOW && bump()),
      listen("overlay-shown", bump),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  useEffect(() => {
    api.categories().then(setCategories).catch((e) => notify(String(e)));
  }, [version, notify]);

  // Appearance settings; reloaded on every change so both windows follow.
  const [weekStart, setWeekStart] = useState<0 | 1>(1);
  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setWeekStart(s.weekStart === "sunday" ? 0 : 1);
        const theme = s.theme;
        if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
        else delete document.documentElement.dataset.theme;
      })
      .catch(() => {});
  }, [version]);

  const categoryById = useCallback(
    (id: number | null) => (id == null ? undefined : categories.find((c) => c.id === id)),
    [categories],
  );

  const value: Planner = {
    today,
    categories,
    categoryById,
    version,
    refresh,
    editor,
    openEditor: setEditor,
    closeEditor: () => setEditor(null),
    notify,
    toast,
    weekStart,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
