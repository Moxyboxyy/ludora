//! Ludora (Rust/Tauri). Aufbau:
//!   ipc.rs      – Verteiler für die Kanäle der Oberfläche (gleiche Namen wie in Electron)
//!   settings.rs – settings.json (gleiches Format/Ordner wie Electron)
//!   paths.rs    – Datenordner
//!   log.rs      – Protokoll logs/main.log

pub mod ipc;
pub mod log;
pub mod paths;
pub mod settings;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// Einziger Befehl für die Oberfläche: Kanal + Argumente (siehe src/tauriBridge.js)
#[tauri::command]
async fn ipc(app: AppHandle, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let res = ipc::dispatch(&app, &channel, args).await;
    if let Err(e) = &res {
        log::warn(&format!("[ipc] {channel}: {e}"));
    }
    res
}

/// Ereignis an alle Fenster (entspricht broadcast() in der Electron-Version)
pub fn broadcast(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    log::info(&format!("[app] Ludora {} startet (Tauri)", env!("CARGO_PKG_VERSION")));
    tauri::Builder::default()
        // Zweiter Start: nur das offene Fenster nach vorne holen
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("Ludora konnte nicht starten");
}
