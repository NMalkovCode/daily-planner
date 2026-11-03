//! Backups and export.
//!
//! - **Backup file** (`.json`): every table, readable and future-proof. A
//!   restore replaces all data with the file's contents.
//! - **Automatic backups**: once a day a copy of the database goes to the
//!   `backups` folder next to it; the newest `KEEP_DAILY` are kept. These
//!   `.db` files can be restored the same way as a `.json` backup.
//! - **Calendar export** (`.ics`): dated tasks as events for Google Calendar,
//!   Outlook, Apple Calendar and the like.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::{tasks, Error, Result};

const APP: &str = "Daily Planner";
/// Tables in a backup, parents before children.
const TABLES: &[&str] = &["categories", "series", "tasks", "habits", "habit_checks", "daily_notes", "settings"];
pub const KEEP_DAILY: usize = 14;

fn io(action: &str, e: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("Couldn't {action}: {e}"))
}

fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

/// Column names of `table`, or none if the table doesn't exist (an older backup).
fn columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let cols = stmt.query_map([table], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(cols)
}

pub fn to_json(conn: &Connection) -> Result<Value> {
    let mut tables = Map::new();
    for &table in TABLES {
        let cols = columns(conn, table)?;
        if cols.is_empty() {
            continue;
        }
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
        let rows = stmt
            .query_map([], |r| {
                let mut row = Map::new();
                for (i, col) in cols.iter().enumerate() {
                    let v = match r.get_ref(i)? {
                        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(f) => json!(f),
                        ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                    };
                    row.insert(col.clone(), v);
                }
                Ok(Value::Object(row))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        tables.insert(table.to_string(), Value::Array(rows));
    }
    let exported: String = conn.query_row("SELECT datetime('now', 'localtime')", [], |r| r.get(0))?;
    Ok(json!({ "app": APP, "schemaVersion": schema_version(conn)?, "exportedAt": exported, "tables": tables }))
}

pub fn export_json(conn: &Connection, path: &Path) -> Result<()> {
    let text = serde_json::to_string_pretty(&to_json(conn)?).map_err(|e| io("create the backup", e))?;
    fs::write(path, text).map_err(|e| io("save the backup", e))
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub tasks: usize,
    pub habits: usize,
    pub notes: usize,
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Replaces all data with a backup's. Everything happens in one transaction,
/// so a bad file leaves the current data untouched.
pub fn restore_json(conn: &Connection, backup: &Value) -> Result<Restored> {
    let bad = |m: &str| Err(Error::Invalid(m.into()));
    if backup["app"] != APP {
        return bad("That file isn't a Daily Planner backup");
    }
    if backup["schemaVersion"].as_i64().unwrap_or(i64::MAX) > schema_version(conn)? {
        return bad("That backup is from a newer version of Daily Planner. Update the app first.");
    }
    let Some(tables) = backup["tables"].as_object() else { return bad("The backup file is damaged") };

    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        let tx = conn.unchecked_transaction()?;
        for table in TABLES.iter().rev() {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        let mut counts = Restored { tasks: 0, habits: 0, notes: 0 };
        for &table in TABLES {
            let cols = columns(&tx, table)?;
            let rows = tables.get(table).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            for row in rows {
                let Some(obj) = row.as_object() else { return bad("The backup file is damaged") };
                // only known columns are used, so a backup can't inject SQL
                let keys: Vec<&String> = obj.keys().filter(|k| cols.contains(k)).collect();
                if keys.is_empty() {
                    continue;
                }
                let names: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
                let marks: Vec<String> = (1..=keys.len()).map(|i| format!("?{i}")).collect();
                let sql = format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), marks.join(", "));
                tx.execute(&sql, params_from_iter(keys.iter().map(|k| to_sql(&obj[*k]))))?;
            }
            match table {
                "tasks" => counts.tasks = rows.len(),
                "habits" => counts.habits = rows.len(),
                "daily_notes" => counts.notes = rows.len(),
                _ => {}
            }
        }
        let broken: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
        if broken > 0 {
            return bad("The backup file is damaged (it refers to missing items)");
        }
        tx.commit()?;
        Ok(counts)
    })();
    conn.pragma_update(None, "foreign_keys", true)?;
    result
}

/// Restores from a `.json` backup or one of the automatic `.db` backups,
/// first saving a copy of the current data in `backups_dir`.
pub fn restore_file(conn: &Connection, path: &Path, backups_dir: &Path) -> Result<Restored> {
    let backup = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("db")) {
        let other = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| io("open that backup", e))?;
        let mut json = to_json(&other)?;
        json["app"] = json!(APP);
        json
    } else {
        let text = fs::read_to_string(path).map_err(|e| io("read that file", e))?;
        serde_json::from_str(&text).map_err(|_| Error::Invalid("That file isn't a Daily Planner backup".into()))?
    };
    let stamp: String = conn.query_row("SELECT strftime('%Y-%m-%d-%H%M%S', 'now', 'localtime')", [], |r| r.get(0))?;
    copy_to(conn, backups_dir, &format!("before-restore-{stamp}.db"))?;
    restore_json(conn, &backup)
}

fn copy_to(conn: &Connection, dir: &Path, name: &str) -> Result<PathBuf> {
    fs::create_dir_all(dir).map_err(|e| io("create the backups folder", e))?;
    let path = dir.join(name);
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
    Ok(path)
}

/// Makes today's automatic backup if there isn't one yet and keeps the newest `KEEP_DAILY`.
pub fn daily_backup(conn: &Connection, dir: &Path, today: &str) -> Result<()> {
    let name = format!("planner-{today}.db");
    if !dir.join(&name).exists() {
        copy_to(conn, dir, &name)?;
    }
    let mut daily: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| io("read the backups folder", e))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("planner-") && n.ends_with(".db")))
        .collect();
    daily.sort();
    for old in daily.iter().rev().skip(KEEP_DAILY) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsInfo {
    pub folder: String,
    /// date of the newest automatic backup
    pub latest: Option<String>,
    pub count: usize,
}

pub fn info(dir: &Path) -> BackupsInfo {
    let mut dates: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|n| n.strip_prefix("planner-")?.strip_suffix(".db").map(str::to_string))
        .collect();
    dates.sort();
    BackupsInfo { folder: dir.display().to_string(), count: dates.len(), latest: dates.pop() }
}

// ---- calendar export ----

fn ics_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace("\r\n", "\\n").replace('\n', "\\n")
}

/// Splits lines longer than 75 bytes, as the iCalendar format requires.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in line.chars() {
        if len + ch.len_utf8() > 75 {
            out.push_str("\r\n ");
            len = 1;
        }
        out.push(ch);
        len += ch.len_utf8();
    }
    out
}

pub fn to_ics(conn: &Connection) -> Result<String> {
    let all = tasks::between(conn, "0000-01-01", "9999-12-31")?;
    let categories: std::collections::HashMap<i64, String> = {
        let mut stmt = conn.prepare("SELECT id, name FROM categories")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let compact = |d: NaiveDate| d.format("%Y%m%d").to_string();

    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".into(),
        "PRODID:-//Daily Planner//Daily Planner//EN".into(),
        "CALSCALE:GREGORIAN".into(),
        "X-WR-CALNAME:Daily Planner".into(),
    ];
    for t in &all {
        let Some(date) = t.date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) else { continue };
        lines.push("BEGIN:VEVENT".into());
        lines.push(format!("UID:task-{}@dailyplanner", t.id));
        lines.push(format!("DTSTAMP:{stamp}"));
        let time = t.start_time.as_deref().and_then(|s| NaiveTime::parse_from_str(s, "%H:%M").ok());
        match (time, &t.end_date) {
            (Some(time), None) => {
                let start = date.and_time(time);
                let end = start + Duration::minutes(t.duration_min.unwrap_or(30));
                lines.push(format!("DTSTART:{}", start.format("%Y%m%dT%H%M%S")));
                lines.push(format!("DTEND:{}", end.format("%Y%m%dT%H%M%S")));
            }
            _ => {
                let last = t.end_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).unwrap_or(date);
                lines.push(format!("DTSTART;VALUE=DATE:{}", compact(date)));
                lines.push(format!("DTEND;VALUE=DATE:{}", compact(last + Duration::days(1))));
            }
        }
        let title = if t.status == "done" { format!("✓ {}", t.title) } else { t.title.clone() };
        lines.push(format!("SUMMARY:{}", ics_escape(&title)));
        let mut desc = Vec::new();
        if !t.notes.trim().is_empty() {
            desc.push(t.notes.trim().to_string());
        }
        if t.requires_prep {
            let notes = t.prep_notes.trim();
            desc.push(if notes.is_empty() { "Needs preparation".into() } else { format!("Preparation: {notes}") });
        }
        if let Some(dl) = &t.deadline {
            desc.push(format!("Deadline: {dl}"));
        }
        if !desc.is_empty() {
            lines.push(format!("DESCRIPTION:{}", ics_escape(&desc.join("\n"))));
        }
        if let Some(name) = t.category_id.and_then(|id| categories.get(&id)) {
            lines.push(format!("CATEGORIES:{}", ics_escape(name)));
        }
        lines.push(format!("PRIORITY:{}", match t.priority.as_str() { "high" => 1, "low" => 9, _ => 5 }));
        lines.push("END:VEVENT".into());
    }
    lines.push("END:VCALENDAR".into());
    Ok(lines.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n")
}

pub fn export_ics(conn: &Connection, path: &Path) -> Result<usize> {
    let ics = to_ics(conn)?;
    fs::write(path, &ics).map_err(|e| io("save the calendar file", e))?;
    Ok(ics.matches("BEGIN:VEVENT").count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tasks::{create, TaskInput};
    use crate::db::{habits, notes, open_in_memory, settings};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("daily-planner-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(db: &Connection) {
        let first = create(
            db,
            TaskInput {
                title: "Gym, legs; then stretch".into(),
                date: Some("2026-11-03".into()),
                start_time: Some("18:00".into()),
                duration_min: Some(60),
                recurrence_rule: Some("weekly".into()),
                category_id: Some(3),
                ..Default::default()
            },
        )
        .unwrap();
        create(db, TaskInput { title: "Bring towel".into(), parent_task_id: Some(first.id), ..Default::default() }).unwrap();
        create(
            db,
            TaskInput {
                title: "Kitchen renovation".into(),
                date: Some("2026-11-05".into()),
                end_date: Some("2026-11-10".into()),
                requires_prep: true,
                prep_notes: "Order tiles".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let h = habits::create(db, "Read").unwrap();
        habits::toggle(db, h, "2026-11-03").unwrap();
        notes::set(db, "2026-11-03", "A note").unwrap();
        settings::set(db, "theme", "dark").unwrap();
    }

    fn counts(db: &Connection) -> Vec<i64> {
        TABLES.iter().map(|t| db.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap()).collect()
    }

    #[test]
    fn json_backup_round_trip_replaces_everything() {
        let dir = temp_dir("json");
        let a = open_in_memory().unwrap();
        sample(&a);
        let file = dir.join("backup.json");
        export_json(&a, &file).unwrap();

        let b = open_in_memory().unwrap();
        create(&b, TaskInput { title: "Will be replaced".into(), ..Default::default() }).unwrap();
        let restored = restore_file(&b, &file, &dir.join("backups")).unwrap();
        assert_eq!(counts(&a), counts(&b));
        assert_eq!(restored.habits, 1);
        assert_eq!(restored.notes, 1);
        assert!(tasks::search(&b, "Will be replaced").unwrap().is_empty());
        let gym = tasks::search(&b, "Gym").unwrap();
        assert!(gym.iter().all(|t| t.series_id.is_some()));
        assert_eq!(settings::get(&b, "theme").unwrap().as_deref(), Some("dark"));
        // a safety copy of what was there before
        assert!(fs::read_dir(dir.join("backups")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("before-restore-")));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn restore_from_an_automatic_db_backup() {
        let dir = temp_dir("db");
        let a = open_in_memory().unwrap();
        sample(&a);
        daily_backup(&a, &dir, "2026-11-03").unwrap();
        let b = open_in_memory().unwrap();
        restore_file(&b, &dir.join("planner-2026-11-03.db"), &dir).unwrap();
        assert_eq!(counts(&a), counts(&b));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bad_files_leave_the_data_untouched() {
        let dir = temp_dir("bad");
        let db = open_in_memory().unwrap();
        sample(&db);
        let before = counts(&db);
        let not_ours = dir.join("other.json");
        fs::write(&not_ours, r#"{"hello": "world"}"#).unwrap();
        assert!(restore_file(&db, &not_ours, &dir).is_err());
        let broken = json!({ "app": APP, "schemaVersion": 1, "tables": { "tasks": [ { "id": 1, "title": "x", "category_id": 999 } ] } });
        assert!(restore_json(&db, &broken).is_err());
        let newer = json!({ "app": APP, "schemaVersion": 999, "tables": {} });
        assert!(restore_json(&db, &newer).is_err());
        assert_eq!(counts(&db), before);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn daily_backups_happen_once_a_day_and_keep_the_newest() {
        let dir = temp_dir("daily");
        let db = open_in_memory().unwrap();
        for day in 1..=20 {
            daily_backup(&db, &dir, &format!("2026-10-{day:02}")).unwrap();
        }
        daily_backup(&db, &dir, "2026-10-20").unwrap();
        let i = info(&dir);
        assert_eq!((i.count, i.latest.as_deref()), (KEEP_DAILY, Some("2026-10-20")));
        assert!(!dir.join("planner-2026-10-06.db").exists());
        assert!(dir.join("planner-2026-10-07.db").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn calendar_export() {
        let db = open_in_memory().unwrap();
        sample(&db);
        let ics = to_ics(&db).unwrap();
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(ics.contains("SUMMARY:Gym\\, legs\\; then stretch\r\n"));
        assert!(ics.contains("DTSTART:20261103T180000\r\nDTEND:20261103T190000\r\n"));
        // a multi-day project is one all-day event; the end date is exclusive
        assert!(ics.contains("DTSTART;VALUE=DATE:20261105\r\nDTEND;VALUE=DATE:20261111\r\n"));
        assert!(ics.contains("DESCRIPTION:Preparation: Order tiles\r\n"));
        assert!(ics.contains("CATEGORIES:Health\r\n"));
        // subtasks aren't events
        assert!(!ics.contains("Bring towel"));
        assert!(ics.lines().all(|l| l.len() <= 75));
    }
}
