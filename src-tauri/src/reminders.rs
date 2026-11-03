//! Windows notifications: before a task starts, before deadlines, an evening
//! "prepare for tomorrow" nudge and a morning summary.
//!
//! Reminders aren't stored ahead of time. Every tick works out which ones are
//! due from the current tasks, so editing or moving a task just changes its
//! reminders. `notifications_sent` remembers what has been shown so nothing
//! fires twice. A reminder whose time passed while the PC was off or asleep
//! is still shown if it's within its grace period; older ones are skipped.

use std::time::Duration as StdDuration;

use chrono::{Duration, Local, NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::Db;
use crate::db::{settings, tasks, Result};

const TICK: StdDuration = StdDuration::from_secs(20);

pub struct Prefs {
    pub enabled: bool,
    /// minutes before a timed task starts; None = no start reminders
    pub start_lead_min: Option<i64>,
    pub deadlines: bool,
    pub prep_time: Option<NaiveTime>,
    pub morning_time: Option<NaiveTime>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            enabled: true,
            start_lead_min: Some(10),
            deadlines: true,
            prep_time: NaiveTime::from_hms_opt(19, 0, 0),
            morning_time: NaiveTime::from_hms_opt(8, 0, 0),
        }
    }
}

impl Prefs {
    /// Reads the `reminders.*` settings; "off" switches a reminder type off.
    pub fn load(conn: &Connection) -> Result<Prefs> {
        let d = Prefs::default();
        let get = |k: &str| settings::get(conn, k);
        let time = |v: Option<String>, default: Option<NaiveTime>| match v.as_deref() {
            None => default,
            Some("off") => None,
            Some(s) => NaiveTime::parse_from_str(s, "%H:%M").ok().or(default),
        };
        Ok(Prefs {
            enabled: get("reminders.enabled")?.as_deref() != Some("false"),
            start_lead_min: match get("reminders.startLead")?.as_deref() {
                None => d.start_lead_min,
                Some("off") => None,
                Some(s) => s.parse().ok().or(d.start_lead_min),
            },
            deadlines: get("reminders.deadlines")?.as_deref() != Some("false"),
            prep_time: time(get("reminders.prepTime")?, d.prep_time),
            morning_time: time(get("reminders.morningTime")?, d.morning_time),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reminder {
    pub key: String,
    pub at: NaiveDateTime,
    /// how long after `at` it's still worth showing
    pub grace: Duration,
    pub title: String,
    pub body: String,
}

fn at(date: NaiveDate, hhmm: &str) -> Option<NaiveDateTime> {
    Some(date.and_time(NaiveTime::parse_from_str(hhmm, "%H:%M").ok()?))
}

fn date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn minutes(n: i64) -> String {
    match (n / 60, n % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} hour{}", if h == 1 { "" } else { "s" }),
        (h, m) => format!("{h} h {m} min"),
    }
}

fn relative(today: NaiveDate, d: NaiveDate) -> String {
    match (d - today).num_days() {
        0 => "today".into(),
        1 => "tomorrow".into(),
        n => format!("in {n} days"),
    }
}

/// Lists a few task lines, then "and N more".
fn list(lines: Vec<String>) -> String {
    let more = lines.len().saturating_sub(3);
    let mut out: Vec<String> = lines.into_iter().take(3).collect();
    if more > 0 {
        out.push(format!("and {more} more"));
    }
    out.join("\n")
}

/// Every reminder that could be due around `now` (yesterday to tomorrow).
pub fn candidates(conn: &Connection, prefs: &Prefs, now: NaiveDateTime) -> Result<Vec<Reminder>> {
    let mut out = Vec::new();
    if !prefs.enabled {
        return Ok(out);
    }
    let today = now.date();
    let tomorrow = today + Duration::days(1);
    let (t0, t1) = (today.to_string(), tomorrow.to_string());
    let window = tasks::between(conn, &t0, &t1)?;

    if let Some(lead) = prefs.start_lead_min {
        for t in window.iter().filter(|t| t.status == "open") {
            // only on the first day of a multi-day task
            let (Some(d), Some(time)) = (t.date.as_deref().and_then(date), t.start_time.as_deref()) else { continue };
            let Some(start) = at(d, time) else { continue };
            let mut body = format!("{time}  {}", t.title);
            if t.requires_prep && !t.prep_done {
                body.push_str("\nPreparation not marked done yet");
            }
            out.push(Reminder {
                key: format!("start:{}:{start}", t.id),
                at: start - Duration::minutes(lead),
                grace: Duration::minutes(15),
                title: if lead == 0 { "Starting now".into() } else { format!("Starts in {}", minutes(lead)) },
                body,
            });
        }
    }

    if prefs.deadlines {
        let morning = prefs.morning_time.unwrap_or(NaiveTime::from_hms_opt(9, 0, 0).unwrap());
        for t in tasks::deadlines_between(conn, &t0, &t1)?.iter().filter(|t| t.status == "open") {
            let dl = t.deadline.as_deref().unwrap();
            let Some(day) = date(&dl[..10]) else { continue };
            if dl.len() > 10 {
                let Some(due) = at(day, &dl[11..]) else { continue };
                out.push(Reminder {
                    key: format!("deadline1h:{}:{dl}", t.id),
                    at: due - Duration::hours(1),
                    grace: Duration::minutes(50),
                    title: "Due in 1 hour".into(),
                    body: format!("{}  (by {})", t.title, &dl[11..]),
                });
                out.push(Reminder {
                    key: format!("deadline1d:{}:{dl}", t.id),
                    at: due - Duration::days(1),
                    grace: Duration::hours(12),
                    title: format!("Due tomorrow at {}", &dl[11..]),
                    body: t.title.clone(),
                });
            } else {
                for (on, title) in [(day, "Due today"), (day - Duration::days(1), "Due tomorrow")] {
                    out.push(Reminder {
                        key: format!("deadline:{}:{dl}:{on}", t.id),
                        at: on.and_time(morning),
                        grace: Duration::hours(12),
                        title: title.into(),
                        body: t.title.clone(),
                    });
                }
            }
        }
    }

    if let Some(time) = prefs.prep_time {
        let prep = tasks::prep_due(conn, &t0)?;
        if !prep.is_empty() {
            let all_tomorrow = prep.iter().all(|t| t.date.as_deref() == Some(t1.as_str()));
            let lines = prep
                .iter()
                .map(|t| {
                    let when = t.date.as_deref().and_then(date).map(|d| relative(today, d)).unwrap_or_default();
                    let notes = t.prep_notes.lines().next().unwrap_or("").trim();
                    if notes.is_empty() { format!("• {} ({when})", t.title) } else { format!("• {} ({when}): {notes}", t.title) }
                })
                .collect();
            let start = today.and_time(time);
            out.push(Reminder {
                key: format!("prep:{today}"),
                at: start,
                // any time until midnight
                grace: today.and_hms_opt(23, 59, 59).unwrap() - start,
                title: if all_tomorrow { "Prepare for tomorrow".into() } else { "Things to prepare".into() },
                body: list(lines),
            });
        }
    }

    if let Some(time) = prefs.morning_time {
        let s = tasks::day_summary(conn, &t0)?;
        let open: Vec<_> = s.tasks.iter().filter(|t| t.status == "open").collect();
        let due_today: Vec<_> = s
            .upcoming_deadlines
            .iter()
            .filter(|t| t.deadline.as_deref().is_some_and(|d| d.starts_with(&t0)))
            .collect();
        if !open.is_empty() || !due_today.is_empty() || !s.overdue.is_empty() || !s.prep_due.is_empty() {
            let mut lines = Vec::new();
            if let Some(first) = open.iter().find(|t| t.start_time.is_some() && t.end_date.is_none()) {
                lines.push(format!("First: {}  {}", first.start_time.as_deref().unwrap(), first.title));
            }
            if !due_today.is_empty() {
                lines.push(format!("Due today: {}", due_today.iter().map(|t| t.title.as_str()).collect::<Vec<_>>().join(", ")));
            }
            if !s.overdue.is_empty() {
                lines.push(format!("Overdue: {}", s.overdue.len()));
            }
            if !s.prep_due.is_empty() {
                lines.push(format!("To prepare: {}", s.prep_due.len()));
            }
            let start = today.and_time(time);
            out.push(Reminder {
                key: format!("morning:{today}"),
                at: start,
                grace: Duration::hours(6),
                title: match open.len() {
                    0 => "Good morning".into(),
                    1 => "Good morning — 1 task today".into(),
                    n => format!("Good morning — {n} tasks today"),
                },
                body: lines.join("\n"),
            });
        }
    }

    Ok(out)
}

fn was_sent(conn: &Connection, key: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM notifications_sent WHERE key = ?1", [key], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Reminders due at `now` that haven't been shown yet. They're recorded as
/// sent straight away.
pub fn take_due(conn: &Connection, prefs: &Prefs, now: NaiveDateTime) -> Result<Vec<Reminder>> {
    let mut due = Vec::new();
    for r in candidates(conn, prefs, now)? {
        if r.at <= now && now - r.at <= r.grace && !was_sent(conn, &r.key)? {
            conn.execute("INSERT OR IGNORE INTO notifications_sent (key) VALUES (?1)", [&r.key])?;
            due.push(r);
        }
    }
    due.sort_by_key(|r| r.at);
    Ok(due)
}

fn prune(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM notifications_sent WHERE sent_at < datetime('now', 'localtime', '-30 days')",
        params![],
    )?;
    Ok(())
}

pub fn show(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {e}");
    }
}

/// Checks for due reminders every few seconds on a background thread.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ticks: u64 = 0;
        let mut last_day = Local::now().date_naive();
        loop {
            let now = Local::now().naive_local();
            let due = {
                let db = app.state::<Db>();
                let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
                if ticks % 1000 == 0 {
                    let _ = prune(&conn);
                }
                // a new day: keep repeating tasks filled in ahead
                if now.date() != last_day {
                    last_day = now.date();
                    let _ = crate::db::recurrence::extend_all(&conn, &last_day.to_string());
                    let _ = crate::db::backup::daily_backup(&conn, &db.backups_dir(), &last_day.to_string());
                }
                Prefs::load(&conn).and_then(|p| take_due(&conn, &p, now)).unwrap_or_else(|e| {
                    eprintln!("reminders: {e}");
                    Vec::new()
                })
            };
            for r in due {
                show(&app, &r.title, &r.body);
            }
            ticks += 1;
            std::thread::sleep(TICK);
        }
    });
}

/// A notification from the front end, e.g. the focus timer finishing.
#[tauri::command]
pub fn notify_show(app: AppHandle, title: String, body: String) {
    show(&app, &title, &body);
}

#[tauri::command]
pub fn notify_test(app: AppHandle) {
    show(&app, "Daily Planner", "Notifications are working. You'll get reminders like this one.");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::tasks::{create, set_done, set_prep_done, TaskInput};

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    fn task(title: &str) -> TaskInput {
        TaskInput {
            title: title.into(),
            ..Default::default()
        }
    }

    fn titles(due: &[Reminder]) -> Vec<String> {
        due.iter().map(|r| format!("{} | {}", r.title, r.body.lines().next().unwrap_or(""))).collect()
    }

    /// Only start reminders, so other kinds don't get in the way.
    fn starts_only(lead: i64) -> Prefs {
        Prefs { start_lead_min: Some(lead), deadlines: false, prep_time: None, morning_time: None, ..Default::default() }
    }

    #[test]
    fn start_reminder_fires_once_at_lead_time_within_grace() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("09:30".into()), ..task("Stand-up") }).unwrap();
        let p = starts_only(10);

        assert!(take_due(&db, &p, dt("2026-11-03 09:19")).unwrap().is_empty());
        assert_eq!(titles(&take_due(&db, &p, dt("2026-11-03 09:20")).unwrap()), ["Starts in 10 min | 09:30  Stand-up"]);
        // already shown
        assert!(take_due(&db, &p, dt("2026-11-03 09:21")).unwrap().is_empty());
    }

    #[test]
    fn missed_start_reminder_is_skipped_after_grace() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("09:30".into()), ..task("Stand-up") }).unwrap();
        // PC woke up at 09:40: the 09:20 reminder is 20 min old, past its 15 min grace
        assert!(take_due(&db, &starts_only(10), dt("2026-11-03 09:40")).unwrap().is_empty());
    }

    #[test]
    fn start_reminder_crosses_midnight_and_skips_done_tasks() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { date: Some("2026-11-04".into()), start_time: Some("00:05".into()), ..task("Late call") }).unwrap();
        let done = create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("23:00".into()), ..task("Done") }).unwrap();
        set_done(&db, done.id, true).unwrap();
        let p = starts_only(15);
        assert!(take_due(&db, &p, dt("2026-11-03 22:45")).unwrap().is_empty());
        assert_eq!(titles(&take_due(&db, &p, dt("2026-11-03 23:50")).unwrap()), ["Starts in 15 min | 00:05  Late call"]);
    }

    #[test]
    fn moving_a_task_moves_its_reminder() {
        let db = open_in_memory().unwrap();
        let t = create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("09:30".into()), ..task("Gym") }).unwrap();
        crate::db::tasks::update(&db, t.id, TaskInput { date: Some("2026-11-03".into()), start_time: Some("18:00".into()), ..task("Gym") }).unwrap();
        let p = starts_only(0);
        assert!(take_due(&db, &p, dt("2026-11-03 09:30")).unwrap().is_empty());
        assert_eq!(titles(&take_due(&db, &p, dt("2026-11-03 18:00")).unwrap()), ["Starting now | 18:00  Gym"]);
    }

    #[test]
    fn deadline_reminders() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { deadline: Some("2026-11-04 17:00".into()), ..task("Report") }).unwrap();
        create(&db, TaskInput { deadline: Some("2026-11-04".into()), ..task("Tax return") }).unwrap();
        let p = Prefs { start_lead_min: None, prep_time: None, morning_time: NaiveTime::from_hms_opt(8, 0, 0), ..Default::default() };
        // morning_time also drives the summary; only deadlines exist, so check deadline titles
        let deadlines = |now| -> Vec<String> {
            titles(&take_due(&db, &p, dt(now)).unwrap()).into_iter().filter(|t| !t.starts_with("Good morning")).collect()
        };
        assert_eq!(deadlines("2026-11-03 08:00"), ["Due tomorrow | Tax return"]);
        assert_eq!(deadlines("2026-11-03 17:00"), ["Due tomorrow at 17:00 | Report"]);
        assert_eq!(deadlines("2026-11-04 08:00"), ["Due today | Tax return"]);
        assert_eq!(deadlines("2026-11-04 16:00"), ["Due in 1 hour | Report  (by 17:00)"]);
    }

    #[test]
    fn evening_prep_nudge_lists_tasks_and_stops_when_prepared() {
        let db = open_in_memory().unwrap();
        let interview = create(
            &db,
            TaskInput {
                date: Some("2026-11-04".into()),
                requires_prep: true,
                prep_notes: "Print CV\nIron shirt".into(),
                ..task("Interview")
            },
        )
        .unwrap();
        let p = Prefs { start_lead_min: None, deadlines: false, morning_time: None, ..Default::default() };
        assert!(take_due(&db, &p, dt("2026-11-03 18:59")).unwrap().is_empty());
        let due = take_due(&db, &p, dt("2026-11-03 21:30")).unwrap(); // late but before midnight
        assert_eq!(titles(&due), ["Prepare for tomorrow | • Interview (tomorrow): Print CV"]);

        // next day's window: nothing left once prepared
        set_prep_done(&db, interview.id, true).unwrap();
        assert!(candidates(&db, &p, dt("2026-11-03 19:00")).unwrap().is_empty());
    }

    #[test]
    fn morning_summary() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("09:30".into()), ..task("Stand-up") }).unwrap();
        create(&db, TaskInput { date: Some("2026-11-03".into()), ..task("Call the bank") }).unwrap();
        create(&db, TaskInput { deadline: Some("2026-11-03".into()), ..task("Library books") }).unwrap();
        let p = Prefs { start_lead_min: None, deadlines: false, prep_time: None, ..Default::default() };
        let due = take_due(&db, &p, dt("2026-11-03 08:00")).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].title, "Good morning — 2 tasks today");
        assert_eq!(due[0].body, "First: 09:30  Stand-up\nDue today: Library books");
    }

    #[test]
    fn settings_switch_reminders_off() {
        let db = open_in_memory().unwrap();
        create(&db, TaskInput { date: Some("2026-11-03".into()), start_time: Some("09:30".into()), ..task("Stand-up") }).unwrap();
        settings::set(&db, "reminders.startLead", "off").unwrap();
        settings::set(&db, "reminders.morningTime", "off").unwrap();
        let p = Prefs::load(&db).unwrap();
        assert!(candidates(&db, &p, dt("2026-11-03 09:20")).unwrap().is_empty());

        settings::set(&db, "reminders.startLead", "30").unwrap();
        settings::set(&db, "reminders.enabled", "false").unwrap();
        let p = Prefs::load(&db).unwrap();
        assert_eq!(p.start_lead_min, Some(30));
        assert!(candidates(&db, &p, dt("2026-11-03 09:00")).unwrap().is_empty());
    }
}
