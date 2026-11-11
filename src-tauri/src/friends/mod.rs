//! Weitere Freundeslisten (Riot, Epic, GOG), gemeinsamer Zustandsspeicher, Chat-Verlauf und Personen.
//! Entspricht electron/lib/friends/*.js.

pub mod chatlog;
pub mod epic;
pub mod gog;
pub mod riot;

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::util::t;

static APP: OnceCell<AppHandle> = OnceCell::new();

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Kleiner Zustandsspeicher mit Benachrichtigung (friends2:update + automatisches Verknüpfen mit dem Ludora-Konto)
pub struct Store {
    id: &'static str,
    state: Mutex<Value>,
}

impl Store {
    pub fn new(id: &'static str, initial: Value) -> Self {
        let mut s = json!({ "status": "disconnected", "error": null, "friends": [] });
        merge(&mut s, initial);
        Store { id, state: Mutex::new(s) }
    }
    pub fn get(&self) -> Value {
        self.state.lock().clone()
    }
    pub fn status(&self) -> String {
        self.state.lock()["status"].as_str().unwrap_or("").to_string()
    }
    pub fn set(&self, patch: Value) {
        let snapshot = {
            let mut s = self.state.lock();
            let has_friends = patch.get("friends").is_some();
            merge(&mut s, patch);
            if has_friends {
                s["updatedAt"] = json!(now());
            }
            s.clone()
        };
        if let Some(e) = snapshot["error"].as_str() {
            crate::log::warn(&format!("[friends] {} {}: {e}", self.id, snapshot["status"].as_str().unwrap_or("")));
        }
        if let Some(app) = APP.get() {
            crate::broadcast(app, "friends2:update", json!({ "id": self.id, "state": snapshot }));
        }
        if snapshot["status"] == "connected" {
            crate::hub::auto_link(self.id);
        }
    }
}

pub fn merge(target: &mut Value, patch: Value) {
    if let (Some(t), Value::Object(p)) = (target.as_object_mut(), patch) {
        for (k, v) in p {
            t.insert(k, v);
        }
    }
}

/// Netzwerkfehler (kein Internet, Server kurz weg) – dann später erneut versuchen statt abzumelden
pub fn is_transient(m: &str) -> bool {
    let re_no = regex::Regex::new(r"(?i)invalid_grant|invalid_token|unauthori[sz]ed|\b40[013]\b|expired|revoked").unwrap();
    if re_no.is_match(m) {
        return false;
    }
    regex::Regex::new(r"(?i)dns|resolve|connect|reset|refused|timed? ?out|unreachable|socket|network|error sending request|\b5\d\d\b|\b429\b").unwrap().is_match(m)
}

pub fn unescape_xml(s: &str) -> String {
    let s = s.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">");
    let re = regex::Regex::new(r"&#(\d+);").unwrap();
    let s = re.replace_all(&s, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_default());
    s.replace("&amp;", "&")
}

pub fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// HTTP-Fehler mit Status (für "abgelaufen" vs. "kurz weg")
#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub msg: String,
}
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.msg)
    }
}
impl std::error::Error for HttpError {}

pub fn status_of(e: &anyhow::Error) -> u16 {
    e.downcast_ref::<HttpError>().map_or(0, |h| h.status)
}

pub async fn get_json(req: reqwest::RequestBuilder) -> anyhow::Result<Value> {
    let res = req.timeout(std::time::Duration::from_secs(20)).send().await?;
    let st = res.status().as_u16();
    if !(200..300).contains(&st) {
        return Err(HttpError { status: st, msg: format!("HTTP {st}") }.into());
    }
    Ok(res.json().await?)
}

// ---------- Personen (ein Freund über mehrere Launcher) ----------

pub fn clean_people(list: &Value) -> Value {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for p in list.as_array().cloned().unwrap_or_default() {
        let name: String = p["name"].as_str().unwrap_or("").trim().chars().take(60).collect();
        if name.is_empty() {
            continue;
        }
        let mut members = vec![];
        for m in p["members"].as_array().cloned().unwrap_or_default() {
            let launcher = m["launcher"].as_str().unwrap_or("").to_string();
            let id: String = match &m["id"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            }
            .chars()
            .take(120)
            .collect();
            let key = format!("{launcher}:{id}");
            if !["steam", "riot", "epic", "gog"].contains(&launcher.as_str()) || id.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            members.push(json!({ "launcher": launcher, "id": id }));
        }
        let pid = p["id"].as_str().filter(|s| s.len() == 16 && s.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9'))).map(String::from).unwrap_or_else(|| hex::encode(rand::random::<[u8; 8]>()));
        out.push(json!({ "id": pid, "name": name, "members": members }));
    }
    Value::Array(out)
}

pub fn people_get() -> Value {
    clean_people(&crate::settings::get("friendPeople").unwrap_or(json!([])))
}

pub fn people_save(list: &Value) -> Value {
    let c = clean_people(list);
    let mut m = Map::new();
    m.insert("friendPeople".into(), c.clone());
    crate::settings::set(m);
    c
}

// ---------- Gemeinsame Steuerung ----------

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    chatlog::init(crate::paths::data_dir().join("chat-log.json"));
    riot::init();
    epic::init();
    gog::init();
}

pub fn list() -> Value {
    json!({ "riot": riot::STORE.get(), "epic": epic::STORE.get(), "gog": gog::STORE.get() })
}

pub fn state_of(id: &str) -> Option<Value> {
    match id {
        "riot" => Some(riot::STORE.get()),
        "epic" => Some(epic::STORE.get()),
        "gog" => Some(gog::STORE.get()),
        _ => None,
    }
}

pub async fn login(app: &AppHandle, id: &str) -> Value {
    match id {
        "epic" => epic::login(app).await,
        "gog" => gog::login(app).await,
        _ => json!({ "ok": false, "error": t("Nicht möglich") }),
    }
}

pub async fn logout(app: &AppHandle, id: &str) {
    match id {
        "epic" => epic::logout(app).await,
        "gog" => gog::logout(app).await,
        _ => {}
    }
}

pub fn refresh(id: &str) {
    match id {
        "riot" => riot::refresh(),
        "epic" => epic::refresh(),
        "gog" => gog::refresh(),
        _ => {}
    }
}

pub fn set_fast(on: bool) {
    riot::set_fast(on);
    gog::set_fast(on);
}

/// Anmeldung kam über das Ludora-Konto von einem anderen Gerät
pub fn on_restore(name: &str) {
    match name {
        "steamWebToken" => crate::steam::restore(),
        "friendsEpic" => epic::restore(),
        "friendsGog" => gog::restore(),
        _ => {}
    }
}

pub async fn link_proof(launcher: &str) -> Option<Value> {
    match launcher {
        "steam" => crate::steam::link_proof().await,
        "riot" => riot::link_proof().await,
        "epic" => epic::link_proof().await,
        "gog" => gog::link_proof().await,
        _ => None,
    }
}

/// Anmeldefenster (Epic/GOG): löst mit dem Ergebnis von `check` auf, oder None, wenn das Fenster geschlossen wurde.
/// `check` bekommt jede besuchte Adresse (auch Weiterleitungen) und das Fenster.
pub async fn login_window<F, Fut>(app: &AppHandle, label: &str, title: &str, url: &str, check: F) -> Option<String>
where
    F: Fn(String, tauri::WebviewWindow) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_focus();
        return None;
    }
    let seen: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
    let seen2 = seen.clone();
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse().ok()?))
        .title(title)
        .inner_size(520.0, 780.0)
        .background_color(tauri::window::Color(15, 17, 21, 255))
        .on_navigation(move |u| {
            seen2.lock().push(u.to_string());
            true
        });
    #[cfg(not(target_os = "macos"))]
    {
        b = b.data_directory(crate::paths::data_dir().join("webauth").join(label));
    }
    let win = b.build().ok()?;
    let mut checked = 0usize;
    for _ in 0..1200 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let Some(w) = app.get_webview_window(label) else { return None };
        let mut urls: Vec<String> = {
            let s = seen.lock();
            s[checked.min(s.len())..].to_vec()
        };
        checked += urls.len();
        if let Ok(u) = w.url() {
            urls.push(u.to_string());
        }
        for u in urls {
            if let Some(r) = check(u, w.clone()).await {
                let _ = win.close();
                return Some(r);
            }
        }
    }
    let _ = win.close();
    None
}

/// Anmeldedaten eines Fensters löschen (entspricht clearPartition)
pub fn clear_login_data(label: &str) {
    let _ = std::fs::remove_dir_all(crate::paths::data_dir().join("webauth").join(label));
}

/// Cookie-Kopfzeile eines Anmeldefensters für eine Adresse
pub fn cookie_header(w: &tauri::WebviewWindow, url: &str) -> Option<String> {
    let cookies = w.cookies_for_url(url.parse().ok()?).ok()?;
    let h = cookies.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
    if h.is_empty() {
        None
    } else {
        Some(h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn people_clean_dedupes() {
        let c = clean_people(&json!([{ "id": "zz", "name": " Max ", "members": [{ "launcher": "steam", "id": "1" }, { "launcher": "steam", "id": "1" }, { "launcher": "x", "id": "2" }] }, { "name": "" }]));
        assert_eq!(c.as_array().unwrap().len(), 1);
        assert_eq!(c[0]["name"], "Max");
        assert_eq!(c[0]["members"].as_array().unwrap().len(), 1);
        assert_eq!(c[0]["id"].as_str().unwrap().len(), 16);
    }
    #[test]
    fn xml_roundtrip() {
        assert_eq!(unescape_xml(&escape_xml("a<b>&\"'")), "a<b>&\"'");
        assert_eq!(unescape_xml("&#228;"), "ä");
    }
}
