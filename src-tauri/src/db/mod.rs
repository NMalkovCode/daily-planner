//! Local SQLite storage. The Rust side owns the database so the main window,
//! the tray overlay and the reminder scheduler all read the same data.

pub mod backup;
pub mod categories;
pub mod habits;
pub mod migrations;
pub mod notes;
pub mod recurrence;
pub mod settings;
pub mod tasks;
mod validate;

use std::fmt;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    /// Input rejected by validation; the message is shown to the user.
    Invalid(String),
    NotFound,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "database error: {e}"),
            Error::Invalid(msg) => write!(f, "{msg}"),
            Error::NotFound => write!(f, "not found"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => Error::NotFound,
            other => Error::Sql(other),
        }
    }
}

// Tauri commands send errors to the front end as plain strings.
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    prepare(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    prepare(Connection::open_in_memory()?)
}

fn prepare(mut conn: Connection) -> Result<Connection> {
    conn.pragma_update(None, "foreign_keys", true)?;
    migrations::run(&mut conn)?;
    Ok(conn)
}

/// Today's date in the computer's local time zone, as `YYYY-MM-DD`.
pub fn today(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT date('now', 'localtime')", [], |r| r.get(0))?)
}
