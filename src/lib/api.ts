// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Dates are "YYYY-MM-DD", times "HH:MM", deadlines either of "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".

import { invoke } from "@tauri-apps/api/core";

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "open" | "done";

export interface Task {
  id: number;
  title: string;
  notes: string;
  date: string | null;
  /** Set for multi-day projects; the calendar draws one bar from `date` to `endDate`. */
  endDate: string | null;
  startTime: string | null;
  durationMin: number | null;
  deadline: string | null;
  priority: Priority;
  categoryId: number | null;
  status: TaskStatus;
  completedAt: string | null;
  requiresPrep: boolean;
  prepNotes: string;
  prepDaysBefore: number;
  prepDone: boolean;
  /** repeat rule of its series, see lib/repeat.ts */
  recurrenceRule: string | null;
  seriesId: number | null;
  parentTaskId: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable task fields. Anything left out gets its default. */
export interface TaskInput {
  title: string;
  notes?: string;
  date?: string | null;
  endDate?: string | null;
  startTime?: string | null;
  durationMin?: number | null;
  deadline?: string | null;
  priority?: Priority;
  categoryId?: number | null;
  requiresPrep?: boolean;
  prepNotes?: string;
  prepDaysBefore?: number;
  recurrenceRule?: string | null;
  parentTaskId?: number | null;
}

export interface DaySummary {
  today: string;
  tasks: Task[];
  overdue: Task[];
  upcomingDeadlines: Task[];
  prepDue: Task[];
}

export interface Habit {
  id: number;
  name: string;
  colour: string;
  doneToday: boolean;
  streak: number;
  /** the last 7 days, oldest first, ending today */
  last7: boolean[];
}

export interface Category {
  id: number;
  name: string;
  colour: string;
  sortOrder: number;
}

export interface CategoryInput {
  name: string;
  colour: string;
}

export interface BackupsInfo {
  folder: string;
  /** date of the newest automatic backup */
  latest: string | null;
  count: number;
}

export interface Restored {
  tasks: number;
  habits: number;
  notes: number;
}

export interface DbInfo {
  path: string;
  today: string;
  taskCount: number;
}

/** The editable fields of an existing task, e.g. to save it with a few changes. */
export function taskToInput(t: Task): TaskInput {
  return {
    title: t.title,
    notes: t.notes,
    date: t.date,
    endDate: t.endDate,
    startTime: t.startTime,
    durationMin: t.durationMin,
    deadline: t.deadline,
    priority: t.priority,
    categoryId: t.categoryId,
    requiresPrep: t.requiresPrep,
    prepNotes: t.prepNotes,
    prepDaysBefore: t.prepDaysBefore,
    recurrenceRule: t.recurrenceRule,
    parentTaskId: t.parentTaskId,
  };
}

export const api = {
  dbInfo: () => invoke<DbInfo>("db_info"),

  task: (id: number) => invoke<Task>("task_get", { id }),
  createTask: (input: TaskInput) => invoke<Task>("task_create", { input }),
  /** `laterToo`: for a repeating task, also change the repeats after it. */
  updateTask: (id: number, input: TaskInput, laterToo = false) => invoke<Task>("task_update", { id, input, laterToo }),
  /** `laterToo`: for a repeating task, also delete the repeats after it. */
  deleteTask: (id: number, laterToo = false) => invoke<void>("task_delete", { id, laterToo }),
  setTaskDone: (id: number, done: boolean) => invoke<Task>("task_set_done", { id, done }),
  setPrepDone: (id: number, done: boolean) => invoke<Task>("task_set_prep_done", { id, done }),
  setTaskDates: (id: number, date: string | null, endDate: string | null) =>
    invoke<Task>("task_set_dates", { id, date, endDate }),

  /** Top-level tasks touching any day in the range, including multi-day spans. */
  tasksBetween: (from: string, to: string) => invoke<Task[]>("tasks_between", { from, to }),
  /** Tasks and subtasks with a deadline in the range (for calendar markers). */
  deadlinesBetween: (from: string, to: string) => invoke<Task[]>("deadlines_between", { from, to }),
  tasksForDay: (day: string) => invoke<Task[]>("tasks_for_day", { day }),
  subtasks: (parentId: number) => invoke<Task[]>("task_subtasks", { parentId }),
  unscheduledTasks: () => invoke<Task[]>("tasks_unscheduled"),
  /** Single-day, non-repeating tasks before `today` that were never ticked off. */
  unfinishedTasks: (today: string) => invoke<Task[]>("tasks_unfinished", { today }),
  moveTasks: (ids: number[], date: string) => invoke<void>("tasks_move_to", { ids, date }),
  searchTasks: (text: string) => invoke<Task[]>("tasks_search", { text }),

  habits: (today: string) => invoke<Habit[]>("habits_list", { today }),
  createHabit: (name: string) => invoke<number>("habit_create", { name }),
  archiveHabit: (id: number) => invoke<void>("habit_archive", { id }),
  toggleHabit: (id: number, date: string) => invoke<boolean>("habit_toggle", { id, date }),

  /** Today's tasks, overdue, next 7 days of deadlines and preparation due. */
  daySummary: (today?: string) => invoke<DaySummary>("day_summary", { today }),

  categories: () => invoke<Category[]>("categories_list"),
  createCategory: (input: CategoryInput) => invoke<Category>("category_create", { input }),
  updateCategory: (id: number, input: CategoryInput) => invoke<Category>("category_update", { id, input }),
  deleteCategory: (id: number) => invoke<void>("category_delete", { id }),

  note: (date: string) => invoke<string>("note_get", { date }),
  setNote: (date: string, content: string) => invoke<void>("note_set", { date, content }),

  autostart: () => invoke<boolean>("autostart_get"),
  setAutostart: (enabled: boolean) => invoke<void>("autostart_set", { enabled }),
  /** Shows the main window, optionally opening a task or a new-task form. */
  openMain: (opts: { taskId?: number; newTask?: boolean } = {}) => invoke<void>("open_main", opts),
  hideOverlay: () => invoke<void>("overlay_hide"),
  setTrayTooltip: (text: string) => invoke<void>("tray_set_tooltip", { text }),
  testNotification: () => invoke<void>("notify_test"),
  showNotification: (title: string, body: string) => invoke<void>("notify_show", { title, body }),

  exportBackup: (path: string) => invoke<void>("backup_export", { path }),
  /** Replaces all data with the backup's; a copy of the current data is saved first. */
  restoreBackup: (path: string) => invoke<Restored>("backup_restore", { path }),
  /** Returns how many events were written. */
  exportCalendar: (path: string) => invoke<number>("calendar_export", { path }),
  backupsInfo: () => invoke<BackupsInfo>("backups_info"),
  openBackupsFolder: () => invoke<void>("backups_open_folder"),

  settings: () => invoke<Record<string, string>>("settings_all"),
  setting: (key: string) => invoke<string | null>("setting_get", { key }),
  setSetting: (key: string, value: string) => invoke<void>("setting_set", { key, value }),
};
