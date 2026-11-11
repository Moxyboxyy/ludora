//! GOG-Freundesliste (Anmeldung über GOG Galaxy-OAuth, Online-Status über presence.gog.com)

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Notify;

use super::{get_json, now, status_of, Store};
use crate::util::t;

const CLIENT_ID: &str = "46899977096215655";
const CLIENT_SECRET: &str = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const REDIRECT: &str = "https://embed.gog.com/on_login_success?origin=client";
const LABEL: &str = "friends-gog";
const SECRET: &str = "friendsGog";

pub static STORE: Lazy<Store> = Lazy::new(|| Store::new("gog", json!({ "needsLogin": true })));

#[derive(Clone, Default)]
struct Auth {
    access_token: String,
    refresh_token: String,
    user_id: String,
    expires_at: i64,
}

#[derive(Default)]
struct S {
    auth: Option<Auth>,
    friends: Vec<Value>,
    list_at: i64,
    vault_asked: bool,
}
static ST: Lazy<Mutex<S>> = Lazy::new(Default::default);
static GEN: AtomicU64 = AtomicU64::new(0);
static FAST: AtomicBool = AtomicBool::new(false);
static WAKE: Lazy<Notify> = Lazy::new(Notify::new);
static RENEW: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

async fn token(params: &[(&str, &str)]) -> anyhow::Result<Auth> {
    let mut q: Vec<(&str, &str)> = vec![("client_id", CLIENT_ID), ("client_secret", CLIENT_SECRET)];
    q.extend_from_slice(params);
    let j = get_json(crate::net::client().get("https://auth.gog.com/token").query(&q)).await?;
    let at = j["access_token"].as_str().ok_or_else(|| anyhow::anyhow!(t("GOG-Anmeldung fehlgeschlagen")))?;
    Ok(Auth {
        access_token: at.into(),
        refresh_token: j["refresh_token"].as_str().unwrap_or("").into(),
        user_id: match &j["user_id"] {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        },
        expires_at: now() + j["expires_in"].as_i64().unwrap_or(3600) * 1000,
    })
}

fn save(a: &Auth) {
    crate::secrets::set(SECRET, json!({ "refresh_token": a.refresh_token, "user_id": a.user_id }));
}

async fn ensure_token() -> anyhow::Result<Auth> {
    let _g = RENEW.lock().await;
    let cur = ST.lock().auth.clone().ok_or_else(|| anyhow::anyhow!(t("Nicht angemeldet")))?;
    if cur.expires_at - 60_000 > now() {
        return Ok(cur);
    }
    let mut rt = cur.refresh_token.clone();
    if let Some(d) = crate::secrets::get(SECRET) {
        if d["user_id"].as_str() == Some(&cur.user_id) {
            if let Some(r) = d["refresh_token"].as_str() {
                rt = r.into();
            }
        }
    }
    let a = token(&[("grant_type", "refresh_token"), ("refresh_token", &rt)]).await?;
    save(&a);
    ST.lock().auth = Some(a.clone());
    Ok(a)
}

pub async fn login(app: &AppHandle) -> Value {
    let url = format!("https://auth.gog.com/auth?client_id={CLIENT_ID}&redirect_uri={}&response_type=code&layout=client2", crate::net::enc(REDIRECT));
    let code = super::login_window(app, LABEL, &t("Bei GOG anmelden"), &url, |u, _w| async move {
        if !u.starts_with("https://embed.gog.com/on_login_success") {
            return None;
        }
        tauri::Url::parse(&u).ok()?.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned())
    })
    .await;
    let Some(code) = code else { return json!({ "ok": false, "error": t("Anmeldung abgebrochen") }) };
    match token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT)]).await {
        Ok(a) => {
            save(&a);
            ST.lock().auth = Some(a);
            start();
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

pub async fn logout(_app: &AppHandle) {
    GEN.fetch_add(1, Ordering::SeqCst);
    {
        let mut s = ST.lock();
        s.auth = None;
        s.friends.clear();
    }
    crate::secrets::set(SECRET, Value::Null);
    super::clear_login_data(LABEL);
    STORE.set(json!({ "status": "disconnected", "needsLogin": true, "friends": [], "error": null }));
}

fn is_online(x: &Value) -> bool {
    let v = [&x["presence"], &x["status"], &x["state"], &x["online"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
    let off = |s: &str| matches!(s.to_lowercase().as_str(), "offline" | "invisible" | "unavailable");
    match v {
        Value::Null => true,
        Value::Bool(b) => b,
        Value::Object(o) => {
            let s = ["status", "presence", "state"].iter().find_map(|k| o.get(*k).and_then(|v| v.as_str())).unwrap_or("online");
            !off(s)
        }
        Value::String(s) => !off(&s),
        other => !off(&other.to_string()),
    }
}

fn id_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}

/// Freunde + Online-Liste -> einheitliches Format
pub fn merge(items: &[Value], online: &[Value]) -> Vec<Value> {
    let on: std::collections::HashSet<String> = online
        .iter()
        .filter(|x| is_online(x))
        .map(|x| id_str(if !x["user_id"].is_null() { &x["user_id"] } else if !x["userId"].is_null() { &x["userId"] } else { &x["id"] }))
        .collect();
    items
        .iter()
        .map(|f| {
            let id = id_str(&f["user_id"]);
            let avatar = f["images"]["medium_2x"].as_str().or(f["images"]["medium"].as_str());
            json!({
                "id": id,
                "name": f["username"].as_str().map(String::from).unwrap_or_else(|| id.clone()),
                "avatar": avatar,
                "state": if on.contains(&id) { "online" } else { "offline" },
                "gameName": null, "richText": null, "lastOnline": null
            })
        })
        .collect()
}

async fn poll(load_list: bool) {
    let my = GEN.load(Ordering::SeqCst);
    let res: anyhow::Result<Vec<Value>> = async {
        let a = ensure_token().await?;
        let bearer = format!("Bearer {}", a.access_token);
        let need = { let s = ST.lock(); load_list || s.friends.is_empty() || now() - s.list_at > 600_000 };
        if need {
            let j = get_json(crate::net::client().get(format!("https://chat.gog.com/users/{}/friends", a.user_id)).header("authorization", &bearer)).await?;
            let mut s = ST.lock();
            s.list_at = now();
            s.friends = j["items"].as_array().cloned().unwrap_or_default();
        }
        let friends = ST.lock().friends.clone();
        let mut online = vec![];
        for chunk in friends.chunks(100) {
            let ids = chunk.iter().map(|f| id_str(&f["user_id"])).collect::<Vec<_>>().join(",");
            if let Ok(r) = get_json(crate::net::client().get(format!("https://presence.gog.com/statuses?user_id={ids}")).header("authorization", &bearer)).await {
                online.extend(r["items"].as_array().cloned().unwrap_or_default());
            }
        }
        Ok(merge(&friends, &online))
    }
    .await;
    if my != GEN.load(Ordering::SeqCst) {
        return;
    }
    match res {
        Ok(list) => {
            let n = list.len();
            if STORE.get()["friends"].as_array().map_or(usize::MAX, |a| a.len()) != n {
                crate::log::info(&format!("[friends] gog: {n} Freunde"));
            }
            ST.lock().vault_asked = false;
            STORE.set(json!({ "status": "connected", "needsLogin": false, "error": null, "friends": list }));
        }
        Err(e) => {
            let st = status_of(&e);
            let msg = e.to_string();
            if st == 400 || st == 401 || msg == t("Nicht angemeldet") {
                STORE.set(json!({ "status": "disconnected", "needsLogin": true, "error": t("GOG-Anmeldung abgelaufen – bitte neu anmelden.") }));
                let ask = { let mut s = ST.lock(); let a = !s.vault_asked; s.vault_asked = true; a };
                if ask {
                    tauri::async_runtime::spawn(async { let _ = crate::vault::sync().await; });
                }
                return;
            }
            STORE.set(json!({ "status": "error", "error": format!("GOG: {msg}") }));
        }
    }
}

fn start() {
    crate::log::info("[friends] gog: verbinde");
    let my = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    STORE.set(json!({ "status": "connecting", "needsLogin": false, "error": null }));
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        loop {
            if GEN.load(Ordering::SeqCst) != my || ST.lock().auth.is_none() {
                return;
            }
            poll(first).await;
            first = false;
            if STORE.status() == "disconnected" {
                return;
            }
            let d = if FAST.load(Ordering::SeqCst) { 5000 } else { 15000 };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(d)) => {}
                _ = WAKE.notified() => { first = true; }
            }
        }
    });
}

fn load_saved() -> Option<Auth> {
    let s = crate::secrets::get(SECRET)?;
    let rt = s["refresh_token"].as_str().filter(|x| !x.is_empty())?;
    Some(Auth { refresh_token: rt.into(), user_id: id_str(&s["user_id"]), ..Default::default() })
}

pub fn init() {
    if let Some(a) = load_saved() {
        ST.lock().auth = Some(a);
        start();
    }
}

pub fn restore() {
    let Some(a) = load_saved() else { return };
    if ST.lock().auth.as_ref().map_or(false, |x| x.refresh_token == a.refresh_token) {
        return;
    }
    ST.lock().auth = Some(a);
    start();
}

pub fn refresh() {
    if ST.lock().auth.is_some() && STORE.status() != "disconnected" {
        WAKE.notify_one();
    } else if ST.lock().auth.is_some() {
        start();
    }
}

pub fn set_fast(on: bool) {
    FAST.store(on, Ordering::SeqCst);
    if on && ST.lock().auth.is_some() {
        WAKE.notify_one();
    }
}

pub async fn link_proof() -> Option<Value> {
    ST.lock().auth.as_ref()?;
    let a = ensure_token().await.ok()?;
    Some(json!({ "token": a.access_token, "accountId": a.user_id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_online() {
        let m = merge(&[json!({ "user_id": 5, "username": "a" }), json!({ "user_id": "6" })], &[json!({ "user_id": 5, "status": "online" }), json!({ "user_id": "6", "presence": "offline" })]);
        assert_eq!(m[0]["state"], "online");
        assert_eq!(m[1]["state"], "offline");
        assert_eq!(m[1]["name"], "6");
    }
}
