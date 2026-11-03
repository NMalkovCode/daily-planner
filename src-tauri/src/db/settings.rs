//! Simple key/value app settings (theme, week start, autostart, ...).

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::Result;

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn all(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn set_get_all() {
        let db = open_in_memory().unwrap();
        assert_eq!(get(&db, "theme").unwrap(), None);
        set(&db, "theme", "dark").unwrap();
        set(&db, "theme", "light").unwrap();
        set(&db, "weekStart", "monday").unwrap();
        assert_eq!(get(&db, "theme").unwrap().as_deref(), Some("light"));
        assert_eq!(all(&db).unwrap().len(), 2);
    }
}
