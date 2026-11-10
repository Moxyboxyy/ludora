//! Web-Anmeldungen in einem eigenen Fenster (Battle.net-Konto).
//! Nach dem Login werden die Cookies der Seite verschlüsselt gespeichert; spätere Abrufe der
//! Bibliothek laufen dann ohne Fenster direkt mit diesen Cookies.

use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::util::*;

fn secret_key(id: &str) -> String {
    format!("webauth_{id}")
}

pub fn clear_session(id: &str) {
    crate::secrets::set(&secret_key(id), Value::Null);
    if let Some(dir) = profile_dir(id) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn profile_dir(id: &str) -> Option<std::path::PathBuf> {
    Some(crate::paths::data_dir().join("webauth").join(id))
}

/// JSON mit den gespeicherten Cookies abrufen.
/// None = nicht angemeldet/offline; Some(Err) = Anmeldung abgelaufen; Some(Ok) = Daten
pub async fn fetch_json_with_session(id: &str, url: &str) -> Option<Result<Value, ()>> {
    let cookie = crate::secrets::get(&secret_key(id))?.as_str()?.to_string();
    let res = crate::net::client()
        .get(url)
        .header("cookie", cookie)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if res.status().as_u16() != 200 {
        return Some(Err(()));
    }
    let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !ct.contains("json") {
        return Some(Err(()));
    }
    Some(res.json::<Value>().await.map_err(|_| ()))
}

/// Anmeldefenster öffnen; löst auf, sobald die Bibliothek abrufbar ist oder das Fenster zu ist
pub async fn login(app: &AppHandle, id: &str) -> Value {
    let Some(acc) = crate::accounts::account(id) else { return serde_json::json!({ "ok": false }) };
    let label = format!("account-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return serde_json::json!({ "ok": false, "error": t("Anmeldung läuft bereits") });
    }
    let Ok(url) = acc.login_url.parse() else { return serde_json::json!({ "ok": false }) };
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(t_args("Bei {0} anmelden", &[acc.name]))
        .inner_size(520.0, 760.0)
        .background_color(tauri::window::Color(15, 17, 21, 255));
    #[cfg(not(target_os = "macos"))]
    if let Some(d) = profile_dir(id) {
        b = b.data_directory(d);
    }
    let Ok(win) = b.build() else { return serde_json::json!({ "ok": false, "error": t("Fenster konnte nicht geöffnet werden") }) };

    // Bis zu 10 Minuten warten: angemeldet, sobald die Bibliothek mit den Cookies des Fensters abrufbar ist
    for _ in 0..600 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(w) = app.get_webview_window(&label) else {
            return serde_json::json!({ "ok": false, "error": t("Anmeldung abgebrochen") });
        };
        let Ok(cur) = w.url() else { continue };
        if cur.host_str() != Some(acc.logged_in_host) || cur.path().to_lowercase().contains("/login") {
            continue;
        }
        let Ok(lib_url) = acc.library_url.parse::<tauri::Url>() else { continue };
        let Ok(cookies) = w.cookies_for_url(lib_url) else { continue };
        let header = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
        if header.is_empty() {
            continue;
        }
        crate::secrets::set(&secret_key(id), Value::String(header));
        if let Some(Ok(j)) = fetch_json_with_session(id, acc.library_url).await {
            let games = crate::accounts::collect_games(&j);
            crate::accounts::save_library(id, &games);
            let _ = win.close();
            return serde_json::json!({ "ok": true, "count": games.len() });
        }
    }
    let _ = win.close();
    serde_json::json!({ "ok": false, "error": t("Anmeldung abgebrochen") })
}
