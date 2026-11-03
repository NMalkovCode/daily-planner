//! Daily habits: a tick per day, with a streak and the last week at a glance.

use std::collections::HashSet;

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};
use serde::Serialize;

use super::{Error, Result};

const PALETTE: &[&str] = &["#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    pub id: i64,
    pub name: String,
    pub colour: String,
    pub done_today: bool,
    /// days in a row up to today (or up to yesterday, if today isn't ticked yet)
    pub streak: i64,
    /// the last 7 days, oldest first, ending with today
    pub last7: Vec<bool>,
}

fn day(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| Error::Invalid("Date must be YYYY-MM-DD".into()))
}

pub fn list(conn: &Connection, today: &str) -> Result<Vec<Habit>> {
    let today = day(today)?;
    let mut stmt = conn.prepare("SELECT id, name, colour FROM habits WHERE active = 1 ORDER BY id")?;
    let habits: Vec<(i64, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;

    let mut checks = conn.prepare("SELECT date FROM habit_checks WHERE habit_id = ?1 AND date <= ?2")?;
    habits
        .into_iter()
        .map(|(id, name, colour)| {
            let done: HashSet<NaiveDate> = checks
                .query_map(params![id, today.to_string()], |r| r.get::<_, String>(0))?
                .filter_map(|r| r.ok().and_then(|s| day(&s).ok()))
                .collect();
            let done_today = done.contains(&today);
            let mut streak = 0;
            let mut d = if done_today { today } else { today - Duration::days(1) };
            while done.contains(&d) {
                streak += 1;
                d -= Duration::days(1);
            }
            let last7 = (0..7).rev().map(|n| done.contains(&(today - Duration::days(n)))).collect();
            Ok(Habit { id, name, colour, done_today, streak, last7 })
        })
        .collect()
}

pub fn create(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Invalid("Habit name can't be empty".into()));
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM habits", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO habits (name, colour) VALUES (?1, ?2)",
        params![name, PALETTE[count as usize % PALETTE.len()]],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Hides a habit but keeps its history.
pub fn archive(conn: &Connection, id: i64) -> Result<()> {
    if conn.execute("UPDATE habits SET active = 0 WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
}

/// Ticks or unticks a day; returns whether it's now ticked.
pub fn toggle(conn: &Connection, id: i64, date: &str) -> Result<bool> {
    day(date)?;
    if conn.execute("DELETE FROM habit_checks WHERE habit_id = ?1 AND date = ?2", params![id, date])? > 0 {
        return Ok(false);
    }
    conn.execute("INSERT INTO habit_checks (habit_id, date) VALUES (?1, ?2)", params![id, date])?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn streaks_and_last_week() {
        let db = open_in_memory().unwrap();
        let id = create(&db, "Read 20 pages").unwrap();
        for d in ["2026-10-30", "2026-11-01", "2026-11-02"] {
            toggle(&db, id, d).unwrap();
        }
        let h = &list(&db, "2026-11-03").unwrap()[0];
        // not ticked today yet: the streak still counts up to yesterday
        assert_eq!((h.done_today, h.streak), (false, 2));
        assert_eq!(h.last7, [false, false, true, false, true, true, false]);

        assert!(toggle(&db, id, "2026-11-03").unwrap());
        assert_eq!(list(&db, "2026-11-03").unwrap()[0].streak, 3);
        assert!(!toggle(&db, id, "2026-11-03").unwrap());

        // a missed day breaks it
        assert_eq!(list(&db, "2026-11-05").unwrap()[0].streak, 0);
    }

    #[test]
    fn archived_habits_are_hidden() {
        let db = open_in_memory().unwrap();
        let a = create(&db, "Walk").unwrap();
        create(&db, "Stretch").unwrap();
        archive(&db, a).unwrap();
        let names: Vec<_> = list(&db, "2026-11-03").unwrap().into_iter().map(|h| h.name).collect();
        assert_eq!(names, ["Stretch"]);
        assert!(create(&db, "  ").is_err());
    }
}
