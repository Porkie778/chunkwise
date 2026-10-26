//! The Chunkwise desktop app: the planner itself is the same page as the web version (../web/index.html); this side gives it the file
//! system (plans, packs, exports), windows, the .chunkwise file type and updates.
mod files;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// which plan each window has open, so a plan is only ever open in one window
#[derive(Default)]
struct OpenPlans(Mutex<HashMap<String, String>>);
static NEXT: AtomicUsize = AtomicUsize::new(1);

#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    files::read_text(&path)
}
#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    files::write_text(&path, &text)
}
#[tauri::command]
fn write_bytes(path: String, b64: String, replace: bool) -> Result<String, String> {
    files::write_bytes(&path, &b64, replace)
}
#[tauri::command]
fn remove(path: String, to_trash: bool) -> Result<(), String> {
    files::remove(&path, to_trash)
}
#[tauri::command]
fn rename(from: String, to: String) -> Result<(), String> {
    files::rename(&from, &to)
}
#[tauri::command]
fn exists(path: String) -> bool {
    files::exists(&path)
}
#[tauri::command]
fn list_dir(dir: String, ext: String) -> Result<Vec<files::Entry>, String> {
    files::list_dir(&dir, &ext)
}
#[tauri::command]
fn list_plans(dir: String) -> Result<Vec<files::PlanInfo>, String> {
    files::list_plans(&dir)
}

/// the folders the app starts from: Documents for plans and packs, the app's own data folder for snapshots and the like
#[tauri::command]
fn dirs(app: AppHandle) -> HashMap<&'static str, String> {
    let p = app.path();
    let s = |r: tauri::Result<PathBuf>| r.map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    HashMap::from([
        ("documents", s(p.document_dir())),
        ("home", s(p.home_dir())),
        ("roaming", s(p.data_dir())),
        ("appData", s(p.app_data_dir())),
        ("pictures", s(p.picture_dir())),
        ("version", app.package_info().version.to_string()),
    ])
}

#[tauri::command]
fn find_instances(app: AppHandle) -> Vec<files::Instance> {
    let p = app.path();
    match (p.data_dir(), p.home_dir()) {
        (Ok(roaming), Ok(home)) => files::find_instances(&roaming, &home),
        _ => vec![],
    }
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// a new window; `start` is handed to the page as window.__DESK_START (which plan or file to open)
fn make_window(app: &AppHandle, start: serde_json::Value) -> tauri::Result<WebviewWindow> {
    let label = if app.get_webview_window("main").is_none() { "main".to_string() } else { format!("w{}", NEXT.fetch_add(1, Ordering::Relaxed)) };
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Chunkwise")
        .inner_size(1440.0, 900.0)
        .min_inner_size(820.0, 560.0)
        .initialization_script(&format!("window.__DESK_START = {};", start))
        .build()?;
    Ok(w)
}

#[tauri::command]
fn new_window(app: AppHandle, start: serde_json::Value) -> Result<String, String> {
    make_window(&app, start).map(|w| w.label().to_string()).map_err(|e| e.to_string())
}

/// claims a plan for this window; if another window has it open, that window comes to the front and its label is returned
#[tauri::command]
fn claim_plan(window: WebviewWindow, state: tauri::State<'_, OpenPlans>, pid: String) -> Option<String> {
    let mut m = state.0.lock().unwrap();
    let me = window.label().to_string();
    let other = m.iter().find(|(l, p)| **p == pid && **l != me).map(|(l, _)| l.clone());
    if let Some(other) = other {
        if let Some(w) = window.app_handle().get_webview_window(&other) {
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Some(other);
        }
        m.remove(&other);
    }
    m.insert(me, pid);
    None
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// the page has saved everything and the window can go
#[tauri::command]
fn close_now(window: WebviewWindow) {
    let _ = window.destroy();
}

fn file_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| a.to_lowercase().ends_with(".chunkwise")).cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // first, as the plugin asks: a second launch (double-clicking a plan file) opens it in a window of this one
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(f) = file_arg(&args) {
                let _ = make_window(app, serde_json::json!({ "file": f }));
            } else if let Some(w) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            } else {
                let _ = make_window(app, serde_json::json!({}));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(OpenPlans::default())
        .invoke_handler(tauri::generate_handler![
            read_text, write_text, write_bytes, remove, rename, exists, list_dir, list_plans, dirs, find_instances, reveal, new_window, claim_plan,
            set_title, close_now
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let args: Vec<String> = std::env::args().collect();
            let start = match file_arg(&args) {
                Some(f) => serde_json::json!({ "file": f }),
                None => serde_json::json!({}),
            };
            make_window(app.handle(), start)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // closing: the page saves first, then calls close_now; if it doesn't answer in a few seconds, the window goes anyway
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.emit_to(window.label(), "desk-close", ());
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    let _ = w.destroy();
                });
            }
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.app_handle().try_state::<OpenPlans>() {
                    state.0.lock().unwrap().remove(window.label());
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Chunkwise");
}
