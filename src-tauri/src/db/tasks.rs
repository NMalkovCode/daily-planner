use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::recurrence;
use super::validate::{is_date, is_date_or_datetime, is_time};
use super::{Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub notes: String,
    pub date: Option<String>,
    pub end_date: Option<String>,
    pub start_time: Option<String>,
    pub duration_min: Option<i64>,
    pub deadline: Option<String>,
    pub priority: String,
    pub category_id: Option<i64>,
    pub status: String,
    pub completed_at: Option<String>,
    pub requires_prep: bool,
    pub prep_notes: String,
    pub prep_days_before: i64,
    pub prep_done: bool,
    /// Repeat rule of the series this task belongs to (see recurrence::Rule).
    pub recurrence_rule: Option<String>,
    pub series_id: Option<i64>,
    pub parent_task_id: Option<i64>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// The editable fields of a task, used for both create and update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskInput {
    pub title: String,
    pub notes: String,
    pub date: Option<String>,
    pub end_date: Option<String>,
    pub start_time: Option<String>,
    pub duration_min: Option<i64>,
    pub deadline: Option<String>,
    pub priority: String,
    pub category_id: Option<i64>,
    pub requires_prep: bool,
    pub prep_notes: String,
    pub prep_days_before: i64,
    pub recurrence_rule: Option<String>,
    pub parent_task_id: Option<i64>,
}

impl Default for TaskInput {
    fn default() -> Self {
        Self {
            title: String::new(),
            notes: String::new(),
            date: None,
            end_date: None,
            start_time: None,
            duration_min: None,
            deadline: None,
            priority: "medium".into(),
            category_id: None,
            requires_prep: false,
            prep_notes: String::new(),
            prep_days_before: 1,
            recurrence_rule: None,
            parent_task_id: None,
        }
    }
}

/// Everything the Today view and the tray overlay show, in one call.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub today: String,
    pub tasks: Vec<Task>,
    pub overdue: Vec<Task>,
    pub upcoming_deadlines: Vec<Task>,
    pub prep_due: Vec<Task>,
}

/// How far ahead the "Upcoming deadlines" panel looks.
pub const UPCOMING_DAYS: i64 = 7;

// Scheduled tasks first by time, then all-day ones by priority.
const DAY_ORDER: &str = "start_time IS NULL, start_time, \
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, sort_order, id";

fn from_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get("id")?,
        title: r.get("title")?,
        notes: r.get("notes")?,
        date: r.get("date")?,
        end_date: r.get("end_date")?,
        start_time: r.get("start_time")?,
        duration_min: r.get("duration_min")?,
        deadline: r.get("deadline")?,
        priority: r.get("priority")?,
        category_id: r.get("category_id")?,
        status: r.get("status")?,
        completed_at: r.get("completed_at")?,
        requires_prep: r.get("requires_prep")?,
        prep_notes: r.get("prep_notes")?,
        prep_days_before: r.get("prep_days_before")?,
        prep_done: r.get("prep_done")?,
        recurrence_rule: r.get("recurrence_rule")?,
        series_id: r.get("series_id")?,
        parent_task_id: r.get("parent_task_id")?,
        sort_order: r.get("sort_order")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn query(conn: &Connection, where_order: &str, p: impl rusqlite::Params) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM tasks WHERE {where_order}"))?;
    let rows = stmt.query_map(p, from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Trims text, turns empty strings into `None` and rejects bad values.
fn clean(mut t: TaskInput, self_id: Option<i64>) -> Result<TaskInput> {
    fn opt(v: Option<String>) -> Option<String> {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    let bad = |msg: &str| Err(Error::Invalid(msg.into()));

    t.title = t.title.trim().to_string();
    t.date = opt(t.date);
    t.end_date = opt(t.end_date);
    t.start_time = opt(t.start_time);
    t.deadline = opt(t.deadline);
    t.recurrence_rule = opt(t.recurrence_rule);

    if t.title.is_empty() {
        return bad("Task title can't be empty");
    }
    if t.date.as_deref().is_some_and(|d| !is_date(d)) {
        return bad("Start date must be YYYY-MM-DD");
    }
    if let Some(end) = t.end_date.as_deref() {
        if !is_date(end) {
            return bad("End date must be YYYY-MM-DD");
        }
        match t.date.as_deref() {
            None => return bad("A task with an end date needs a start date"),
            Some(start) if end < start => return bad("End date can't be before the start date"),
            // a one-day "span" is just a normal task
            Some(start) if end == start => t.end_date = None,
            _ => {}
        }
    }
    if t.start_time.as_deref().is_some_and(|s| !is_time(s)) {
        return bad("Start time must be HH:MM");
    }
    if t.duration_min.is_some_and(|d| d <= 0) {
        return bad("Duration must be more than 0 minutes");
    }
    if t.deadline.as_deref().is_some_and(|d| !is_date_or_datetime(d)) {
        return bad("Deadline must be YYYY-MM-DD or YYYY-MM-DD HH:MM");
    }
    if !matches!(t.priority.as_str(), "low" | "medium" | "high") {
        return bad("Priority must be low, medium or high");
    }
    if !(1..=60).contains(&t.prep_days_before) {
        return bad("Preparation must start 1 to 60 days before");
    }
    if self_id.is_some() && t.parent_task_id == self_id {
        return bad("A task can't be its own subtask");
    }
    if t.parent_task_id.is_some() {
        t.recurrence_rule = None; // subtasks repeat with their parent
    }
    if let Some(rule) = t.recurrence_rule.as_deref() {
        if t.date.is_none() {
            return bad("A repeating task needs a date");
        }
        t.recurrence_rule = Some(recurrence::normalise(rule)?);
    }
    Ok(t)
}

pub fn get(conn: &Connection, id: i64) -> Result<Task> {
    Ok(conn.query_row("SELECT * FROM tasks WHERE id = ?1", [id], from_row)?)
}

pub fn create(conn: &Connection, input: TaskInput) -> Result<Task> {
    let t = clean(input, None)?;
    conn.execute(
        "INSERT INTO tasks (title, notes, date, end_date, start_time, duration_min, deadline,
            priority, category_id, requires_prep, prep_notes, prep_days_before, parent_task_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            t.title, t.notes, t.date, t.end_date, t.start_time, t.duration_min, t.deadline,
            t.priority, t.category_id, t.requires_prep, t.prep_notes, t.prep_days_before,
            t.parent_task_id
        ],
    )?;
    let id = conn.last_insert_rowid();
    if let Some(rule) = t.recurrence_rule.as_deref() {
        recurrence::make_recurring(conn, id, rule, &super::today(conn)?)?;
    }
    get(conn, id)
}

/// Replaces the editable fields of this one task; completion status and its
/// repeat series are left as they were (see `save` for those).
pub fn update(conn: &Connection, id: i64, input: TaskInput) -> Result<Task> {
    update_fields(conn, id, clean(input, Some(id))?)
}

/// Saves an edit from the task editor. For a repeating task, `later_too` also
/// applies it to the later repeats; changing the repeat rule always does.
pub fn save(conn: &Connection, id: i64, input: TaskInput, later_too: bool) -> Result<Task> {
    let before = get(conn, id)?;
    let t = clean(input, Some(id))?;
    let rule = t.recurrence_rule.clone();
    update_fields(conn, id, t)?;
    let today = super::today(conn)?;
    match before.series_id {
        None => {
            if let Some(rule) = rule.as_deref() {
                recurrence::make_recurring(conn, id, rule, &today)?;
            }
        }
        Some(_) if later_too || rule != before.recurrence_rule => {
            recurrence::change_from(conn, id, rule.as_deref(), &today)?;
        }
        Some(_) => {}
    }
    get(conn, id)
}

fn update_fields(conn: &Connection, id: i64, t: TaskInput) -> Result<Task> {
    let changed = conn.execute(
        "UPDATE tasks SET title = ?1, notes = ?2, date = ?3, end_date = ?4, start_time = ?5,
            duration_min = ?6, deadline = ?7, priority = ?8, category_id = ?9,
            requires_prep = ?10, prep_notes = ?11, prep_days_before = ?12, parent_task_id = ?13,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?14",
        params![
            t.title, t.notes, t.date, t.end_date, t.start_time, t.duration_min, t.deadline,
            t.priority, t.category_id, t.requires_prep, t.prep_notes, t.prep_days_before,
            t.parent_task_id, id
        ],
    )?;
    if changed == 0 {
        return Err(Error::NotFound);
    }
    get(conn, id)
}

/// Deletes a task and its subtasks.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    if conn.execute("DELETE FROM tasks WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub fn set_done(conn: &Connection, id: i64, done: bool) -> Result<Task> {
    let changed = conn.execute(
        "UPDATE tasks SET status = CASE WHEN ?2 THEN 'done' ELSE 'open' END,
            completed_at = CASE WHEN ?2 THEN datetime('now', 'localtime') END,
            updated_at = datetime('now', 'localtime')
         WHERE id = ?1",
        params![id, done],
    )?;
    if changed == 0 {
        return Err(Error::NotFound);
    }
    get(conn, id)
}

/// Marks the preparation for a task as done without completing the task itself.
pub fn set_prep_done(conn: &Connection, id: i64, done: bool) -> Result<Task> {
    let changed = conn.execute(
        "UPDATE tasks SET prep_done = ?2, updated_at = datetime('now', 'localtime') WHERE id = ?1",
        params![id, done],
    )?;
    if changed == 0 {
        return Err(Error::NotFound);
    }
    get(conn, id)
}

/// Moves or resizes a task, e.g. when its bar is dragged in the calendar.
pub fn set_dates(conn: &Connection, id: i64, date: Option<String>, end_date: Option<String>) -> Result<Task> {
    let current = get(conn, id)?;
    let input = TaskInput {
        date,
        end_date,
        ..to_input(current)
    };
    update(conn, id, input)
}

fn to_input(t: Task) -> TaskInput {
    TaskInput {
        title: t.title,
        notes: t.notes,
        date: t.date,
        end_date: t.end_date,
        start_time: t.start_time,
        duration_min: t.duration_min,
        deadline: t.deadline,
        priority: t.priority,
        category_id: t.category_id,
        requires_prep: t.requires_prep,
        prep_notes: t.prep_notes,
        prep_days_before: t.prep_days_before,
        recurrence_rule: t.recurrence_rule,
        parent_task_id: t.parent_task_id,
    }
}

/// Top-level tasks that touch any day from `from` to `to` (inclusive),
/// including multi-day projects that start before or end after the range.
pub fn between(conn: &Connection, from: &str, to: &str) -> Result<Vec<Task>> {
    query(
        conn,
        &format!(
            "parent_task_id IS NULL AND date <= ?2 AND COALESCE(end_date, date) >= ?1
             ORDER BY date, end_date IS NULL, {DAY_ORDER}"
        ),
        params![from, to],
    )
}

/// Top-level tasks on one day, in the order the Today view shows them.
pub fn for_day(conn: &Connection, day: &str) -> Result<Vec<Task>> {
    query(
        conn,
        &format!(
            "parent_task_id IS NULL AND date <= ?1 AND COALESCE(end_date, date) >= ?1
             ORDER BY end_date IS NULL, {DAY_ORDER}"
        ),
        [day],
    )
}

pub fn subtasks(conn: &Connection, parent_id: i64) -> Result<Vec<Task>> {
    query(conn, "parent_task_id = ?1 ORDER BY sort_order, id", [parent_id])
}

/// Single-day tasks from before `today` that were never ticked off (not
/// repeating ones, which come round again anyway).
pub fn unfinished_before(conn: &Connection, today: &str) -> Result<Vec<Task>> {
    query(
        conn,
        "parent_task_id IS NULL AND status = 'open' AND series_id IS NULL
           AND end_date IS NULL AND date < ?1
         ORDER BY date, start_time IS NULL, start_time, id",
        [today],
    )
}

/// Moves tasks to `date`, keeping their times.
pub fn move_to(conn: &Connection, ids: &[i64], date: &str) -> Result<()> {
    for &id in ids {
        set_dates(conn, id, Some(date.to_string()), None)?;
    }
    Ok(())
}

/// Tasks whose title or notes contain `text`: open ones first, then the most recent.
pub fn search(conn: &Connection, text: &str) -> Result<Vec<Task>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    query(
        conn,
        "(title LIKE ?1 ESCAPE '\\' OR notes LIKE ?1 ESCAPE '\\' OR prep_notes LIKE ?1 ESCAPE '\\')
         ORDER BY status = 'done', date IS NULL, abs(julianday(date) - julianday('now', 'localtime')), id DESC
         LIMIT 50",
        [like],
    )
}

/// Open tasks with no date yet.
pub fn unscheduled(conn: &Connection) -> Result<Vec<Task>> {
    query(
        conn,
        "parent_task_id IS NULL AND date IS NULL AND status = 'open' ORDER BY created_at, id",
        params![],
    )
}

/// Open tasks whose deadline has passed.
pub fn overdue(conn: &Connection, today: &str) -> Result<Vec<Task>> {
    query(
        conn,
        "status = 'open' AND deadline IS NOT NULL AND substr(deadline, 1, 10) < ?1
         ORDER BY deadline, id",
        [today],
    )
}

/// Open tasks with a deadline from today up to `days` days ahead.
pub fn upcoming_deadlines(conn: &Connection, today: &str, days: i64) -> Result<Vec<Task>> {
    query(
        conn,
        "status = 'open' AND deadline IS NOT NULL
           AND substr(deadline, 1, 10) >= ?1
           AND substr(deadline, 1, 10) <= date(?1, '+' || ?2 || ' days')
         ORDER BY deadline, id",
        params![today, days],
    )
}

/// Tasks (and subtasks) with a deadline from `from` to `to`, for calendar markers.
pub fn deadlines_between(conn: &Connection, from: &str, to: &str) -> Result<Vec<Task>> {
    query(
        conn,
        "deadline IS NOT NULL AND substr(deadline, 1, 10) BETWEEN ?1 AND ?2 ORDER BY deadline, id",
        params![from, to],
    )
}

/// Future tasks marked "requires preparation" whose preparation window has
/// started (the task is within `prep_days_before` days) and isn't done yet.
pub fn prep_due(conn: &Connection, today: &str) -> Result<Vec<Task>> {
    query(
        conn,
        "status = 'open' AND requires_prep = 1 AND prep_done = 0
           AND date > ?1
           AND date(date, '-' || prep_days_before || ' days') <= ?1
         ORDER BY date, start_time IS NULL, start_time, id",
        [today],
    )
}

pub fn day_summary(conn: &Connection, today: &str) -> Result<DaySummary> {
    Ok(DaySummary {
        today: today.to_string(),
        tasks: for_day(conn, today)?,
        overdue: overdue(conn, today)?,
        upcoming_deadlines: upcoming_deadlines(conn, today, UPCOMING_DAYS)?,
        prep_due: prep_due(conn, today)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn task(title: &str) -> TaskInput {
        TaskInput {
            title: title.into(),
            ..Default::default()
        }
    }

    fn on(title: &str, date: &str) -> TaskInput {
        TaskInput {
            date: Some(date.into()),
            ..task(title)
        }
    }

    fn titles(tasks: &[Task]) -> Vec<&str> {
        tasks.iter().map(|t| t.title.as_str()).collect()
    }

    #[test]
    fn create_get_update_delete() {
        let db = open_in_memory().unwrap();
        let t = create(&db, on("  Write report  ", "2026-11-03")).unwrap();
        assert_eq!(t.title, "Write report");
        assert_eq!(t.status, "open");
        assert_eq!(get(&db, t.id).unwrap(), t);

        let mut input = on("Write final report", "2026-11-04");
        input.priority = "high".into();
        let u = update(&db, t.id, input).unwrap();
        assert_eq!((u.title.as_str(), u.priority.as_str()), ("Write final report", "high"));

        delete(&db, t.id).unwrap();
        assert!(matches!(get(&db, t.id), Err(Error::NotFound)));
        assert!(matches!(delete(&db, t.id), Err(Error::NotFound)));
    }

    #[test]
    fn rejects_invalid_input() {
        let db = open_in_memory().unwrap();
        assert!(create(&db, task("   ")).is_err());
        assert!(create(&db, on("x", "2026-02-30")).is_err());
        let mut backwards = on("x", "2026-11-10");
        backwards.end_date = Some("2026-11-05".into());
        assert!(create(&db, backwards).is_err());
        let mut no_start = task("x");
        no_start.end_date = Some("2026-11-05".into());
        assert!(create(&db, no_start).is_err());
        let mut bad_prio = task("x");
        bad_prio.priority = "urgent".into();
        assert!(create(&db, bad_prio).is_err());
    }

    #[test]
    fn same_day_end_date_is_dropped() {
        let db = open_in_memory().unwrap();
        let mut input = on("x", "2026-11-03");
        input.end_date = Some("2026-11-03".into());
        assert_eq!(create(&db, input).unwrap().end_date, None);
    }

    #[test]
    fn six_day_project_appears_on_every_day_of_its_span() {
        let db = open_in_memory().unwrap();
        let mut project = on("Kitchen renovation", "2026-11-02");
        project.end_date = Some("2026-11-07".into());
        create(&db, project).unwrap();
        create(&db, on("Dentist", "2026-11-05")).unwrap();

        for day in ["2026-11-02", "2026-11-04", "2026-11-07"] {
            assert!(titles(&for_day(&db, day).unwrap()).contains(&"Kitchen renovation"), "{day}");
        }
        assert!(for_day(&db, "2026-11-01").unwrap().is_empty());
        assert!(for_day(&db, "2026-11-08").unwrap().is_empty());

        // a calendar range that only overlaps the end of the project still gets it
        assert_eq!(titles(&between(&db, "2026-11-06", "2026-11-12").unwrap()), ["Kitchen renovation"]);
        // spans come before single-day tasks starting the same week
        assert_eq!(
            titles(&between(&db, "2026-11-01", "2026-11-30").unwrap()),
            ["Kitchen renovation", "Dentist"]
        );
    }

    #[test]
    fn day_order_is_timed_first_then_priority() {
        let db = open_in_memory().unwrap();
        let day = "2026-11-03";
        let mut low = on("low all-day", day);
        low.priority = "low".into();
        let mut high = on("high all-day", day);
        high.priority = "high".into();
        let mut late = on("15:00 meeting", day);
        late.start_time = Some("15:00".into());
        let mut early = on("09:00 standup", day);
        early.start_time = Some("09:00".into());
        for t in [low, high, late, early] {
            create(&db, t).unwrap();
        }
        assert_eq!(
            titles(&for_day(&db, day).unwrap()),
            ["09:00 standup", "15:00 meeting", "high all-day", "low all-day"]
        );
    }

    #[test]
    fn deadlines_upcoming_and_overdue() {
        let db = open_in_memory().unwrap();
        let today = "2026-11-03";
        let with_deadline = |title: &str, d: &str| TaskInput {
            deadline: Some(d.into()),
            ..task(title)
        };
        create(&db, with_deadline("missed", "2026-11-01")).unwrap();
        create(&db, with_deadline("today 17:00", "2026-11-03 17:00")).unwrap();
        create(&db, with_deadline("in a week", "2026-11-10")).unwrap();
        create(&db, with_deadline("too far", "2026-11-11")).unwrap();
        let done = create(&db, with_deadline("finished", "2026-11-05")).unwrap();
        set_done(&db, done.id, true).unwrap();

        assert_eq!(titles(&overdue(&db, today).unwrap()), ["missed"]);
        assert_eq!(
            titles(&deadlines_between(&db, "2026-11-03", "2026-11-05").unwrap()),
            ["today 17:00", "finished"]
        );
        assert_eq!(
            titles(&upcoming_deadlines(&db, today, 7).unwrap()),
            ["today 17:00", "in a week"]
        );
    }

    #[test]
    fn prep_shows_from_prep_days_before_until_done() {
        let db = open_in_memory().unwrap();
        let prep = |title: &str, date: &str, days: i64| TaskInput {
            requires_prep: true,
            prep_days_before: days,
            ..on(title, date)
        };
        let interview = create(&db, prep("Interview", "2026-11-04", 1)).unwrap();
        create(&db, prep("Exam", "2026-11-06", 3)).unwrap();
        create(&db, prep("Talk", "2026-11-07", 3)).unwrap();
        create(&db, on("No prep needed", "2026-11-04")).unwrap();
        create(&db, prep("Today", "2026-11-03", 1)).unwrap();

        // "Today" is no longer something to prepare for on its own day
        assert_eq!(titles(&prep_due(&db, "2026-11-03").unwrap()), ["Interview", "Exam"]);
        // ...but it was the day before; "Exam" hadn't entered its 3-day window yet
        assert_eq!(titles(&prep_due(&db, "2026-11-02").unwrap()), ["Today"]);
        assert_eq!(titles(&prep_due(&db, "2026-11-01").unwrap()), Vec::<&str>::new());

        set_prep_done(&db, interview.id, true).unwrap();
        assert_eq!(titles(&prep_due(&db, "2026-11-03").unwrap()), ["Exam"]);
    }

    #[test]
    fn completing_and_reopening() {
        let db = open_in_memory().unwrap();
        let t = create(&db, task("x")).unwrap();
        let done = set_done(&db, t.id, true).unwrap();
        assert_eq!(done.status, "done");
        assert!(done.completed_at.is_some());
        let reopened = set_done(&db, t.id, false).unwrap();
        assert_eq!(reopened.status, "open");
        assert_eq!(reopened.completed_at, None);
    }

    #[test]
    fn unfinished_tasks_from_earlier_days_can_be_moved_to_today() {
        let db = open_in_memory().unwrap();
        let mut late = on("Call the bank", "2026-11-01");
        late.start_time = Some("10:00".into());
        let late = create(&db, late).unwrap();
        let done = create(&db, on("Done already", "2026-11-02")).unwrap();
        set_done(&db, done.id, true).unwrap();
        create(&db, on("Today", "2026-11-03")).unwrap();
        let mut span = on("Old project", "2026-10-20");
        span.end_date = Some("2026-10-25".into());
        create(&db, span).unwrap();

        let left = unfinished_before(&db, "2026-11-03").unwrap();
        assert_eq!(titles(&left), ["Call the bank"]);
        move_to(&db, &[late.id], "2026-11-03").unwrap();
        let moved = get(&db, late.id).unwrap();
        assert_eq!((moved.date.as_deref(), moved.start_time.as_deref()), (Some("2026-11-03"), Some("10:00")));
        assert!(unfinished_before(&db, "2026-11-03").unwrap().is_empty());
    }

    #[test]
    fn search_matches_title_and_notes() {
        let db = open_in_memory().unwrap();
        create(&db, on("Dentist appointment", "2026-11-05")).unwrap();
        let mut t = task("Errands");
        t.notes = "pick up the dentist form".into();
        create(&db, t).unwrap();
        create(&db, task("100% done")).unwrap();
        create(&db, task("Gym")).unwrap();
        let results = search(&db, "DENTIST").unwrap();
        let mut found = titles(&results);
        found.sort();
        assert_eq!(found, ["Dentist appointment", "Errands"]);
        assert_eq!(titles(&search(&db, "%").unwrap()), ["100% done"]);
        assert!(search(&db, "  ").unwrap().is_empty());
    }

    #[test]
    fn subtasks_are_deleted_with_their_parent() {
        let db = open_in_memory().unwrap();
        let parent = create(&db, on("Trip", "2026-11-10")).unwrap();
        let sub = TaskInput {
            parent_task_id: Some(parent.id),
            ..task("Book hotel")
        };
        create(&db, sub).unwrap();
        assert_eq!(titles(&subtasks(&db, parent.id).unwrap()), ["Book hotel"]);
        // subtasks don't show up as separate items on the day
        assert_eq!(titles(&for_day(&db, "2026-11-10").unwrap()), ["Trip"]);

        delete(&db, parent.id).unwrap();
        assert!(subtasks(&db, parent.id).unwrap().is_empty());
    }

    #[test]
    fn set_dates_moves_a_project_and_keeps_other_fields() {
        let db = open_in_memory().unwrap();
        let mut input = on("Project", "2026-11-02");
        input.end_date = Some("2026-11-07".into());
        input.notes = "keep me".into();
        let t = create(&db, input).unwrap();
        let moved = set_dates(&db, t.id, Some("2026-11-09".into()), Some("2026-11-14".into())).unwrap();
        assert_eq!(moved.date.as_deref(), Some("2026-11-09"));
        assert_eq!(moved.end_date.as_deref(), Some("2026-11-14"));
        assert_eq!(moved.notes, "keep me");
    }
}
