//! One free-text note per day.

use rusqlite::{params, Connection, OptionalExtension};

use super::validate::is_date;
use super::{Error, Result};

pub fn get(conn: &Connection, date: &str) -> Result<String> {
    Ok(conn
        .query_row("SELECT content FROM daily_notes WHERE date = ?1", [date], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

/// Saves the note for a day; saving an empty note removes it.
pub fn set(conn: &Connection, date: &str, content: &str) -> Result<()> {
    if !is_date(date) {
        return Err(Error::Invalid("Date must be YYYY-MM-DD".into()));
    }
    if content.trim().is_empty() {
        conn.execute("DELETE FROM daily_notes WHERE date = ?1", [date])?;
    } else {
        conn.execute(
            "INSERT INTO daily_notes (date, content) VALUES (?1, ?2)
             ON CONFLICT(date) DO UPDATE SET content = excluded.content",
            params![date, content],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn set_overwrite_and_clear() {
        let db = open_in_memory().unwrap();
        assert_eq!(get(&db, "2026-11-03").unwrap(), "");
        set(&db, "2026-11-03", "first").unwrap();
        set(&db, "2026-11-03", "second").unwrap();
        assert_eq!(get(&db, "2026-11-03").unwrap(), "second");
        set(&db, "2026-11-03", "  ").unwrap();
        let rows: i64 = db.query_row("SELECT COUNT(*) FROM daily_notes", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }
}
