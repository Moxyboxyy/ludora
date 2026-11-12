//! Chatfenster (eins pro Freund) und Weiterleitung an Steam / Riot / Epic.
//! Chat-IDs: Steam = SteamID64, andere Launcher = "<launcher>:<id>"

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};



pub fn valid_id(id: &str) -> bool {
    crate::re!(r"^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$").is_match(id)
}

pub fn window_label(id: &str) -> String {
    format!("chat-{}", id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>())
}

fn target(id: &str) -> (&str, &str) {
    match id.split_once(':') {
        Some((l @ ("riot" | "epic"), rest)) => (l, rest),
        _ => ("steam", id),
    }
}

pub fn chat_name(id: &str) -> Option<String> {
    let (l, rid) = target(id);
    if l == "steam" {
        return crate::steam::find_friend(rid).and_then(|f| f["name"].as_str().map(String::from));
    }
    let st = crate::friends::state_of(l)?;
    let f = st["friends"].as_array()?.iter().find(|f| f["id"] == rid)?.clone();
    let tag = f["tag"].as_str().filter(|s| !s.is_empty()).map(|s| format!("#{s}")).unwrap_or_default();
    Some(format!("{}{tag}", f["name"].as_str().unwrap_or("")))
}

fn watch(id: &str, on: bool) {
    match target(id) {
        ("steam", sid) => crate::steam::watch(sid, on),
        ("riot", rid) => crate::friends::riot::watch(rid, on),
        _ => {}
    }
}

pub fn open(app: &AppHandle, id: &str) -> Value {
    if !valid_id(id) {
        return json!({ "ok": false });
    }
    let label = window_label(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return json!({ "ok": true });
    }
    let title = chat_name(id).map(|n| format!("{n} – Chat")).unwrap_or_else(|| "Chat".into());
    // Gleiche Seite wie das Hauptfenster, aber mit #chat=<id> (siehe src/main.jsx)
    let hash = format!("chat={}", crate::net::enc(id));
    let script = format!("if (!/^#chat=/.test(window.location.hash)) window.location.hash = {};", serde_json::to_string(&hash).unwrap());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(420.0, 640.0)
        .min_inner_size(320.0, 400.0)
        .background_color(tauri::window::Color(15, 17, 21, 255))
        .initialization_script(&script)
        .build();
    match built {
        Ok(w) => {
            watch(id, true); // solange offen: häufiger nach neuen Nachrichten schauen
            let id2 = id.to_string();
            w.on_window_event(move |ev| {
                if let tauri::WindowEvent::Destroyed = ev {
                    watch(&id2, false);
                }
            });
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

pub async fn history(id: &str) -> Value {
    if !valid_id(id) {
        return json!({ "ok": false, "messages": [] });
    }
    let r: anyhow::Result<Vec<Value>> = match target(id) {
        ("steam", sid) => crate::steam::history(sid).await,
        ("riot", rid) => crate::friends::riot::history(rid).await,
        (_, eid) => Ok(crate::friends::epic::history(eid)),
    };
    match r {
        Ok(m) => json!({ "ok": true, "messages": m }),
        Err(e) => json!({ "ok": false, "error": e.to_string(), "messages": [] }),
    }
}

pub async fn send(id: &str, text: &str) -> Value {
    if !valid_id(id) || text.trim().is_empty() {
        return json!({ "ok": false });
    }
    let r: anyhow::Result<()> = match target(id) {
        ("steam", sid) => crate::steam::send(sid, text).await.map(|_| ()),
        ("riot", rid) => crate::friends::riot::send(rid, text).await,
        (_, eid) => crate::friends::epic::send(eid, text),
    };
    match r {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

pub fn typing(id: &str) {
    if target(id).0 == "steam" && valid_id(id) {
        crate::steam::typing(id);
    }
}

pub fn read(id: &str) {
    if target(id).0 == "steam" && valid_id(id) {
        crate::steam::mark_read(id);
    }
}


/// Eigenes Freundefenster (statt der Liste im Hauptfenster). Ist es schon offen, wechselt es nur die Liste.
pub fn open_friends(app: &AppHandle, tab: &str, hub: bool) -> Value {
    const TABS: [&str; 6] = ["all", "hub", "steam", "riot", "epic", "gog"];
    let tab = if TABS.contains(&tab) { tab } else { "all" };
    if let Some(w) = app.get_webview_window("friends") {
        let _ = w.emit_to("friends", "friends:tab", tab);
        if hub {
            let _ = w.emit_to("friends", "friends:hub", true);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return json!({ "ok": true });
    }
    // Gleiche Seite wie das Hauptfenster, aber mit #friends=<liste> (siehe src/main.jsx)
    let script = format!("if (!/^#friends=/.test(window.location.hash)) window.location.hash = {};", serde_json::to_string(&format!("friends={tab}{}", if hub { "&hub" } else { "" })).unwrap());
    let b = WebviewWindowBuilder::new(app, "friends", WebviewUrl::App("index.html".into()))
        .title("Ludora – Freunde")
        .inner_size(400.0, 680.0)
        .min_inner_size(320.0, 420.0)
        .background_color(tauri::window::Color(15, 17, 21, 255))
        .initialization_script(&script);
    // Eigene Fensterleiste wie im Hauptfenster: Windows/Linux ohne Systemrahmen, Mac mit Ampel über dem Inhalt
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(14.0, 22.0));
    #[cfg(not(target_os = "macos"))]
    let b = b.decorations(false);
    let built = b.build();
    match built {
        Ok(w) => {
            watch_snap(app, &w);
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// ---------- Andocken: Freundesliste als schmale Leiste rechts im Hauptfenster ----------

/// Freundefenster schließen und die Liste im Hauptfenster rechts andocken (Knopf in der Leiste oder Einrasten)
pub fn dock_friends(app: &AppHandle) -> Value {
    let _ = app.emit_to("main", "friends:snap", false);
    let _ = app.emit_to("main", "friends:dock", true);
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.unminimize();
        let _ = m.show();
        let _ = m.set_focus();
    }
    if let Some(w) = app.get_webview_window("friends") {
        let _ = w.close();
    }
    json!({ "ok": true })
}

/// Liegt der linke Rand des Freundefensters am rechten Rand des Hauptfensters (leicht darüber oder knapp daneben)?
fn in_snap_zone(app: &AppHandle, fw: &tauri::WebviewWindow) -> bool {
    let Some(main) = app.get_webview_window("main") else { return false };
    if !main.is_visible().unwrap_or(false) || main.is_minimized().unwrap_or(false) {
        return false;
    }
    let (Ok(mp), Ok(ms), Ok(fp), Ok(fs)) = (main.outer_position(), main.outer_size(), fw.outer_position(), fw.outer_size()) else {
        return false;
    };
    let scale = main.scale_factor().unwrap_or(1.0);
    let right = mp.x + ms.width as i32;
    let (inside, outside) = ((150.0 * scale) as i32, (30.0 * scale) as i32);
    // senkrecht müssen sich die Fenster mindestens zur Hälfte (des kleineren) überdecken
    let overlap = (mp.y + ms.height as i32).min(fp.y + fs.height as i32) - mp.y.max(fp.y);
    fp.x >= right - inside && fp.x <= right + outside && overlap * 2 >= ms.height.min(fs.height) as i32
}

/// Beim Ziehen des Freundefensters: am rechten Rand des Hauptfensters zeigt das Hauptfenster eine Andock-Fläche;
/// bleibt das Fenster dort kurz liegen (losgelassen oder angehalten), rastet es ein.
fn watch_snap(app: &AppHandle, w: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    let gen = Arc::new(AtomicU64::new(0));
    let hint = Arc::new(AtomicBool::new(false));
    let born = std::time::Instant::now();
    let (app, w2) = (app.clone(), w.clone());
    w.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Moved(_) => {
            // Erste Platzierung durch das System zählt nicht
            if born.elapsed() < std::time::Duration::from_millis(800) {
                return;
            }
            let near = in_snap_zone(&app, &w2);
            if hint.swap(near, Ordering::Relaxed) != near {
                let _ = app.emit_to("main", "friends:snap", near);
            }
            let my = gen.fetch_add(1, Ordering::Relaxed) + 1;
            if !near {
                return;
            }
            let (app, w3, gen) = (app.clone(), w2.clone(), gen.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                if gen.load(Ordering::Relaxed) == my && in_snap_zone(&app, &w3) {
                    dock_friends(&app);
                }
            });
        }
        tauri::WindowEvent::Destroyed => {
            if hint.load(Ordering::Relaxed) {
                let _ = app.emit_to("main", "friends:snap", false);
            }
        }
        _ => {}
    });
}
