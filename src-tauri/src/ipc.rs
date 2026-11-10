//! Verteiler: Die Oberfläche ruft dieselben Kanäle auf wie in der Electron-Version
//! ("library:scan", "settings:get", …). So bleibt der React-Teil unverändert.
//! Kanäle, die noch nicht nach Rust portiert sind, melden das klar statt still zu scheitern.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::settings;

/// Plattformname wie in Node (process.platform), damit die Oberfläche nichts ändern muss
pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

pub async fn dispatch(app: &AppHandle, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    match channel {
        // ---------- Start ----------
        "app:boot" => Ok(json!({
            "platform": platform(),
            "language": settings::get_str("language", "en"),
        })),
        "app:info" => Ok(json!({
            "version": app.package_info().version.to_string(),
            "runtime": "tauri",
            "platform": platform(),
        })),
        "app:quit" => {
            app.exit(0);
            Ok(json!(true))
        }
        "app:devtools" => {
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                if w.is_devtools_open() { w.close_devtools() } else { w.open_devtools() }
            }
            Ok(json!(true))
        }
        "app:openData" => {
            open_path(app, &crate::paths::data_dir().to_string_lossy());
            Ok(Value::Null)
        }
        "app:openExternal" => {
            // Nur feste, bekannte Seiten (wie in der Electron-Version)
            const ALLOWED: [&str; 3] = [
                "https://steamcommunity.com/dev/apikey",
                "https://steamcommunity.com/my/edit/settings",
                "https://www.steamgriddb.com/profile/preferences/api",
            ];
            let url = arg(&args, 0);
            if let Some(u) = url.as_str().filter(|u| ALLOWED.contains(u)) {
                open_url(app, u);
            }
            Ok(Value::Null)
        }

        // ---------- Favoriten ----------
        "favorites:get" => Ok(settings::get("favorites").unwrap_or_else(|| json!([]))),
        "favorites:toggle" => Ok(toggle_favorite(arg(&args, 0).as_str().unwrap_or(""))),

        // ---------- Personen-Zuordnung (Freunde über mehrere Launcher) ----------
        "people:get" => Ok(settings::get("friendPeople").unwrap_or_else(|| json!([]))),
        "people:save" => {
            let list = arg(&args, 0);
            if list.is_array() {
                let mut p = Map::new();
                p.insert("friendPeople".into(), list.clone());
                settings::set(p);
            }
            Ok(list)
        }

        _ => Err(format!("Noch nicht nach Rust portiert: {channel}")),
    }
}

/// Favorit an/aus (Schlüssel "<launcher>:<id>")
pub fn toggle_favorite(key: &str) -> Value {
    let list: Vec<String> = settings::get("favorites")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let valid = key.len() <= 220
        && key.split_once(':').map_or(false, |(a, b)| {
            !a.is_empty() && a.chars().all(|c| c.is_ascii_lowercase()) && !b.is_empty()
        });
    if !valid {
        return json!(list);
    }
    let mut next: Vec<String> = list.iter().filter(|x| x.as_str() != key).cloned().collect();
    if next.len() == list.len() {
        next.push(key.to_string()); // war noch kein Favorit
    }
    let mut p = Map::new();
    p.insert("favorites".into(), json!(next));
    settings::set(p);
    json!(next)
}

pub fn open_url(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

pub fn open_path(app: &AppHandle, path: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_path(path, None::<&str>);
}
