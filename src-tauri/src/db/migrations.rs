//! Schema migrations, tracked with SQLite's `user_version` pragma.
//! Append new migrations to the end of `MIGRATIONS`; never edit a released one.

use rusqlite::Connection;

use super::Result;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    r#"
    CREATE TABLE categories (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        colour      TEXT NOT NULL DEFAULT '#6366f1',
        sort_order  INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO categories (name, colour, sort_order) VALUES
        ('Work',     '#3b82f6', 1),
        ('Personal', '#22c55e', 2),
        ('Health',   '#ef4444', 3),
        ('Study',    '#a855f7', 4);

    CREATE TABLE tasks (
        id                INTEGER PRIMARY KEY,
        title             TEXT NOT NULL,
        notes             TEXT NOT NULL DEFAULT '',
        -- YYYY-MM-DD; NULL means unscheduled
        date              TEXT,
        -- set for multi-day projects, drawn as one bar from date to end_date
        end_date          TEXT,
        -- HH:MM
        start_time        TEXT,
        duration_min      INTEGER,
        -- YYYY-MM-DD or YYYY-MM-DD HH:MM
        deadline          TEXT,
        priority          TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low', 'medium', 'high')),
        category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        status            TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'done')),
        completed_at      TEXT,
        requires_prep     INTEGER NOT NULL DEFAULT 0,
        prep_notes        TEXT NOT NULL DEFAULT '',
        prep_days_before  INTEGER NOT NULL DEFAULT 1,
        prep_done         INTEGER NOT NULL DEFAULT 0,
        recurrence_rule   TEXT,
        parent_task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        CHECK (end_date IS NULL OR (date IS NOT NULL AND end_date > date))
    );

    CREATE INDEX idx_tasks_date     ON tasks(date);
    CREATE INDEX idx_tasks_deadline ON tasks(deadline);
    CREATE INDEX idx_tasks_parent   ON tasks(parent_task_id);

    CREATE TABLE reminders (
        id         INTEGER PRIMARY KEY,
        task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        -- YYYY-MM-DD HH:MM, local time
        remind_at  TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('start', 'deadline', 'prep')),
        sent       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_reminders_due ON reminders(sent, remind_at);

    CREATE TABLE daily_notes (
        date     TEXT PRIMARY KEY,
        content  TEXT NOT NULL
    );

    CREATE TABLE habits (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        colour  TEXT NOT NULL DEFAULT '#f59e0b',
        active  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE habit_checks (
        habit_id  INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        date      TEXT NOT NULL,
        PRIMARY KEY (habit_id, date)
    );

    CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    "#,
    // 2: reminders are worked out from the tasks; just remember which were sent
    r#"
    DROP TABLE reminders;

    CREATE TABLE notifications_sent (
        -- e.g. "start:12:2026-11-03 09:20"
        key      TEXT PRIMARY KEY,
        sent_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    "#,
    // 3: recurring tasks. Each repeat is a real task row (so it can be ticked,
    // moved or edited on its own), generated a few weeks ahead from its series.
    r#"
    CREATE TABLE series (
        id               INTEGER PRIMARY KEY,
        -- see recurrence::Rule, e.g. "weekly:1,3;until=2027-06-30"
        rule             TEXT NOT NULL,
        anchor_date      TEXT NOT NULL,
        -- repeats are created for dates after this one only
        generated_until  TEXT NOT NULL
    );

    ALTER TABLE tasks ADD COLUMN series_id INTEGER REFERENCES series(id) ON DELETE SET NULL;
    CREATE INDEX idx_tasks_series ON tasks(series_id);
    "#,
];

pub fn run(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        run(&mut conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
    }
}
