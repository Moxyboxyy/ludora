//! Streamen (Steam Remote Play): welche Spiele sind auf einem anderen deiner Geräte installiert?

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::AppHandle;

use crate::util::t;

static STREAMS: Lazy<Mutex<Map<String, Value>>> = Lazy::new(|| Mutex::new(Map::new()));
static GEN: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(0));

pub fn get() -> Value {
    Value::Object(STREAMS.lock().clone())
}

/// Neu einlesen und danach alle 3 Minuten wiederholen
pub fn refresh(app: AppHandle) {
    let my = {
        let mut g = GEN.lock();
        *g += 1;
        *g
    };
    tauri::async_runtime::spawn(async move {
        loop {
            let mut next = Map::new();
            match crate::steam::remote_installed().await {
                Ok(devices) => {
                    for (machine, apps) in devices {
                        for id in apps {
                            let e = next.entry(format!("steam:{id}")).or_insert(json!([]));
                            e.as_array_mut().unwrap().push(json!(machine));
                        }
                    }
                }
                Err(e) => {
                    crate::log::warn(&format!("[stream] steam {e}"));
                    for (k, v) in STREAMS.lock().iter() {
                        if k.starts_with("steam:") {
                            next.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            let changed = *STREAMS.lock() != next;
            if changed {
                *STREAMS.lock() = next.clone();
                crate::broadcast(&app, "library:streams", Value::Object(next));
            }
            tokio::time::sleep(Duration::from_secs(180)).await;
            if *GEN.lock() != my {
                return;
            }
        }
    });
}

pub async fn stream_game(id: &str) -> Value {
    let Ok(g) = crate::library::find_game(id) else { return json!({ "ok": false, "error": t("Spiel nicht gefunden – bitte Bibliothek neu laden.") }) };
    let native = g["nativeId"].as_str().unwrap_or("");
    if g["provider"] != "steam" || native.is_empty() || !native.chars().all(|c| c.is_ascii_digit()) {
        return json!({ "ok": false, "error": t("Dieses Spiel lässt sich nicht streamen.") });
    }
    match crate::running::run_launch(Some(&crate::util::uri(format!("steam://rungameid/{native}"))), false).await {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}
