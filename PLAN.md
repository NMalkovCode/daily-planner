# Daily Planner — Project Plan

A Windows desktop daily planner, launched from a `.exe`, that starts with Windows and lives in the
system tray (the "show hidden items" ^ arrow) with a quick summary pop-up. Built for personal use
first, structured so it can be distributed later.

---

## 1. Technology choice

**Recommended: Tauri 2 + React + TypeScript + SQLite**

| Need | How Tauri covers it |
|---|---|
| Opens via `.exe` | Builds a native `DailyPlanner.exe` plus an installer (`-setup.exe` / `.msi`) |
| Start with Windows | Official `autostart` plugin (registry Run key, toggled from Settings) |
| Tray icon + summary pop-up | Built-in tray icon API; a second small frameless window positioned above the tray |
| Reminders | Official `notification` plugin (native Windows toast notifications) |
| Local data | SQLite database in `%APPDATA%\DailyPlanner\` via the `sql` plugin |
| Distribution later | Small installer (~5–10 MB), built-in auto-updater, code-signing support |
| Modern UI | Any web UI library; fast to iterate on |

Windows 11 places new tray icons in the hidden-items overflow by default, so the icon will appear
under the ^ arrow exactly as requested (users can drag it onto the taskbar if they prefer).

**One-time setup needed on this PC** (not currently installed): Node.js LTS, Rust (rustup), and
Microsoft C++ Build Tools. WebView2 is already part of Windows 11.

*Alternative if you'd rather avoid that setup:* Python + PySide6 (Python 3.12 is already installed),
packaged with PyInstaller. Works fine for personal use, but produces a larger (~60–80 MB) exe and a
less polished path to distribution and auto-updates.

---

## 2. Features

### Core (requested)
- **Today view (dashboard / home screen)**
  - Today's tasks, sorted by time then priority, with tick-to-complete
  - **Upcoming deadlines** panel — next 7 days, with an **Overdue** section in red
  - **Prepare for tomorrow** panel — tomorrow's tasks that have *Requires preparation* ticked
- **Calendar** — month, week and day views; click a day to see/add tasks; drag a task to reschedule
  - **Multi-day projects / tasks** (start date → end date) are drawn as one **solid continuous bar**
    spanning every day from start to end, like a Gantt bar laid over the calendar grid. A 6-day
    project is one rectangle across 6 day cells, not 6 separate items.
  - Bars that cross a week boundary continue on the next row (with a flat edge where they wrap,
    rounded ends only at the true start and end); overlapping projects stack in separate lanes
  - Drag the bar to move the whole project; drag either end to change its start or end date
  - In week view the bars sit in an "all-day" strip above the hourly grid
- **Task editor**
  - Title, notes, date, optional start time and duration, deadline
  - Priority (low / medium / high), category / colour tag
  - ☑ **Task requires preparation** → reveals: preparation notes and "remind me X days before"
    (default: 1 day — this drives the *Prepare for tomorrow* panel)
  - Subtasks / checklist
- **Tray icon + summary overlay** — left-click opens a compact pop-up above the tray:
  - Today's progress (e.g. 3 / 7 done), next upcoming task, prep needed for tomorrow, nearest deadline
  - Tick tasks off directly, quick-add box, "Open planner" button
  - Right-click menu: Open, Quick add, Settings, Quit
  - Closing the main window minimises to tray instead of quitting
- **Start with Windows** — on by default, toggle in Settings; starts silently to the tray

### Suggested extras
- **Reminders** — Windows notifications at a task's time, for deadlines (e.g. 1 day / 1 hour before)
  and an optional evening "prep for tomorrow" nudge
- **Recurring tasks** — daily, weekdays, weekly, monthly, custom
- **Unfinished-task rollover** — offer to move yesterday's incomplete tasks to today
- **Quick add with natural language** — "Dentist tomorrow 3pm !high #health"
- **Daily notes / journal** — one free-text note per day
- **Habit tracker** — small daily checkboxes with streaks
- **Focus timer** — Pomodoro timer attached to a task
- **Search & filters** — by text, category, priority, status
- **Weekly review** — what got done, what slipped, completion stats
- **Light / dark theme**, keyboard shortcuts (e.g. `Ctrl+N` new task, global hotkey to open the overlay)
- **Backup & export** — export/import JSON, export to `.ics` for other calendars

### Later (distribution stage)
- Google / Outlook calendar sync
- Installer with code signing (avoids SmartScreen warnings) and auto-update
- Onboarding screen, settings for first day of week, 12/24h time, date format

---

## 3. Data model (SQLite)

```
tasks
  id, title, notes, date, end_date (null = single day; set = multi-day span),
  start_time, duration_min, deadline,
  priority, category_id, status (open/done), completed_at,
  requires_prep (bool), prep_notes, prep_days_before (default 1),
  prep_done (bool — tick off the preparation separately from the task),
  recurrence_rule, parent_task_id (for subtasks), created_at, updated_at

categories     id, name, colour
notifications_sent  key, sent_at   (reminders are worked out from tasks each tick;
                                    this only records which were shown)
daily_notes    date, content
habits         id, name, colour, active
habit_checks   habit_id, date
settings       key, value
```

"Prepare for tomorrow" = open tasks where `requires_prep = 1` and
`date − prep_days_before ≤ today` (so a 3-day-prep task appears three days ahead, not just the day before).

---

## 4. Project structure

```
Daily Planner Programme/
├─ src/                      React front end
│  ├─ views/                 Today, Calendar, Tasks, Notes, Habits, Settings
│  ├─ overlay/               Tray summary pop-up (separate small window)
│  ├─ components/            TaskCard, TaskEditor, DeadlineList, PrepList, ...
│  ├─ db/                    Queries and migrations
│  └─ lib/                   Dates, recurrence, natural-language parsing
├─ src-tauri/                Rust shell: windows, tray, autostart, notifications
│  ├─ src/main.rs
│  ├─ icons/
│  └─ tauri.conf.json
└─ PLAN.md
```

---

## 5. Build phases

| # | Phase | Outcome |
|---|---|---|
| 0 | **Environment setup** | Install Node, Rust, C++ Build Tools; scaffold Tauri + React app; empty window opens |
| 1 | **Data layer** | SQLite schema, migrations, task CRUD |
| 2 | **Task editor + Today view** | Create/edit/complete tasks incl. *Requires preparation*; Today, Upcoming deadlines, Prepare-for-tomorrow panels |
| 3 | **Calendar** | Month / week / day views, multi-day projects as continuous bars, drag/resize to reschedule |
| 4 | **Tray + overlay + autostart** | Tray icon under ^, summary pop-up, minimise-to-tray, start with Windows |
| 5 | **Reminders** | Notification scheduler running in the background |
| 6 | **Extras** | Recurring tasks, rollover, quick add, notes, habits, focus timer, search, themes (done; weekly review not built yet) |
| 7 | **Packaging** | Build `DailyPlanner.exe` + installer, app icon, backup/export (done: `npm run tauri build` → `src-tauri/target/release/bundle/nsis/`) |
| 8 | **Distribution prep** (optional) | Code signing, auto-updater, onboarding, settings polish |

Phases 0–4 deliver a fully usable personal planner (the MVP). Each phase ends with a working,
runnable build so it can be used day to day while the rest is added.

---

## 6. Open questions
1. Stack: Tauri (recommended) or Python/PySide6?
2. Visual style preference — minimal/clean, colourful, or similar to an app you already like?
3. Week starts Monday or Sunday? 12h or 24h time?
4. Is calendar sync (Google/Outlook) wanted early, or only at the distribution stage?
