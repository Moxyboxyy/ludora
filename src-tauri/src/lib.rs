//! Ludora (Rust/Tauri). Aufbau:
//!   ipc.rs      – Verteiler für die Kanäle der Oberfläche (gleiche Namen wie in Electron)
//!   settings.rs – settings.json (gleiches Format/Ordner wie Electron)
//!   paths.rs    – Datenordner
//!   log.rs      – Protokoll logs/main.log
//!   library.rs  – Bibliothek, Starten, Updates, Downloads
//!   steam.rs / friends/ – Freunde & Chat, hub.rs – Ludora-Konto, shop.rs, updater.rs

pub mod accounts;
pub mod chat;
pub mod covers;
pub mod dialogs;
pub mod friends;
pub mod hide;
pub mod hub;
pub mod icons;
pub mod io;
pub mod ipc;
pub mod library;
pub mod log;
pub mod net;
pub mod paths;
pub mod protobuf;
pub mod providers;
pub mod reg;
pub mod running;
pub mod secrets;
pub mod settings;
pub mod shop;
#[cfg(debug_assertions)]
pub mod selftest;
pub mod sqlite;
pub mod steam;
pub mod steamcm;
pub mod streams;
pub mod tray;
pub mod uninstall;
pub mod updater;
pub mod util;
pub mod vault;
pub mod vdf;
pub mod webauth;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// Text für "Downloads (…)" im Tray-Menü
pub static DOWNLOADS_LABEL: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Hauptfenster versteckt (Tray)? Dann fragen alle Hintergrund-Schleifen seltener nach (spart CPU/Netz)
static BACKGROUND: AtomicBool = AtomicBool::new(false);

pub fn is_background() -> bool {
    BACKGROUND.load(Ordering::Relaxed)
}

/// Wartezeit für Hintergrund-Schleifen: im Tray etwa viermal so lang
pub fn idle_ms(visible_ms: u64) -> u64 {
    if is_background() {
        visible_ms * 4
    } else {
        visible_ms
    }
}

/// Fenster ins Tray: WebView auf wenig Speicher stellen (Windows/WebView2), Schleifen verlangsamen
pub fn set_background(app: &AppHandle, on: bool) {
    BACKGROUND.store(on, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("main") {
        webview_memory(&w, on);
    }
}

#[cfg(windows)]
fn webview_memory(w: &tauri::WebviewWindow, low: bool) {
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        if let Ok(core) = wv.controller().CoreWebView2() {
            if let Ok(c) = core.cast::<ICoreWebView2_19>() {
                let _ = c.SetMemoryUsageTargetLevel(if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL });
            }
        }
    });
}

#[cfg(not(windows))]
fn webview_memory(_w: &tauri::WebviewWindow, _low: bool) {}

/// Einziger Befehl für die Oberfläche: Kanal + Argumente (siehe src/tauriBridge.js)
#[tauri::command]
async fn ipc(app: AppHandle, channel: String, args: Vec<Value>) -> Result<Value, String> {
    if std::env::var_os("LUDORA_TRACE_IPC").is_some() {
        log::info(&format!("[ipc] {channel}"));
    }
    let res = ipc::dispatch(&app, &channel, args).await;
    match res {
        Ok(v) => Ok(ipc::outbound(v)),
        Err(e) => {
            log::warn(&format!("[ipc] {channel}: {e}"));
            Err(e)
        }
    }
}

/// Ereignis an alle Fenster (entspricht broadcast() in der Electron-Version)
pub fn broadcast(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, ipc::outbound(payload));
}

pub fn show_main(app: &AppHandle) {
    if is_background() {
        set_background(app, false);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Bereich im Hauptfenster öffnen (vom Tray aus)
pub fn navigate(app: &AppHandle, page: &str) {
    show_main(app);
    let _ = app.emit_to("main", "app:navigate", Value::String(page.to_string()));
}

pub fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    hide::stop_all();
    // Ludora-Freunden sofort "offline" melden (höchstens 1,5 s warten)
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if hub::is_signed_in() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), hub::go_offline()).await;
        }
        app.exit(0);
    });
}

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Neue Chatnachricht (Steam, Riot, Epic) -> an alle Fenster + Benachrichtigung, wenn der Chat nicht vorne ist
pub fn on_chat_event(app: &AppHandle, ev: Value) {
    broadcast(app, "chat:event", ev.clone());
    if ev["type"] == "message" && ev["fromMe"] != true {
        let id = ev["steamid"].as_str().unwrap_or("").to_string();
        let focused = app.get_webview_window(&chat::window_label(&id)).is_some_and(|w| w.is_focused().unwrap_or(false));
        if !focused {
            let title = chat::chat_name(&id).unwrap_or_else(|| util::t("Neue Nachricht"));
            let body: String = ev["text"].as_str().unwrap_or("").chars().take(200).collect();
            notify_with(app, &title, &body, Click::OpenChat(id));
        }
    }
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    notify_with(app, title, body, Click::ShowMain);
}

/// Was ein Klick auf die Benachrichtigung tut
#[derive(Clone)]
pub enum Click {
    ShowMain,
    OpenChat(String),
    OpenUpdate,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn on_click(app: &AppHandle, c: Click) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match c {
            Click::ShowMain => show_main(&app),
            Click::OpenChat(id) => {
                chat::open(&app, &id);
            }
            Click::OpenUpdate => {
                show_main(&app);
                let _ = app.emit_to("main", "update:open", Value::Null);
            }
        }
    });
}

/// Benachrichtigung; unter Windows führt ein Klick darauf zur passenden Stelle (Chat, Update)
pub fn notify_with(app: &AppHandle, title: &str, body: &str, click: Click) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        // Eigene App-ID nur in der installierten App (sonst zeigt Windows nichts an)
        let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_string_lossy().to_lowercase())).unwrap_or_default();
        let dev = exe_dir.ends_with("\\target\\debug") || exe_dir.ends_with("\\target\\release");
        let id = if dev { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
        let app2 = app.clone();
        let res = Toast::new(&id)
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                on_click(&app2, click.clone());
                Ok(())
            })
            .show();
        if res.is_ok() {
            return;
        }
    }
    #[cfg(not(windows))]
    let _ = click;
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

pub fn run() {
    log::info(&format!("[app] Ludora {} startet (Tauri)", env!("CARGO_PKG_VERSION")));
    let start_hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        // Zweiter Start: nur das offene Fenster nach vorne holen
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        // Bilder der Launcher (Steam-Cache, Epic, eigene Cover) – ghimg://… bzw. http://ghimg.localhost/…
        .register_asynchronous_uri_scheme_protocol("ghimg", |_ctx, req, responder| {
            tauri::async_runtime::spawn(async move {
                responder.respond(covers::serve_ghimg(req.uri().to_string()).await);
            });
        })
        .invoke_handler(tauri::generate_handler![ipc])

        .setup(move |app| {
            let h = app.handle().clone();
            if let Some(w) = app.get_webview_window("main") {
                if start_hidden {
                    let _ = w.hide();
                    BACKGROUND.store(true, Ordering::Relaxed);
                }
                let h2 = h.clone();
                w.on_window_event(move |ev| {
                    if let tauri::WindowEvent::Focused(true) = ev {
                        updater::poke(updater::MIN_GAP);
                        if is_background() {
                            set_background(&h2, false);
                        }
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        if is_quitting() || !settings::get_bool("closeToTray", true) {
                            return;
                        }
                        api.prevent_close();
                        if let Some(w) = h2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        set_background(&h2, true);
                        if !settings::get_bool("trayHintShown", false) {
                            let mut m = serde_json::Map::new();
                            m.insert("trayHintShown".into(), Value::Bool(true));
                            settings::set(m);
                            notify(
                                &h2,
                                &util::t("Ludora läuft weiter"),
                                &if cfg!(target_os = "macos") {
                                    util::t("Ludora ist oben in der Menüleiste. Beenden über das Symbol dort.")
                                } else {
                                    util::t("Ludora ist unten rechts im Infobereich. Rechtsklick auf das Symbol → Beenden.")
                                },
                            );
                        }
                    }
                });
            }
            if let Err(e) = tray::create(&h) {
                log::warn(&format!("[tray] {e}"));
            }
            steam::init(h.clone());
            friends::init(h.clone());
            hub::init(h.clone());
            updater::init(h.clone());
            shop::init(h.clone());
            // Funktionstest-Fenster (nur Testversion, nicht im Release)
            #[cfg(debug_assertions)]
            selftest::open_window(&h);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Ludora konnte nicht starten")
        .run(|app, ev| match ev {
            // macOS: Klick aufs Dock-Symbol holt das Fenster zurück
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            // Letztes Fenster zu: im Tray weiterlaufen (Beenden nur über quit())
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() && !is_quitting() {
                    api.prevent_exit();
                }
            }
            _ => {
                let _ = app;
            }
        });
}
