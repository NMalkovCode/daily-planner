//! Recurring tasks.
//!
//! A series has a rule and an anchor date (its first task). Each repeat is a
//! normal task row linked by `series_id`, created up to `HORIZON_DAYS` ahead,
//! so repeats show in the calendar and can be ticked, moved or edited one by
//! one. New repeats copy the series' latest task. `generated_until` makes sure
//! a date is only ever generated once, so deleting one repeat doesn't bring it back.
//!
//! Rule format: `<freq>[/<interval>][:<weekdays>][;until=YYYY-MM-DD]`, e.g.
//! `daily`, `daily/2`, `weekdays`, `weekly:1,3` (Mon and Wed), `weekly/2:5`,
//! `monthly`, `yearly;until=2030-01-01`. Weekdays are 1 = Monday … 7 = Sunday.

use std::fmt;

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};

use super::tasks::{self, Task};
use super::{Error, Result};

/// How far ahead repeats are created.
pub const HORIZON_DAYS: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Freq {
    Daily,
    Weekdays,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    /// weekly only; empty means the anchor's weekday
    pub days: Vec<u32>,
    pub until: Option<NaiveDate>,
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn last_day(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1).unwrap().pred_opt().unwrap().day()
}

impl Rule {
    pub fn parse(s: &str) -> Option<Rule> {
        let mut parts = s.trim().split(';');
        let main = parts.next()?;
        let mut until = None;
        for p in parts {
            until = Some(parse_date(p.strip_prefix("until=")?)?);
        }
        let (head, days) = match main.split_once(':') {
            Some((h, d)) => (h, Some(d)),
            None => (main, None),
        };
        let (name, interval) = match head.split_once('/') {
            Some((n, i)) => (n, i.parse().ok().filter(|i| (1..=99).contains(i))?),
            None => (head, 1),
        };
        let freq = match name {
            "daily" => Freq::Daily,
            "weekdays" => Freq::Weekdays,
            "weekly" => Freq::Weekly,
            "monthly" => Freq::Monthly,
            "yearly" => Freq::Yearly,
            _ => return None,
        };
        let days = match days {
            None => Vec::new(),
            Some(d) if freq == Freq::Weekly => {
                let mut v: Vec<u32> = d
                    .split(',')
                    .map(|x| x.trim().parse().ok().filter(|n| (1..=7).contains(n)))
                    .collect::<Option<_>>()?;
                v.sort_unstable();
                v.dedup();
                v
            }
            Some(_) => return None,
        };
        Some(Rule { freq, interval, days, until })
    }

    /// Whether the series anchored on `anchor` has a task on `d`.
    pub fn matches(&self, anchor: NaiveDate, d: NaiveDate) -> bool {
        if d < anchor || self.until.is_some_and(|u| d > u) {
            return false;
        }
        let every = self.interval as i64;
        match self.freq {
            Freq::Daily => (d - anchor).num_days() % every == 0,
            Freq::Weekdays => d.weekday().number_from_monday() <= 5,
            Freq::Weekly => {
                let day = d.weekday().number_from_monday();
                let on_day = if self.days.is_empty() {
                    day == anchor.weekday().number_from_monday()
                } else {
                    self.days.contains(&day)
                };
                let monday = |x: NaiveDate| x - Duration::days(x.weekday().num_days_from_monday() as i64);
                on_day && ((monday(d) - monday(anchor)).num_days() / 7) % every == 0
            }
            Freq::Monthly => {
                let months = (d.year() - anchor.year()) as i64 * 12 + d.month() as i64 - anchor.month() as i64;
                months % every == 0 && d.day() == anchor.day().min(last_day(d.year(), d.month()))
            }
            Freq::Yearly => {
                (d.year() - anchor.year()) as i64 % every == 0
                    && d.month() == anchor.month()
                    && d.day() == anchor.day().min(last_day(d.year(), d.month()))
            }
        }
    }
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self.freq {
            Freq::Daily => "daily",
            Freq::Weekdays => "weekdays",
            Freq::Weekly => "weekly",
            Freq::Monthly => "monthly",
            Freq::Yearly => "yearly",
        };
        write!(f, "{name}")?;
        if self.interval > 1 && self.freq != Freq::Weekdays {
            write!(f, "/{}", self.interval)?;
        }
        if !self.days.is_empty() {
            let days: Vec<String> = self.days.iter().map(u32::to_string).collect();
            write!(f, ":{}", days.join(","))?;
        }
        if let Some(u) = self.until {
            write!(f, ";until={u}")?;
        }
        Ok(())
    }
}

/// Checks and normalises a rule string from the front end.
pub fn normalise(rule: &str) -> Result<String> {
    Rule::parse(rule)
        .map(|r| r.to_string())
        .ok_or_else(|| Error::Invalid("That repeat setting isn't valid".into()))
}

/// Turns an existing task into the first task of a new series and creates its repeats.
pub fn make_recurring(conn: &Connection, task_id: i64, rule: &str, today: &str) -> Result<()> {
    let rule = normalise(rule)?;
    let task = tasks::get(conn, task_id)?;
    let Some(date) = task.date else {
        return Err(Error::Invalid("A repeating task needs a date".into()));
    };
    conn.execute(
        "INSERT INTO series (rule, anchor_date, generated_until) VALUES (?1, ?2, ?2)",
        params![rule, date],
    )?;
    let series_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE tasks SET series_id = ?1, recurrence_rule = ?2 WHERE id = ?3",
        params![series_id, rule, task_id],
    )?;
    extend(conn, series_id, today)?;
    Ok(())
}

/// Creates the series' repeats up to `HORIZON_DAYS` after `today`. Returns how many were added.
pub fn extend(conn: &Connection, series_id: i64, today: &str) -> Result<usize> {
    let (rule, anchor, generated_until): (String, String, String) = conn.query_row(
        "SELECT rule, anchor_date, generated_until FROM series WHERE id = ?1",
        [series_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (Some(rule), Some(anchor), Some(generated), Some(today)) =
        (Rule::parse(&rule), parse_date(&anchor), parse_date(&generated_until), parse_date(today))
    else {
        return Ok(0);
    };
    let Some(template) = latest_task(conn, series_id)? else { return Ok(0) };
    let horizon = today + Duration::days(HORIZON_DAYS);

    let mut added = 0;
    let mut d = generated + Duration::days(1);
    while d <= horizon {
        if rule.matches(anchor, d) {
            copy_task(conn, &template, d)?;
            added += 1;
        }
        d += Duration::days(1);
    }
    if horizon > generated {
        conn.execute(
            "UPDATE series SET generated_until = ?1 WHERE id = ?2",
            params![horizon.to_string(), series_id],
        )?;
    }
    Ok(added)
}

/// Keeps every series topped up; called at startup and when the date changes.
pub fn extend_all(conn: &Connection, today: &str) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM series WHERE generated_until < date(?1, ?2)")?;
        let rows = stmt.query_map(params![today, format!("+{HORIZON_DAYS} days")], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for id in ids {
        extend(conn, id, today)?;
    }
    Ok(())
}

fn latest_task(conn: &Connection, series_id: i64) -> Result<Option<Task>> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM tasks WHERE series_id = ?1 AND parent_task_id IS NULL ORDER BY date DESC, id DESC LIMIT 1",
            [series_id],
            |r| r.get(0),
        )
        .optional()?;
    id.map(|id| tasks::get(conn, id)).transpose()
}

/// Copies `template` (and its subtasks, unticked) to `date`, keeping the
/// length of a multi-day task and how far before/after it the deadline falls.
fn copy_task(conn: &Connection, template: &Task, date: NaiveDate) -> Result<i64> {
    let base = template.date.as_deref().and_then(parse_date).unwrap_or(date);
    let shift = |s: &str| parse_date(&s[..10]).map(|d| format!("{}{}", d + (date - base), &s[10..]));
    let end_date = template.end_date.as_deref().and_then(shift);
    let deadline = template.deadline.as_deref().and_then(shift);
    conn.execute(
        "INSERT INTO tasks (title, notes, date, end_date, start_time, duration_min, deadline, priority,
            category_id, requires_prep, prep_notes, prep_days_before, recurrence_rule, series_id, sort_order)
         SELECT title, notes, ?2, ?3, start_time, duration_min, ?4, priority,
            category_id, requires_prep, prep_notes, prep_days_before, recurrence_rule, series_id, sort_order
         FROM tasks WHERE id = ?1",
        params![template.id, date.to_string(), end_date, deadline],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO tasks (title, notes, priority, parent_task_id, sort_order)
         SELECT title, notes, priority, ?2, sort_order FROM tasks WHERE parent_task_id = ?1 ORDER BY sort_order, id",
        params![template.id, id],
    )?;
    Ok(id)
}

/// Removes repeats after `task` that haven't been done, and stops the series
/// from generating anything from `task`'s date on.
fn cut_series_at(conn: &Connection, series_id: i64, task: &Task) -> Result<()> {
    let date = task.date.clone().unwrap_or_default();
    conn.execute(
        "DELETE FROM tasks WHERE series_id = ?1 AND id != ?2 AND parent_task_id IS NULL
            AND status = 'open' AND date > ?3",
        params![series_id, task.id, date],
    )?;
    let rule: String = conn.query_row("SELECT rule FROM series WHERE id = ?1", [series_id], |r| r.get(0))?;
    if let (Some(mut rule), Some(d)) = (Rule::parse(&rule), parse_date(&date)) {
        let end = d - Duration::days(1);
        rule.until = Some(rule.until.map_or(end, |u| u.min(end)));
        conn.execute("UPDATE series SET rule = ?1 WHERE id = ?2", params![rule.to_string(), series_id])?;
    }
    Ok(())
}

/// After a task was edited with "this and later ones": its later repeats are
/// replaced by a new series starting from this task (or none if `rule` is None).
pub fn change_from(conn: &Connection, task_id: i64, rule: Option<&str>, today: &str) -> Result<()> {
    let task = tasks::get(conn, task_id)?;
    if let Some(series_id) = task.series_id {
        cut_series_at(conn, series_id, &task)?;
        conn.execute("UPDATE tasks SET series_id = NULL, recurrence_rule = NULL WHERE id = ?1", [task_id])?;
    }
    if let Some(rule) = rule {
        make_recurring(conn, task_id, rule, today)?;
    }
    Ok(())
}

/// Deletes a task and the repeats after it that haven't been done.
pub fn delete_from(conn: &Connection, task_id: i64) -> Result<()> {
    let task = tasks::get(conn, task_id)?;
    if let Some(series_id) = task.series_id {
        cut_series_at(conn, series_id, &task)?;
    }
    tasks::delete(conn, task_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::tasks::{create, delete, get, set_done, subtasks, update, TaskInput};

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    fn dates(rule: &str, anchor: &str, from: &str, to: &str) -> Vec<String> {
        let r = Rule::parse(rule).unwrap();
        let mut out = Vec::new();
        let mut x = d(from);
        while x <= d(to) {
            if r.matches(d(anchor), x) {
                out.push(x.format("%d").to_string());
            }
            x += Duration::days(1);
        }
        out
    }

    #[test]
    fn rules_round_trip() {
        for s in ["daily", "daily/3", "weekdays", "weekly", "weekly:1,3,5", "weekly/2:2", "monthly", "yearly;until=2030-01-01"] {
            assert_eq!(Rule::parse(s).unwrap().to_string(), s);
        }
        assert_eq!(normalise("weekly:5,1,1").unwrap(), "weekly:1,5");
        for bad in ["", "hourly", "daily/0", "weekly:8", "monthly:1", "daily;until=soon"] {
            assert!(Rule::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn rule_dates() {
        // Tue 3 Nov 2026
        assert_eq!(dates("daily/2", "2026-11-03", "2026-11-01", "2026-11-10"), ["03", "05", "07", "09"]);
        assert_eq!(dates("weekdays", "2026-11-03", "2026-11-06", "2026-11-10"), ["06", "09", "10"]);
        assert_eq!(dates("weekly", "2026-11-03", "2026-11-01", "2026-11-20"), ["03", "10", "17"]);
        assert_eq!(dates("weekly:1,3", "2026-11-03", "2026-11-01", "2026-11-12"), ["04", "09", "11"]);
        assert_eq!(dates("weekly/2:1", "2026-11-03", "2026-11-01", "2026-11-30"), ["16", "30"]);
        assert_eq!(dates("daily;until=2026-11-05", "2026-11-03", "2026-11-01", "2026-11-10"), ["03", "04", "05"]);
        // the 31st falls back to the last day of shorter months
        let r = Rule::parse("monthly").unwrap();
        assert!(r.matches(d("2026-01-31"), d("2026-02-28")));
        assert!(r.matches(d("2026-01-31"), d("2026-04-30")));
        assert!(!r.matches(d("2026-01-31"), d("2026-04-29")));
        assert!(Rule::parse("yearly").unwrap().matches(d("2028-02-29"), d("2029-02-28")));
    }

    fn weekly_gym(db: &Connection) -> Task {
        create(
            db,
            TaskInput {
                title: "Gym".into(),
                date: Some("2026-11-03".into()),
                start_time: Some("18:00".into()),
                recurrence_rule: Some("weekly".into()),
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn series_dates(db: &Connection, series_id: i64) -> Vec<String> {
        let mut stmt = db.prepare("SELECT date FROM tasks WHERE series_id = ?1 AND parent_task_id IS NULL ORDER BY date").unwrap();
        stmt.query_map([series_id], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn creating_a_repeating_task_fills_the_next_60_days() {
        let db = open_in_memory().unwrap();
        let first = weekly_gym(&db);
        let sid = get(&db, first.id).unwrap().series_id.unwrap();
        let all = series_dates(&db, sid);
        // today in tests is the real date, so just check the shape
        assert_eq!(all[0], "2026-11-03");
        assert_eq!(all[1], "2026-11-10");
        assert!(all.len() >= 9, "{all:?}");
        let copy = tasks::between(&db, "2026-11-10", "2026-11-10").unwrap().remove(0);
        assert_eq!((copy.title.as_str(), copy.start_time.as_deref()), ("Gym", Some("18:00")));
        assert_eq!(copy.recurrence_rule.as_deref(), Some("weekly"));

        // topping up again adds nothing new
        let today = crate::db::today(&db).unwrap();
        assert_eq!(extend(&db, sid, &today).unwrap(), 0);
    }

    #[test]
    fn extend_moves_forward_with_today_and_never_recreates_deleted_repeats() {
        let db = open_in_memory().unwrap();
        let first = create(
            &db,
            TaskInput { title: "Water plants".into(), date: Some("2026-11-03".into()), ..Default::default() },
        )
        .unwrap();
        make_recurring(&db, first.id, "weekly", "2026-11-03").unwrap();
        let sid = get(&db, first.id).unwrap().series_id.unwrap();
        assert_eq!(series_dates(&db, sid).last().unwrap(), "2026-12-29"); // 3 Nov + 8 weeks

        let second = tasks::between(&db, "2026-11-10", "2026-11-10").unwrap().remove(0);
        delete(&db, second.id).unwrap();
        assert_eq!(extend(&db, sid, "2026-11-17").unwrap(), 2); // 5 and 12 Jan
        let all = series_dates(&db, sid);
        assert!(!all.contains(&"2026-11-10".to_string()));
        assert_eq!(all.last().unwrap(), "2027-01-12");
    }

    #[test]
    fn repeats_copy_span_deadline_and_subtasks() {
        let db = open_in_memory().unwrap();
        let first = create(
            &db,
            TaskInput {
                title: "Sprint".into(),
                date: Some("2026-11-02".into()),
                end_date: Some("2026-11-06".into()),
                deadline: Some("2026-11-06 17:00".into()),
                ..Default::default()
            },
        )
        .unwrap();
        create(&db, TaskInput { title: "Plan".into(), parent_task_id: Some(first.id), ..Default::default() }).unwrap();
        make_recurring(&db, first.id, "weekly/2", "2026-11-02").unwrap();
        let next = tasks::between(&db, "2026-11-16", "2026-11-16").unwrap().remove(0);
        assert_eq!(next.end_date.as_deref(), Some("2026-11-20"));
        assert_eq!(next.deadline.as_deref(), Some("2026-11-20 17:00"));
        let subs = subtasks(&db, next.id).unwrap();
        assert_eq!((subs.len(), subs[0].status.as_str()), (1, "open"));
    }

    #[test]
    fn completing_one_repeat_leaves_the_others() {
        let db = open_in_memory().unwrap();
        let first = weekly_gym(&db);
        set_done(&db, first.id, true).unwrap();
        let next = tasks::between(&db, "2026-11-10", "2026-11-10").unwrap().remove(0);
        assert_eq!(next.status, "open");
    }

    #[test]
    fn changing_this_and_later_ones() {
        let db = open_in_memory().unwrap();
        let first = weekly_gym(&db);
        let old_sid = get(&db, first.id).unwrap().series_id.unwrap();
        let third = tasks::between(&db, "2026-11-17", "2026-11-17").unwrap().remove(0);
        set_done(&db, tasks::between(&db, "2026-11-24", "2026-11-24").unwrap()[0].id, true).unwrap();

        // rename from the third one on, and move it to Thursdays
        update(
            &db,
            third.id,
            TaskInput { title: "Swim".into(), date: Some("2026-11-19".into()), start_time: Some("07:00".into()), ..Default::default() },
        )
        .unwrap();
        change_from(&db, third.id, Some("weekly"), "2026-11-03").unwrap();

        let old = series_dates(&db, old_sid);
        // earlier repeats stay; the ticked-off 24 Nov one is kept as history
        assert_eq!(old, ["2026-11-03", "2026-11-10", "2026-11-24"]);
        let new_sid = get(&db, third.id).unwrap().series_id.unwrap();
        assert_ne!(new_sid, old_sid);
        let new = series_dates(&db, new_sid);
        assert_eq!(&new[..3], ["2026-11-19", "2026-11-26", "2026-12-03"]);
        assert_eq!(tasks::between(&db, "2026-11-26", "2026-11-26").unwrap()[0].title, "Swim");
        // the old series doesn't grow back
        assert_eq!(extend(&db, old_sid, "2026-12-30").unwrap(), 0);

        // stop repeating from 3 Dec
        let dec3 = tasks::between(&db, "2026-12-03", "2026-12-03").unwrap().remove(0);
        change_from(&db, dec3.id, None, "2026-11-03").unwrap();
        assert_eq!(series_dates(&db, new_sid), ["2026-11-19", "2026-11-26"]);
        assert_eq!(get(&db, dec3.id).unwrap().series_id, None);
    }

    #[test]
    fn deleting_this_and_later_ones() {
        let db = open_in_memory().unwrap();
        let first = weekly_gym(&db);
        let sid = get(&db, first.id).unwrap().series_id.unwrap();
        let second = tasks::between(&db, "2026-11-10", "2026-11-10").unwrap().remove(0);
        delete_from(&db, second.id).unwrap();
        assert_eq!(series_dates(&db, sid), ["2026-11-03"]);
        assert_eq!(extend(&db, sid, "2027-03-01").unwrap(), 0);
    }

    #[test]
    fn invalid_rules_and_undated_tasks_are_rejected() {
        let db = open_in_memory().unwrap();
        let bad = TaskInput { title: "x".into(), date: Some("2026-11-03".into()), recurrence_rule: Some("sometimes".into()), ..Default::default() };
        assert!(create(&db, bad).is_err());
        let undated = TaskInput { title: "x".into(), recurrence_rule: Some("daily".into()), ..Default::default() };
        assert!(create(&db, undated).is_err());
    }
}
