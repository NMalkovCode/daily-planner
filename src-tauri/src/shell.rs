//! Desktop integration: the tray icon (under the taskbar's ^ arrow), the
//! summary pop-up it opens, keeping the app in the tray when the window is
//! closed, and starting with Windows.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, Window, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::commands::Db;
use crate::db::settings;

/// Passed by the "start with Windows" entry so the app starts in the tray.
pub const HIDDEN_ARG: &str = "--hidden";

const TRAY_ID: &str = "main";
const MAIN: &str = "main";
const OVERLAY: &str = "overlay";

struct TrayState {
    autostart_item: CheckMenuItem<Wry>,
    /// When the pop-up last hid itself. Clicking the tray icon first takes
    /// focus from the pop-up (hiding it); that same click mustn't reopen it.
    overlay_hidden_at: Mutex<Option<Instant>>,
}

pub fn show_main(app: &AppHandle) {
    hide_overlay(app);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(o) = app.get_webview_window(OVERLAY) {
        let _ = o.hide();
    }
}

fn toggle_overlay(app: &AppHandle, icon: Rect) {
    let Some(o) = app.get_webview_window(OVERLAY) else { return };
    if o.is_visible().unwrap_or(false) {
        let _ = o.hide();
        return;
    }
    if let Some(state) = app.try_state::<TrayState>() {
        let hidden_at = *state.overlay_hidden_at.lock().unwrap_or_else(|e| e.into_inner());
        if hidden_at.is_some_and(|t| t.elapsed() < Duration::from_millis(350)) {
            return;
        }
    }
    position_overlay(&o, icon);
    let _ = o.show();
    let _ = o.set_focus();
    let _ = app.emit_to(OVERLAY, "overlay-shown", ());
}

/// Places the pop-up just above the tray icon (or below it if the taskbar is
/// at the top of the screen), kept inside the screen's work area.
fn position_overlay(o: &tauri::WebviewWindow, icon: Rect) {
    let scale = o.scale_factor().unwrap_or(1.0);
    let pos = icon.position.to_physical::<f64>(scale);
    let size = icon.size.to_physical::<f64>(scale);
    let Ok(win) = o.outer_size() else { return };
    let (w, h) = (win.width as f64, win.height as f64);
    let Some(monitor) = o.monitor_from_point(pos.x, pos.y).ok().flatten() else { return };
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);
    let margin = 12.0 * monitor.scale_factor();

    let x = (pos.x + size.width / 2.0 - w / 2.0).clamp(ax + margin, (ax + aw - w - margin).max(ax + margin));
    let y = if pos.y > ay + ah / 2.0 { ay + ah - h - margin } else { ay + margin };
    let _ = o.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let open = MenuItem::with_id(app, "open", "Open Daily Planner", true, None::<&str>)?;
    let new_task = MenuItem::with_id(app, "new", "New task…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Daily Planner", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &new_task,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Daily Planner")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "new" => {
                show_main(app);
                let _ = app.emit_to(MAIN, "new-task", ());
            }
            "autostart" => {
                // the menu item has already flipped its tick
                if let Some(state) = app.try_state::<TrayState>() {
                    let wanted = state.autostart_item.is_checked().unwrap_or(false);
                    let _ = set_autostart(app, wanted);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_overlay(tray.app_handle(), rect);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    app.manage(TrayState {
        autostart_item: autostart,
        overlay_hidden_at: Mutex::new(None),
    });
    Ok(())
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    let actual = launcher.is_enabled().unwrap_or(false);
    if let Some(state) = app.try_state::<TrayState>() {
        let _ = state.autostart_item.set_checked(actual);
    }
    result.map_err(|e| e.to_string())
}

/// Turns "start with Windows" on the first time the installed app runs, and
/// keeps the entry pointing at the current exe after that.
/// Skipped for development builds and test runs so they don't register
/// themselves at login.
pub fn enable_autostart_on_first_run(app: &AppHandle) {
    if cfg!(debug_assertions) || std::env::var_os("DAILY_PLANNER_DB").is_some() {
        return;
    }
    let db = app.state::<Db>();
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    let launcher = app.autolaunch();
    if settings::get(&conn, "autostartInitialized").ok().flatten().is_none() {
        let _ = launcher.enable();
        let _ = settings::set(&conn, "autostartInitialized", "true");
    } else if launcher.is_enabled().unwrap_or(false) {
        // re-register so the entry points at this exe (e.g. after installing
        // or moving the app)
        let _ = launcher.enable();
    }
}

fn close_to_tray(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.conn.lock().unwrap_or_else(|e| e.into_inner());
    settings::get(&conn, "closeToTray").ok().flatten().as_deref() != Some("false")
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (MAIN, WindowEvent::CloseRequested { api, .. }) => {
            if close_to_tray(app) {
                api.prevent_close();
                let _ = window.hide();
            } else {
                // the hidden pop-up window would otherwise keep the app alive
                app.exit(0);
            }
        }
        (OVERLAY, WindowEvent::Focused(false)) => {
            let _ = window.hide();
            if let Some(state) = app.try_state::<TrayState>() {
                *state.overlay_hidden_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            }
        }
        _ => {}
    }
}

// ---- commands ----

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_autostart(&app, enabled)
}

/// Opens the main window from the pop-up, optionally straight into a task
/// (`task_id`) or a new task (`new_task`).
#[tauri::command]
pub fn open_main(app: AppHandle, task_id: Option<i64>, new_task: Option<bool>) {
    show_main(&app);
    if let Some(id) = task_id {
        let _ = app.emit_to(MAIN, "open-task", id);
    } else if new_task == Some(true) {
        let _ = app.emit_to(MAIN, "new-task", ());
    }
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) {
    hide_overlay(&app);
}

#[tauri::command]
pub fn tray_set_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}
