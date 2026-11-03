//! Tauri commands: the API the front end calls with `invoke`.
//! Argument names arrive from JavaScript in camelCase (e.g. `endDate`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::db::categories::{self, Category, CategoryInput};
use crate::db::tasks::{self, DaySummary, Task, TaskInput};
use crate::db::{self, backup, habits, notes, recurrence, settings, Result};

pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: PathBuf,
}

impl Db {
    /// The `backups` folder next to the database file.
    pub fn backups_dir(&self) -> PathBuf {
        self.path.parent().map(|p| p.join("backups")).unwrap_or_else(|| PathBuf::from("backups"))
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        // A panic while holding the lock can't leave SQLite half-written, so keep going.
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    path: String,
    today: String,
    task_count: i64,
}

#[tauri::command]
pub fn db_info(db: State<Db>) -> Result<DbInfo> {
    db.with(|c| {
        Ok(DbInfo {
            path: db.path.display().to_string(),
            today: db::today(c)?,
            task_count: c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?,
        })
    })
}

// ---- tasks ----

#[tauri::command]
pub fn task_get(db: State<Db>, id: i64) -> Result<Task> {
    db.with(|c| tasks::get(c, id))
}

#[tauri::command]
pub fn task_create(db: State<Db>, input: TaskInput) -> Result<Task> {
    db.with(|c| tasks::create(c, input))
}

/// `later_too`: for a repeating task, also change the repeats after this one.
#[tauri::command]
pub fn task_update(db: State<Db>, id: i64, input: TaskInput, later_too: Option<bool>) -> Result<Task> {
    db.with(|c| tasks::save(c, id, input, later_too.unwrap_or(false)))
}

/// `later_too`: for a repeating task, also delete the repeats after this one.
#[tauri::command]
pub fn task_delete(db: State<Db>, id: i64, later_too: Option<bool>) -> Result<()> {
    db.with(|c| {
        if later_too == Some(true) {
            recurrence::delete_from(c, id)
        } else {
            tasks::delete(c, id)
        }
    })
}

#[tauri::command]
pub fn task_set_done(db: State<Db>, id: i64, done: bool) -> Result<Task> {
    db.with(|c| tasks::set_done(c, id, done))
}

#[tauri::command]
pub fn task_set_prep_done(db: State<Db>, id: i64, done: bool) -> Result<Task> {
    db.with(|c| tasks::set_prep_done(c, id, done))
}

#[tauri::command]
pub fn task_set_dates(db: State<Db>, id: i64, date: Option<String>, end_date: Option<String>) -> Result<Task> {
    db.with(|c| tasks::set_dates(c, id, date, end_date))
}

#[tauri::command]
pub fn tasks_between(db: State<Db>, from: String, to: String) -> Result<Vec<Task>> {
    db.with(|c| tasks::between(c, &from, &to))
}

#[tauri::command]
pub fn deadlines_between(db: State<Db>, from: String, to: String) -> Result<Vec<Task>> {
    db.with(|c| tasks::deadlines_between(c, &from, &to))
}

#[tauri::command]
pub fn tasks_for_day(db: State<Db>, day: String) -> Result<Vec<Task>> {
    db.with(|c| tasks::for_day(c, &day))
}

#[tauri::command]
pub fn task_subtasks(db: State<Db>, parent_id: i64) -> Result<Vec<Task>> {
    db.with(|c| tasks::subtasks(c, parent_id))
}

#[tauri::command]
pub fn tasks_unscheduled(db: State<Db>) -> Result<Vec<Task>> {
    db.with(tasks::unscheduled)
}

#[tauri::command]
pub fn tasks_search(db: State<Db>, text: String) -> Result<Vec<Task>> {
    db.with(|c| tasks::search(c, &text))
}

// ---- habits ----

#[tauri::command]
pub fn habits_list(db: State<Db>, today: String) -> Result<Vec<habits::Habit>> {
    db.with(|c| habits::list(c, &today))
}

#[tauri::command]
pub fn habit_create(db: State<Db>, name: String) -> Result<i64> {
    db.with(|c| habits::create(c, &name))
}

#[tauri::command]
pub fn habit_archive(db: State<Db>, id: i64) -> Result<()> {
    db.with(|c| habits::archive(c, id))
}

#[tauri::command]
pub fn habit_toggle(db: State<Db>, id: i64, date: String) -> Result<bool> {
    db.with(|c| habits::toggle(c, id, &date))
}

#[tauri::command]
pub fn tasks_unfinished(db: State<Db>, today: String) -> Result<Vec<Task>> {
    db.with(|c| tasks::unfinished_before(c, &today))
}

#[tauri::command]
pub fn tasks_move_to(db: State<Db>, ids: Vec<i64>, date: String) -> Result<()> {
    db.with(|c| tasks::move_to(c, &ids, &date))
}

/// Today view / tray overlay data. `today` defaults to the computer's local date.
#[tauri::command]
pub fn day_summary(db: State<Db>, today: Option<String>) -> Result<DaySummary> {
    db.with(|c| {
        let today = match today {
            Some(d) => d,
            None => db::today(c)?,
        };
        tasks::day_summary(c, &today)
    })
}

// ---- categories ----

#[tauri::command]
pub fn categories_list(db: State<Db>) -> Result<Vec<Category>> {
    db.with(categories::list)
}

#[tauri::command]
pub fn category_create(db: State<Db>, input: CategoryInput) -> Result<Category> {
    db.with(|c| categories::create(c, input))
}

#[tauri::command]
pub fn category_update(db: State<Db>, id: i64, input: CategoryInput) -> Result<Category> {
    db.with(|c| categories::update(c, id, input))
}

#[tauri::command]
pub fn category_delete(db: State<Db>, id: i64) -> Result<()> {
    db.with(|c| categories::delete(c, id))
}

// ---- daily notes ----

#[tauri::command]
pub fn note_get(db: State<Db>, date: String) -> Result<String> {
    db.with(|c| notes::get(c, &date))
}

#[tauri::command]
pub fn note_set(db: State<Db>, date: String, content: String) -> Result<()> {
    db.with(|c| notes::set(c, &date, &content))
}

// ---- backup and export ----

#[tauri::command]
pub fn backup_export(db: State<Db>, path: String) -> Result<()> {
    db.with(|c| backup::export_json(c, Path::new(&path)))
}

/// Replaces all data with the backup's (after saving a copy of the current data).
#[tauri::command]
pub fn backup_restore(db: State<Db>, path: String) -> Result<backup::Restored> {
    let dir = db.backups_dir();
    db.with(|c| {
        let restored = backup::restore_file(c, Path::new(&path), &dir)?;
        recurrence::extend_all(c, &db::today(c)?)?;
        Ok(restored)
    })
}

#[tauri::command]
pub fn calendar_export(db: State<Db>, path: String) -> Result<usize> {
    db.with(|c| backup::export_ics(c, Path::new(&path)))
}

#[tauri::command]
pub fn backups_info(db: State<Db>) -> backup::BackupsInfo {
    backup::info(&db.backups_dir())
}

#[tauri::command]
pub fn backups_open_folder(app: tauri::AppHandle, db: State<Db>) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = db.backups_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// ---- settings ----

#[tauri::command]
pub fn settings_all(db: State<Db>) -> Result<HashMap<String, String>> {
    db.with(settings::all)
}

#[tauri::command]
pub fn setting_get(db: State<Db>, key: String) -> Result<Option<String>> {
    db.with(|c| settings::get(c, &key))
}

#[tauri::command]
pub fn setting_set(db: State<Db>, key: String, value: String) -> Result<()> {
    db.with(|c| settings::set(c, &key, &value))
}
