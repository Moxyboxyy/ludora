//! Funktionstest der Testversion (nur Debug-Builds – im Release von GitHub nicht enthalten).
//! - Mit `npm run dev` öffnet sich neben Ludora das Fenster „Funktionstest“ (src/debug/DebugWindow.jsx):
//!   jede Funktion mit Ampel und Begründung. Abschalten: Umgebungsvariable LUDORA_NO_DEBUG.
//! - `npm run selftest` (scripts/selftest.mjs) setzt LUDORA_SELFTEST: alle automatischen Tests laufen von
//!   selbst, jedes Ergebnis samt Begründung erscheint im Terminal, danach beendet sich Ludora (Exit-Code 0/1).

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

fn cli() -> bool {
    std::env::var_os("LUDORA_SELFTEST").is_some()
}

fn keep() -> bool {
    std::env::var_os("LUDORA_SELFTEST_KEEP").is_some()
}

/// Beim Start: Funktionstest-Fenster öffnen
pub fn open_window(app: &AppHandle) {
    if std::env::var_os("LUDORA_NO_DEBUG").is_some() && !cli() {
        return;
    }
    if app.get_webview_window("debug").is_some() {
        return;
    }
    let r = WebviewWindowBuilder::new(app, "debug", WebviewUrl::App("index.html".into()))
        .title("Ludora · Funktionstest")
        .inner_size(980.0, 860.0)
        .min_inner_size(640.0, 400.0)
        .background_color(tauri::window::Color(15, 17, 21, 255))
        .initialization_script("if (window.location.hash !== '#debug') window.location.hash = 'debug';")
        .build();
    if let Err(e) = r {
        crate::log::warn(&format!("[selftest] Fenster: {e}"));
    }
    if cli() {
        println!("[selftest] Funktionstest startet – alle automatischen Tests laufen …");
    }
}

pub fn options() -> Value {
    json!({ "cli": cli(), "keep": keep() })
}

pub fn status() -> Value {
    json!({
        "steamChat": crate::steamcm::is_alive(),
        "dataDir": crate::paths::data_dir().to_string_lossy(),
        "logFile": crate::paths::data_dir().join("logs").join("main.log").to_string_lossy(),
    })
}

fn word(st: &str) -> &'static str {
    match st {
        "ok" => "BESTANDEN       ",
        "warn" => "TEILWEISE       ",
        "fail" => "NICHT BESTANDEN ",
        _ => "?               ",
    }
}

/// Ein Ergebnis: { name, status: ok|warn|fail, detail } – mit Begründung ins Terminal und Protokoll
pub fn report(r: &Value) -> Value {
    let st = r["status"].as_str().unwrap_or("");
    let name = r["name"].as_str().unwrap_or("");
    let detail = r["detail"].as_str().unwrap_or("");
    let line = if st == "ok" {
        format!("[selftest] {} {name}{}", word(st), if detail.is_empty() { String::new() } else { format!(" – {detail}") })
    } else {
        format!("[selftest] {} {name}\n[selftest]                  Grund: {}", word(st), if detail.is_empty() { "(keine Angabe)" } else { detail })
    };
    println!("{line}");
    crate::log::info(&line.replace('\n', " "));
    Value::Null
}

/// Bericht speichern und (ohne --keep) Ludora beenden
pub fn finish(app: &AppHandle, summary: &Value) -> Value {
    let file = crate::paths::data_dir().join("selftest-report.json");
    let _ = std::fs::write(&file, serde_json::to_string_pretty(summary).unwrap_or_default());
    let n = |k: &str| summary[k].as_u64().unwrap_or(0);
    println!(
        "[selftest] ERGEBNIS: {} bestanden, {} teilweise, {} nicht bestanden – Bericht: {}",
        n("ok"),
        n("warn"),
        n("fail"),
        file.display()
    );
    if cli() && !keep() {
        let app = app.clone();
        let code = if n("fail") > 0 { 1 } else { 0 };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            app.exit(code);
        });
    }
    Value::Null
}
