//! Chatfenster (eins pro Freund) und Weiterleitung an Steam / Riot / Epic.
//! Chat-IDs: Steam = SteamID64, andere Launcher = "<launcher>:<id>"

use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};



pub fn valid_id(id: &str) -> bool {
    Regex::new(r"^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$").unwrap().is_match(id)
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

