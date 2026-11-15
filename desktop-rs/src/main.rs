//! RealtimeSuite Server Manager — native shell.
//!
//! The window is the same control panel the Electron build shipped; the process
//! supervision, database lifecycle and IPC are Rust. Two behaviours are new:
//! the window closes to the tray instead of quitting, and the whole app can be
//! launched hidden so the server keeps running with nothing on screen.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod core;
mod pg;
mod server;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager as TauriManager, State, WindowEvent};

pub use crate::core::Manager;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The folder the Electron build used, kept so an existing installation keeps
/// its settings, backups and PostgreSQL cluster when the Rust build takes over.
fn legacy_user_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    if cfg!(target_os = "macos") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("RealtimeSuite Server Manager")
    } else if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA").unwrap_or_else(|_| home.clone());
        PathBuf::from(base).join("RealtimeSuite Server Manager")
    } else {
        let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
        PathBuf::from(base).join("RealtimeSuite Server Manager")
    }
}

fn backend_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("RTLINK_BACKEND_DIR") {
        return PathBuf::from(custom);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|parent| parent.join("backend"))
        .unwrap_or_else(|| manifest.join("backend"))
}

fn resources_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("RTLINK_RESOURCES_DIR") {
        return PathBuf::from(custom);
    }
    if cfg!(debug_assertions) {
        return PathBuf::new();
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_default()
}

// --------------------------------------------------------------------- helpers

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn state_payload(manager: &Arc<Manager>) -> Value {
    json!({
        "status": manager.status(),
        "settings": manager.settings(),
        "check": manager.check(),
        "logs": manager.get_logs(),
        "version": env!("CARGO_PKG_VERSION")
    })
}

// -------------------------------------------------------------------- commands

#[tauri::command]
async fn manager_state(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        manager.note_ui_connected();
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_save_settings(state: State<'_, Arc<Manager>>, patch: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        manager.save_settings(&patch)?;
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_save_env(state: State<'_, Arc<Manager>>, values: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let map = values.as_object().cloned().unwrap_or_default();
        manager.save_env(&map)?;
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_rtlink(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || Ok(json!({ "rtlink": manager.rtlink_config() }))).await
}

#[tauri::command]
async fn manager_rtlink_save(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let org = payload.get("orgCode").and_then(Value::as_str).unwrap_or("");
        let site = payload.get("siteName").and_then(Value::as_str).unwrap_or("");
        let key = payload.get("serviceRoleKey").and_then(Value::as_str).unwrap_or("");
        let config = manager.save_rtlink(org, site, key)?;
        Ok(json!({ "ok": true, "rtlink": config }))
    })
    .await
}

#[tauri::command]
async fn manager_setup(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        manager.setup_environment()?;
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_init_db(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        manager.init_database()?;
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_test_db(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let (ok, detail) = manager.probe_database();
        Ok(json!({ "ok": ok, "detail": detail }))
    })
    .await
}

#[tauri::command]
async fn manager_list_backups(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || Ok(json!({ "backups": manager.list_backups() }))).await
}

#[tauri::command]
async fn manager_create_backup(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || manager.create_backup()).await
}

#[tauri::command]
async fn manager_restore_backup(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let confirmed = payload.get("confirmed").and_then(Value::as_bool).unwrap_or(false);
        manager.restore_backup(name, confirmed)?;
        Ok(json!({ "ok": true }))
    })
    .await
}

#[tauri::command]
async fn manager_db_tables(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || match manager.list_tables() {
        Ok(tables) => Ok(json!({ "ok": true, "tables": tables })),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

#[tauri::command]
async fn manager_db_rows(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let table = payload.get("table").and_then(Value::as_str).unwrap_or("");
        let limit = payload.get("limit").and_then(Value::as_i64).unwrap_or(25);
        let offset = payload.get("offset").and_then(Value::as_i64).unwrap_or(0);
        match manager.read_rows(table, limit, offset) {
            Ok(table) => Ok(json!({ "ok": true, "table": table })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_db_update_row(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let table = payload.get("table").and_then(Value::as_str).unwrap_or("").to_string();
        let key = payload.get("key").and_then(Value::as_object).cloned().unwrap_or_default();
        let changes = payload.get("changes").and_then(Value::as_object).cloned().unwrap_or_default();
        match manager.update_row(&table, &key, &changes) {
            Ok(message) => Ok(json!({ "ok": true, "message": message })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_db_delete_row(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let table = payload.get("table").and_then(Value::as_str).unwrap_or("").to_string();
        let key: Map<String, Value> = payload.get("key").and_then(Value::as_object).cloned().unwrap_or_default();
        match manager.delete_row(&table, &key) {
            Ok(message) => Ok(json!({ "ok": true, "message": message })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_db_reset(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let confirmed = payload.get("confirmed").and_then(Value::as_bool).unwrap_or(false);
        match manager.reset_database(confirmed) {
            Ok(result) => Ok(json!({ "ok": true, "database": result["database"], "backupNote": result["backupNote"], "message": result["message"] })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_create_admin(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let email = payload.get("email").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let password = payload.get("password").and_then(Value::as_str).unwrap_or("").to_string();
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let detail = manager.create_admin(&email, &password, &name)?;
        Ok(json!({ "detail": detail }))
    })
    .await
}

#[tauri::command]
async fn manager_reset_password(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let email = payload.get("email").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let password = payload.get("password").and_then(Value::as_str).unwrap_or("").to_string();
        let (detail, rtlink) = manager.reset_password(&email, &password)?;
        Ok(json!({ "detail": detail, "rtlink": rtlink }))
    })
    .await
}

#[tauri::command]
async fn manager_set_org_name(state: State<'_, Arc<Manager>>, name: String) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || match manager.set_organization_name(&name) {
        Ok(name) => Ok(json!({ "ok": true, "name": name })),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

#[tauri::command]
async fn manager_list_users(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || match manager.list_users() {
        Ok(users) => Ok(json!({ "ok": true, "users": users })),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

#[tauri::command]
async fn manager_create_user(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let email = payload.get("email").and_then(Value::as_str).unwrap_or("");
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let password = payload.get("password").and_then(Value::as_str).unwrap_or("");
        match manager.create_user(email, name, password) {
            Ok((users, rtlink)) => Ok(json!({ "ok": true, "users": users, "rtlink": rtlink })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_delete_user(state: State<'_, Arc<Manager>>, payload: Value) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let email = payload.get("email").and_then(Value::as_str).unwrap_or("");
        match manager.delete_user(email) {
            Ok(users) => Ok(json!({ "ok": true, "users": users })),
            Err(error) => Ok(json!({ "ok": false, "error": error })),
        }
    })
    .await
}

#[tauri::command]
async fn manager_features(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        let schema = manager.feature_schema()?;
        let flags = manager.get_features()?;
        Ok(json!({ "ok": true, "schema": schema, "flags": flags }))
    })
    .await
}

#[tauri::command]
async fn manager_set_features(_state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    Ok(json!({
        "ok": false,
        "error": "Feature flags are managed in RealtimeCorp. Change them under Policies → Site configuration; this server applies the change within seconds."
    }))
}

#[tauri::command]
async fn manager_start(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || match manager.start() {
        Ok(status) => Ok(json!({ "ok": true, "status": status })),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

#[tauri::command]
async fn manager_stop(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || {
        manager.stop()?;
        Ok(state_payload(&manager))
    })
    .await
}

#[tauri::command]
async fn manager_restart(state: State<'_, Arc<Manager>>) -> Result<Value, String> {
    let manager = Arc::clone(&state);
    blocking(move || match manager.restart() {
        Ok(status) => Ok(json!({ "ok": true, "status": status })),
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

#[tauri::command]
fn manager_clear_logs(state: State<'_, Arc<Manager>>) -> bool {
    state.clear_logs();
    true
}

#[tauri::command]
fn manager_open(state: State<'_, Arc<Manager>>, target: String) -> Result<(), String> {
    let logs = state.user_dir.join("logs");
    let status = state.status();
    let url = status["url"].as_str().unwrap_or_default().to_string();
    let board = status["boardUrl"].as_str().unwrap_or_default().to_string();
    let path = match target.as_str() {
        "logs" => {
            let _ = std::fs::create_dir_all(&logs);
            logs
        }
        "backend" => state.backend_dir.clone(),
        "board" => return open_external(&board),
        "app" => return open_external(&url),
        other if other.starts_with("http://") || other.starts_with("https://") => return open_external(other),
        _ => return open_external(&url),
    };
    open_path(&path)
}

#[tauri::command]
fn manager_show_item(state: State<'_, Arc<Manager>>, target: String) -> Result<(), String> {
    let file = if target == "env" {
        state.env_file.clone()
    } else {
        state.user_dir.join("logs").join("server.log")
    };
    let parent = file.parent().map(|path| path.to_path_buf()).unwrap_or_default();
    open_path(&parent)
}

fn open_external(target: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", "start", "", target]).status()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(target).status()
    } else {
        std::process::Command::new("xdg-open").arg(target).status()
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err(format!("Could not open {target}.")),
        Err(error) => Err(format!("Could not open {target}: {error}")),
    }
}

fn open_path(path: &std::path::Path) -> Result<(), String> {
    open_external(&path.to_string_lossy())
}

// ------------------------------------------------------------------------ tray

fn focus_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle, manager: Arc<Manager>) -> tauri::Result<()> {
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Open control panel", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start server", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop server", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart server", true, None::<&str>)?;
    let app_link = MenuItem::with_id(app, "app", "Open RealtimeSuite", true, None::<&str>)?;
    let board_link = MenuItem::with_id(app, "board", "Open Live Board", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (stops the server)", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
            &sep1,
            &start,
            &stop,
            &restart,
            &sep2,
            &app_link,
            &board_link,
            &sep3,
            &quit,
        ],
    )?;

    let tray_manager = Arc::clone(&manager);
    let handler_app = app.clone();
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?)
        .tooltip("RealtimeSuite Server Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => focus_window(&handler_app),
            "start" => {
                let manager = Arc::clone(&tray_manager);
                std::thread::spawn(move || {
                    if let Err(error) = manager.start() {
                        manager.log("stderr", &error);
                    }
                });
            }
            "stop" => {
                let manager = Arc::clone(&tray_manager);
                std::thread::spawn(move || {
                    let _ = manager.stop();
                });
            }
            "restart" => {
                let manager = Arc::clone(&tray_manager);
                std::thread::spawn(move || {
                    if let Err(error) = manager.restart() {
                        manager.log("stderr", &error);
                    }
                });
            }
            "app" => {
                let url = tray_manager.status()["url"].as_str().unwrap_or_default().to_string();
                let _ = open_external(&url);
            }
            "board" => {
                let url = tray_manager.status()["boardUrl"].as_str().unwrap_or_default().to_string();
                let _ = open_external(&url);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_window(&tray.app_handle().clone());
            }
        })
        .build(app)?;
    Ok(())
}

// ------------------------------------------------------------------------ main

fn run_selftest(start: bool, env_file: Option<PathBuf>) -> i32 {
    let manager = Manager::new(backend_dir(), legacy_user_dir(), resources_dir(), env_file);
    manager.sync_rtlink_env();
    if start {
        match manager.start() {
            Ok(status) => println!("START {}", serde_json::to_string(&status).unwrap_or_default()),
            Err(error) => {
                println!("START_ERROR {error}");
                return 1;
            }
        }
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if manager.status()["state"] == "running" {
                break;
            }
        }
        let status = manager.status();
        let port = status["port"].as_u64().unwrap_or(0) as u16;
        println!("HEALTH {}", crate::core::health_ok(port));
        println!("STATUS {}", serde_json::to_string(&status).unwrap_or_default());
        let _ = manager.stop();
        println!("STOPPED {}", serde_json::to_string(&manager.status()).unwrap_or_default());
        return 0;
    }
    let payload = json!({
        "status": manager.status(),
        "settings": manager.settings(),
        "check": manager.check(),
        "backups": manager.list_backups().len()
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--selftest") {
        // `--start` also exercises the supervisor: start, wait for health, stop.
        let env_file = args
            .iter()
            .position(|arg| arg == "--env-file")
            .and_then(|index| args.get(index + 1))
            .map(PathBuf::from);
        std::process::exit(run_selftest(args.iter().any(|arg| arg == "--start"), env_file));
    }
    let hidden = args.iter().any(|arg| arg == "--background" || arg == "--hidden");

    tauri::Builder::default()
        .setup(move |app| {
            let manager = Manager::new(backend_dir(), legacy_user_dir(), resources_dir(), None);
            manager.attach(app.handle().clone());
            manager.sync_rtlink_env();
            app.manage(Arc::clone(&manager));
            build_tray(app.handle(), Arc::clone(&manager))?;

            if let Some(window) = app.get_webview_window("main") {
                if !hidden {
                    let _ = window.show();
                }
            }

            let auto_start = manager.settings().auto_start;
            if auto_start {
                let manager = Arc::clone(&manager);
                std::thread::spawn(move || {
                    if let Err(error) = manager.start() {
                        manager.log("stderr", &error);
                    }
                });
            }
            manager.log(
                "system",
                if hidden {
                    "Started in the background; use the tray icon to open the control panel."
                } else {
                    "Server Manager ready. Closing the window keeps the server running in the tray."
                },
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window hides it: the point of the tray is that a
                // running server never depends on a window being open.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            manager_state,
            manager_save_settings,
            manager_save_env,
            manager_rtlink,
            manager_rtlink_save,
            manager_setup,
            manager_init_db,
            manager_test_db,
            manager_list_backups,
            manager_create_backup,
            manager_restore_backup,
            manager_db_tables,
            manager_db_rows,
            manager_db_update_row,
            manager_db_delete_row,
            manager_db_reset,
            manager_create_admin,
            manager_reset_password,
            manager_set_org_name,
            manager_list_users,
            manager_create_user,
            manager_delete_user,
            manager_features,
            manager_set_features,
            manager_start,
            manager_stop,
            manager_restart,
            manager_clear_logs,
            manager_open,
            manager_show_item
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Server Manager")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Never leave uvicorn or PostgreSQL behind when the app quits.
                let manager = app.state::<Arc<Manager>>().inner().clone();
                let had_child = manager.runtime.lock().unwrap().child.is_some();
                if had_child {
                    api.prevent_exit();
                    std::thread::spawn(move || {
                        let _ = manager.stop();
                        std::process::exit(0);
                    });
                }
            }
        });
}
