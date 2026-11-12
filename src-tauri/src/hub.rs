//! Ludora-Konto (Supabase): Anmeldung, verknüpfte Launcher-Konten, Ludora-Freunde, Herzschlag.
//! Gespeicherte Sitzung: "hubSession" in logins.json.

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::AppHandle;

use crate::friends::{merge, now, status_of, HttpError};
use crate::util::{t, t_args};

const SECRET: &str = "hubSession";
const MIN_PASSWORD: usize = 10;

static APP: OnceCell<AppHandle> = OnceCell::new();
static STATE: Lazy<Mutex<Value>> = Lazy::new(|| {
    Mutex::new(json!({ "status": "signedOut", "error": null, "friends": [], "user": null, "links": [], "configured": false }))
});

#[derive(Clone, Default)]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
}
static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));
static REFRESH: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static LOOP_GEN: AtomicU64 = AtomicU64::new(0);
static FAST: AtomicBool = AtomicBool::new(false);
static WORKING_FN: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static LINKED_ONCE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

struct Cfg {
    url: String,
    anon_key: String,
    link_function: String,
}

fn config() -> Cfg {
    let pick = |env: &str, built: &str| std::env::var(env).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| built.to_string());
    Cfg {
        url: pick("GAMEHUB_HUB_URL", env!("LUDORA_HUB_URL")).trim_end_matches('/').to_string(),
        anon_key: pick("GAMEHUB_HUB_KEY", env!("LUDORA_HUB_KEY")),
        link_function: env!("LUDORA_HUB_FUNCTION").to_string(),
    }
}

pub fn configured() -> bool {
    let c = config();
    !c.url.is_empty() && !c.anon_key.is_empty()
}

pub fn get_state() -> Value {
    STATE.lock().clone()
}

fn set(patch: Value) {
    let snap = {
        let mut s = STATE.lock();
        let has_friends = patch.get("friends").is_some();
        merge(&mut s, patch);
        if has_friends {
            s["updatedAt"] = json!(now());
        }
        s.clone()
    };
    if let Some(app) = APP.get() {
        crate::broadcast(app, "hub:update", snap);
    }
}

pub fn is_signed_in() -> bool {
    SESSION.lock().is_some()
}

pub fn normalize_name(name: &str) -> anyhow::Result<(String, String)> {
    let display = name.trim().to_string();
    let username = display.to_lowercase();
    let ok = (3..=24).contains(&username.chars().count()) && username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c));
    if !ok {
        anyhow::bail!(t("Name: 3–24 Zeichen, nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich."));
    }
    Ok((username, display))
}

fn email_for(username: &str) -> String {
    format!("{username}@gamehub.local")
}

async fn server_secret(password: &str, username: &str) -> String {
    use base64::Engine;
    let (p, u) = (password.to_string(), username.to_string());
    let k = tokio::task::spawn_blocking(move || crate::vault::derive_key(&p, &u, "auth")).await.unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(k)
}

/// Aufruf am Server. `auth`: mit Anmeldung (Token wird bei Bedarf erneuert).
pub async fn request(method: &str, path: &str, body: Option<Value>, auth: bool, headers: &[(&str, &str)]) -> anyhow::Result<Value> {
    let c = config();
    let m = reqwest::Method::from_bytes(method.as_bytes())?;
    let mut r = crate::net::client().request(m, format!("{}{}", c.url, path)).header("apikey", &c.anon_key).header("content-type", "application/json").timeout(Duration::from_secs(20));
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    if auth {
        ensure_session().await?;
        let tok = SESSION.lock().as_ref().map(|s| s.access_token.clone()).unwrap_or_default();
        r = r.header("authorization", format!("Bearer {tok}"));
    }
    if let Some(b) = body {
        r = r.body(b.to_string());
    }
    let res = r.send().await?;
    let st = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    let data: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
    if !(200..300).contains(&st) {
        let msg = ["error_description", "msg", "message", "error"].iter().find_map(|k| data[*k].as_str().map(String::from)).unwrap_or_else(|| t_args("Server antwortet mit {0}", &[&st.to_string()]));
        let code = data["error_code"].as_str().or(data["code"].as_str()).unwrap_or("");
        return Err(HttpError { status: st, msg: if code.is_empty() { msg } else { format!("{msg} [{code}]") } }.into());
    }
    Ok(data)
}

fn set_session(s: Option<&Value>) {
    let mut cur = SESSION.lock();
    *cur = s.map(|s| Session {
        access_token: s["access_token"].as_str().unwrap_or("").into(),
        refresh_token: s["refresh_token"].as_str().unwrap_or("").into(),
        expires_at: now() + s["expires_in"].as_i64().unwrap_or(3600) * 1000,
        user_id: s["user"]["id"].as_str().map(String::from).or_else(|| cur.as_ref().map(|c| c.user_id.clone())).unwrap_or_default(),
    });
    crate::secrets::set(SECRET, cur.as_ref().map_or(Value::Null, |s| json!({ "refresh_token": s.refresh_token, "user_id": s.user_id })));
}

async fn ensure_session() -> anyhow::Result<()> {
    let _g = REFRESH.lock().await;
    let s = SESSION.lock().clone().ok_or_else(|| anyhow::anyhow!(t("Nicht bei Ludora angemeldet")))?;
    if s.expires_at - 60_000 > now() {
        return Ok(());
    }
    let mut rt = s.refresh_token.clone();
    if let Some(d) = crate::secrets::get(SECRET) {
        if d["user_id"].as_str() == Some(&s.user_id) {
            if let Some(r) = d["refresh_token"].as_str() {
                rt = r.into();
            }
        }
    }
    let r = Box::pin(request("POST", "/auth/v1/token?grant_type=refresh_token", Some(json!({ "refresh_token": rt })), false, &[])).await?;
    set_session(Some(&r));
    Ok(())
}

fn user_id() -> String {
    SESSION.lock().as_ref().map(|s| s.user_id.clone()).unwrap_or_default()
}

async fn refresh_state() -> anyhow::Result<Value> {
    let uid = user_id();
    let ppath = format!("/rest/v1/profiles?id=eq.{uid}&select=username,display_name");
    let (profile, links) = tokio::join!(
        request("GET", &ppath, None, true, &[]),
        request("GET", "/rest/v1/linked_accounts?select=launcher,account_id,account_name,verified,updated_at&order=launcher", None, true, &[])
    );
    let profile = profile?;
    let links = links?;
    set(json!({ "status": "signedIn", "error": null, "user": profile.get(0).cloned().unwrap_or(Value::Null), "links": if links.is_array() { links } else { json!([]) } }));
    crate::vault::attach(&uid);
    if LOOP_GEN.load(Ordering::SeqCst) % 2 == 0 {
        start_loops();
    }
    Ok(get_state())
}

fn friendly(e: &anyhow::Error) -> String {
    let m = e.to_string();
    let has = |re: &str| regex::Regex::new(re).unwrap().is_match(&m);
    if has(r"(?i)already registered|already exists|duplicate key") {
        return t("Dieser Name ist schon vergeben.");
    }
    if has(r"(?i)Invalid login credentials") {
        return t("Name oder Passwort falsch.");
    }
    if has(r"(?i)Password should be") {
        return t_args("Passwort zu kurz (mindestens {0} Zeichen).", &[&MIN_PASSWORD.to_string()]);
    }
    if has(r"(?i)Email not confirmed") {
        return t("Im Supabase-Projekt ist \"Confirm email\" noch an – bitte ausschalten (siehe Anleitung).");
    }
    m
}

fn not_configured() -> Value {
    json!({ "ok": false, "error": t("Ludora-Server ist noch nicht eingerichtet (hub-config.json).") })
}

pub async fn register(name: &str, password: &str) -> Value {
    if !configured() {
        return not_configured();
    }
    let r: anyhow::Result<()> = async {
        let (username, display) = normalize_name(name)?;
        if password.chars().count() < MIN_PASSWORD {
            anyhow::bail!(t_args("Passwort zu kurz (mindestens {0} Zeichen).", &[&MIN_PASSWORD.to_string()]));
        }
        let secret = server_secret(password, &username).await;
        let s = request("POST", "/auth/v1/signup", Some(json!({ "email": email_for(&username), "password": secret, "data": { "username": username } })), false, &[]).await?;
        if s["access_token"].as_str().is_none() {
            anyhow::bail!("Email not confirmed");
        }
        set_session(Some(&s));
        request("POST", "/rest/v1/profiles", Some(json!({ "id": user_id(), "username": username, "display_name": display })), true, &[("prefer", "return=minimal")]).await?;
        refresh_state().await?;
        unlock_vault(password, &username).await;
        Ok(())
    }
    .await;
    match r {
        Ok(()) => {
            LINKED_ONCE.lock().clear();
            link_all();
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": friendly(&e) }),
    }
}

pub async fn login(name: &str, password: &str) -> Value {
    if !configured() {
        return not_configured();
    }
    let r: anyhow::Result<Vec<String>> = async {
        let (username, _) = normalize_name(name)?;
        let secret = server_secret(password, &username).await;
        let sign_in = |pw: String| {
            let email = email_for(&username);
            async move { request("POST", "/auth/v1/token?grant_type=password", Some(json!({ "email": email, "password": pw })), false, &[]).await }
        };
        let s = match sign_in(secret.clone()).await {
            Ok(s) => s,
            Err(e) => {
                if !e.to_string().contains("Invalid login credentials") {
                    return Err(e);
                }
                // Alte Konten: Klartext-Passwort -> auf abgeleitetes Geheimnis umstellen
                let s = sign_in(password.to_string()).await?;
                set_session(Some(&s));
                request("PUT", "/auth/v1/user", Some(json!({ "password": secret })), true, &[]).await?;
                s
            }
        };
        set_session(Some(&s));
        refresh_state().await?;
        Ok(unlock_vault(password, &username).await)
    }
    .await;
    match r {
        Ok(restored) => {
            LINKED_ONCE.lock().clear();
            link_all();
            json!({ "ok": true, "restored": restored })
        }
        Err(e) => json!({ "ok": false, "error": friendly(&e) }),
    }
}

async fn unlock_vault(password: &str, username: &str) -> Vec<String> {
    crate::vault::unlock(password, username).await;
    match crate::vault::sync().await {
        Ok(r) => r,
        Err(e) => {
            let m = e.to_string();
            crate::log::warn(&format!("[vault] {m}"));
            let missing = crate::re!(r"vaults|PGRST205|42P01|404").is_match(&m);
            set(json!({ "vaultError": if missing { Value::String(t("Auf dem Ludora-Server fehlt noch supabase/04_vault.sql (im SQL Editor ausführen).")) } else { Value::Null } }));
            vec![]
        }
    }
}

fn signed_out() {
    set_session(None);
    crate::vault::detach(true);
    stop_loops();
    LINKED_ONCE.lock().clear();
    set(json!({ "status": "signedOut", "user": null, "links": [], "friends": [], "error": null }));
}

pub async fn logout() -> Value {
    if is_signed_in() {
        let _ = request("POST", "/auth/v1/logout", None, true, &[]).await;
    }
    signed_out();
    json!({ "ok": true })
}

pub async fn delete_account() -> Value {
    if !is_signed_in() {
        return json!({ "ok": false, "error": t("Nicht bei Ludora angemeldet") });
    }
    if let Err(e) = request("POST", "/rest/v1/rpc/delete_my_account", Some(json!({})), true, &[]).await {
        return json!({ "ok": false, "error": friendly(&e) });
    }
    signed_out();
    json!({ "ok": true })
}

pub async fn link(launcher: &str, token: &str, claim: Value) -> Value {
    if !is_signed_in() {
        return json!({ "ok": false, "error": t("Nicht bei Ludora angemeldet") });
    }
    let mut names: Vec<String> = vec![];
    for n in [WORKING_FN.lock().clone(), Some(config().link_function), Some("link".into()), Some("super-worker".into()), Some("hello-world".into())].into_iter().flatten() {
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    let mut last: Option<anyhow::Error> = None;
    let nf = crate::re!(r"(?i)Requested function was not found|NOT_FOUND");
    for name in names {
        let body = json!({ "launcher": launcher, "token": token, "claim": if claim.is_object() { claim.clone() } else { json!({}) } });
        match request("POST", &format!("/functions/v1/{}", crate::net::enc(&name)), Some(body), true, &[]).await {
            Ok(r) => {
                *WORKING_FN.lock() = Some(name);
                let _ = refresh_state().await;
                let mut out = json!({ "ok": true });
                merge(&mut out, r);
                out["ok"] = json!(true);
                return out;
            }
            Err(e) => {
                let missing = status_of(&e) == 404 || nf.is_match(&e.to_string());
                last = Some(e);
                if !missing {
                    break;
                }
            }
        }
    }
    let e = last.unwrap_or_else(|| anyhow::anyhow!("?"));
    json!({
        "ok": false,
        "error": if nf.is_match(&e.to_string()) {
            t("Die Prüf-Funktion fehlt auf dem Ludora-Server (Supabase → Edge Functions, Inhalt von supabase/functions/link/index.ts).")
        } else { friendly(&e) }
    })
}

pub async fn unlink(launcher: &str, account_id: &str) -> Value {
    let p = format!("/rest/v1/linked_accounts?launcher=eq.{}&account_id=eq.{}", crate::net::enc(launcher), crate::net::enc(account_id));
    match request("DELETE", &p, None, true, &[]).await {
        Ok(_) => {
            let _ = refresh_state().await;
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": friendly(&e) }),
    }
}

pub async fn lookup(items: Vec<Value>) -> anyhow::Result<Vec<Value>> {
    if !is_signed_in() || items.is_empty() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for chunk in items.chunks(1000) {
        let r = request("POST", "/rest/v1/rpc/lookup_accounts", Some(json!({ "items": chunk })), true, &[]).await?;
        out.extend(r.as_array().cloned().unwrap_or_default());
    }
    Ok(out)
}

pub fn set_link_error(launcher: &str, msg: Option<String>) {
    let mut le = STATE.lock()["linkErrors"].as_object().cloned().unwrap_or_default();
    match msg {
        Some(m) => {
            le.insert(launcher.into(), Value::String(m));
        }
        None => {
            le.remove(launcher);
        }
    }
    set(json!({ "linkErrors": le }));
}

/// Launcher-Konto mit dem Ludora-Konto verknüpfen (einmal pro Sitzung und Konto).
/// None = dort nicht angemeldet, Some(Ok) = verknüpft (oder schon erledigt), Some(Err) = fehlgeschlagen.
async fn link_one(launcher: &str) -> Option<Result<(), String>> {
    let proof = crate::friends::link_proof(launcher).await?;
    let acc = match &proof["accountId"] {
        Value::String(s) => s.clone(),
        Value::Null => return None,
        v => v.to_string(),
    };
    if LINKED_ONCE.lock().get(launcher) == Some(&acc) {
        return Some(Ok(()));
    }
    let r = link(launcher, proof["token"].as_str().unwrap_or(""), proof["claim"].clone()).await;
    if r["ok"] == true {
        LINKED_ONCE.lock().insert(launcher.to_string(), acc);
        set_link_error(launcher, None);
        Some(Ok(()))
    } else {
        let e = r["error"].as_str().unwrap_or("").to_string();
        crate::log::warn(&format!("[hub] Verknüpfen {launcher} {e}"));
        set_link_error(launcher, Some(e.clone()));
        Some(Err(e))
    }
}

/// Im Hintergrund verknüpfen – aufgerufen, sobald ein Launcher-Konto in Ludora angemeldet ist
pub fn auto_link(launcher: &str) {
    if !is_signed_in() {
        return;
    }
    let launcher = launcher.to_string();
    tauri::async_runtime::spawn(async move {
        link_one(&launcher).await;
    });
}

const LINKABLE: [&str; 4] = ["steam", "riot", "epic", "gog"];

pub fn link_all() {
    for l in LINKABLE {
        auto_link(l);
    }
}

/// Knopf „Jetzt verknüpfen“: alle angemeldeten Launcher-Konten neu verknüpfen und das Ergebnis melden
pub async fn relink() -> Value {
    if !is_signed_in() {
        return json!({ "ok": false, "error": t("Nicht bei Ludora angemeldet") });
    }
    LINKED_ONCE.lock().clear();
    let results = futures::future::join_all(LINKABLE.iter().map(|l| link_one(l))).await;
    let (mut linked, mut failed) = (vec![], serde_json::Map::new());
    for (l, r) in LINKABLE.iter().zip(results) {
        match r {
            Some(Ok(())) => linked.push(*l),
            Some(Err(e)) => {
                failed.insert(l.to_string(), Value::String(e));
            }
            None => {}
        }
    }
    json!({ "ok": failed.is_empty(), "linked": linked, "failed": failed })
}

// ---------- Ludora-Freunde, Herzschlag ----------

async fn load_friends() -> anyhow::Result<()> {
    if !is_signed_in() {
        return Ok(());
    }
    let rows = request("POST", "/rest/v1/rpc/my_friends", Some(json!({})), true, &[]).await?;
    let n = now();
    let list: Vec<Value> = rows
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let seen = r["last_seen"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis());
            json!({
                "username": r["username"],
                "displayName": if r["display_name"].as_str().map_or(true, |s| s.is_empty()) { r["username"].clone() } else { r["display_name"].clone() },
                "relation": r["relation"],
                "online": seen.is_some_and(|s| n - s < 75_000),
                "lastSeen": seen,
                "accounts": if r["accounts"].is_array() { r["accounts"].clone() } else { json!([]) }
            })
        })
        .collect();
    set(json!({ "friends": list, "friendsError": null }));
    Ok(())
}

pub async fn refresh_friends() -> Value {
    if let Err(e) = load_friends().await {
        let m = e.to_string();
        let missing = crate::re!(r"my_friends|404|PGRST202").is_match(&m);
        set(json!({ "friendsError": if missing {
            t("Auf dem Ludora-Server fehlt noch supabase/02_friends.sql (im SQL Editor ausführen).")
        } else { t_args("Ludora-Freunde: {0}", &[&friendly(&e)]) } }));
    }
    Value::Null
}

/// LOOP_GEN ungerade = Schleifen laufen
fn start_loops() {
    let my = {
        let g = LOOP_GEN.load(Ordering::SeqCst);
        let n = if g % 2 == 0 { g + 1 } else { g + 2 };
        LOOP_GEN.store(n, Ordering::SeqCst);
        n
    };
    tauri::async_runtime::spawn(async move {
        while LOOP_GEN.load(Ordering::SeqCst) == my {
            let _ = request("POST", "/rest/v1/rpc/heartbeat", Some(json!({})), true, &[]).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        while LOOP_GEN.load(Ordering::SeqCst) == my {
            refresh_friends().await;
            let mut waited = 0;
            let limit = if FAST.load(Ordering::SeqCst) { 5000 } else { crate::idle_ms(15000) };
            while waited < limit && LOOP_GEN.load(Ordering::SeqCst) == my {
                tokio::time::sleep(Duration::from_millis(500)).await;
                waited += 500;
                if FAST.load(Ordering::SeqCst) && waited >= 5000 {
                    break;
                }
            }
        }
    });
}

fn stop_loops() {
    let g = LOOP_GEN.load(Ordering::SeqCst);
    if g % 2 == 1 {
        LOOP_GEN.store(g + 1, Ordering::SeqCst);
    }
}

pub fn set_fast(on: bool) {
    let was = FAST.swap(on, Ordering::SeqCst);
    if on && !was && is_signed_in() {
        tauri::async_runtime::spawn(refresh_friends());
    }
}

/// Beim Beenden: sofort als offline zeigen
pub async fn go_offline() {
    let uid = user_id();
    if uid.is_empty() {
        return;
    }
    let ts = (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339();
    let _ = request("PATCH", &format!("/rest/v1/profiles?id=eq.{}", crate::net::enc(&uid)), Some(json!({ "last_seen": ts })), true, &[("prefer", "return=minimal")]).await;
}

fn request_text(code: &str) -> Option<String> {
    Some(t(match code {
        "requested" => "Anfrage gesendet.",
        "accepted" => "Ihr seid jetzt befreundet – er/sie hatte dich schon angefragt.",
        "already_friends" => "Ihr seid schon befreundet.",
        "already_requested" => "Du hast schon eine Anfrage geschickt.",
        "not_found" => "Diesen Ludora-Namen gibt es nicht.",
        "self" => "Das bist du selbst 🙂",
        _ => return None,
    }))
}

pub async fn friend_request(name: &str) -> Value {
    let target = name.trim().trim_start_matches('@').to_lowercase();
    if target.is_empty() {
        return json!({ "ok": false, "error": t("Bitte einen Ludora-Namen eingeben.") });
    }
    match request("POST", "/rest/v1/rpc/friend_request", Some(json!({ "target_username": target })), true, &[]).await {
        Ok(code) => {
            refresh_friends().await;
            let c = code.as_str().map(String::from).unwrap_or_else(|| code.to_string());
            let ok = c == "requested" || c == "accepted";
            let text = request_text(&c).unwrap_or_else(|| c.clone());
            json!({ "ok": ok, "code": c, "message": text, "error": if ok { Value::Null } else { Value::String(text.clone()) } })
        }
        Err(e) => json!({ "ok": false, "error": friendly(&e) }),
    }
}

async fn simple_rpc(func: &str, body: Value) -> Value {
    match request("POST", &format!("/rest/v1/rpc/{func}"), Some(body), true, &[]).await {
        Ok(_) => {
            refresh_friends().await;
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": friendly(&e) }),
    }
}

pub async fn friend_accept(name: &str) -> Value {
    simple_rpc("friend_accept", json!({ "from_username": name })).await
}

pub async fn friend_remove(name: &str) -> Value {
    simple_rpc("friend_remove", json!({ "other_username": name })).await
}

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    set(json!({ "configured": configured() }));
    let Some(saved) = crate::secrets::get(SECRET) else { return };
    let Some(rt) = saved["refresh_token"].as_str().filter(|s| !s.is_empty()) else { return };
    if !configured() {
        return;
    }
    *SESSION.lock() = Some(Session { refresh_token: rt.into(), user_id: saved["user_id"].as_str().unwrap_or("").into(), expires_at: 0, ..Default::default() });
    tauri::async_runtime::spawn(connect_saved());
}

async fn connect_saved() {
    let mut retries = 0u32;
    loop {
        match refresh_state().await {
            Ok(_) => {
                if crate::vault::has_key() {
                    if let Err(e) = crate::vault::sync().await {
                        crate::log::warn(&format!("[vault] {e}"));
                    }
                }
                link_all();
                return;
            }
            Err(e) => {
                if !is_signed_in() {
                    return;
                }
                let st = status_of(&e);
                if st == 400 || st == 401 {
                    set_session(None);
                    crate::vault::detach(false);
                    set(json!({ "status": "signedOut", "error": t("Ludora-Anmeldung abgelaufen – bitte neu anmelden.") }));
                    return;
                }
                set(json!({ "status": "signedIn", "error": t("Ludora-Server nicht erreichbar – neuer Versuch läuft …") }));
                tokio::time::sleep(Duration::from_millis((10_000u64 * 2u64.pow(retries.min(5))).min(300_000))).await;
                retries += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names() {
        assert_eq!(normalize_name(" Max_1 ").unwrap(), ("max_1".to_string(), "Max_1".to_string()));
        assert!(normalize_name("ab").is_err());
        assert!(normalize_name("a b c").is_err());
    }
}
