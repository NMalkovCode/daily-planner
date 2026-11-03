mod commands;
mod db;
mod reminders;
mod shell;

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // must be first: a second launch (e.g. from the Start menu while the app
        // is already in the tray) just brings the existing window forward
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![shell::HIDDEN_ARG])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // %APPDATA%\com.dailyplanner.app\planner.db, unless DAILY_PLANNER_DB
            // points somewhere else (used for testing against a throwaway database).
            let path = match std::env::var_os("DAILY_PLANNER_DB") {
                Some(p) => p.into(),
                None => {
                    let dir = app.path().app_data_dir()?;
                    std::fs::create_dir_all(&dir)?;
                    dir.join("planner.db")
                }
            };
            let conn = db::open(&path)?;
            db::recurrence::extend_all(&conn, &db::today(&conn)?)?;
            let state = commands::Db {
                conn: Mutex::new(conn),
                path,
            };
            // today's automatic backup (a failure here shouldn't stop the app)
            state.with(|c| db::backup::daily_backup(c, &state.backups_dir(), &db::today(c)?)).ok();
            app.manage(state);

            // Windows are created only now (they're marked "create": false), so
            // the front end never calls a command before the database is ready.
            for config in app.config().app.windows.clone() {
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
            }

            shell::enable_autostart_on_first_run(app.handle());
            shell::build_tray(app.handle())?;
            reminders::start(app.handle().clone());

            // The main window starts hidden; show it unless we were started at login.
            if !std::env::args().any(|a| a == shell::HIDDEN_ARG) {
                shell::show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::db_info,
            commands::task_get,
            commands::task_create,
            commands::task_update,
            commands::task_delete,
            commands::task_set_done,
            commands::task_set_prep_done,
            commands::task_set_dates,
            commands::tasks_between,
            commands::deadlines_between,
            commands::tasks_for_day,
            commands::task_subtasks,
            commands::tasks_unscheduled,
            commands::tasks_unfinished,
            commands::tasks_search,
            commands::habits_list,
            commands::habit_create,
            commands::habit_archive,
            commands::habit_toggle,
            commands::tasks_move_to,
            commands::day_summary,
            commands::categories_list,
            commands::category_create,
            commands::category_update,
            commands::category_delete,
            commands::note_get,
            commands::note_set,
            commands::settings_all,
            commands::setting_get,
            commands::setting_set,
            commands::backup_export,
            commands::backup_restore,
            commands::calendar_export,
            commands::backups_info,
            commands::backups_open_folder,
            shell::autostart_get,
            shell::autostart_set,
            shell::open_main,
            shell::overlay_hide,
            shell::tray_set_tooltip,
            reminders::notify_test,
            reminders::notify_show,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
