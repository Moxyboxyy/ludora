//! Epic-Freundesliste: Anmeldung per OAuth (Launcher-Client), Freunde über die Friends-API,
//! Online-Status und Chat live über Epics XMPP-Websocket.

use futures::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::{escape_xml, get_json, now, status_of, unescape_xml, Store};
use crate::util::{t, t_args};

const CLIENT_ID: &str = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET: &str = "daafbccc737745039dffe53d94fc76cf";
const OAUTH: &str = "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token";
const FRIENDS: &str = "https://friends-public-service-prod.ol.epicgames.com/friends/api/v1";
const ACCOUNTS: &str = "https://account-public-service-prod.ol.epicgames.com/account/api/public/account";
const XMPP_URL: &str = "wss://xmpp-service-prod.ol.epicgames.com//";
const XMPP_DOMAIN: &str = "prod.ol.epicgames.com";
const LABEL: &str = "friends-epic";
const SECRET: &str = "friendsEpic";

pub static STORE: Lazy<Store> = Lazy::new(|| Store::new("epic", json!({ "needsLogin": true })));

#[derive(Clone, Default)]
struct Auth {
    access_token: String,
    refresh_token: String,
    account_id: String,
    expires_at: i64,
}

#[derive(Clone)]
struct Pres {
    show: Option<String>,
    status: Option<Value>,
}

#[derive(Default)]
struct S {
    auth: Option<Auth>,
    friend_ids: Vec<String>,
    names: HashMap<String, String>,
    presence: HashMap<String, HashMap<String, Pres>>,
    sender: Option<mpsc::UnboundedSender<String>>,
}
static ST: Lazy<Mutex<S>> = Lazy::new(Default::default);
static GEN: AtomicU64 = AtomicU64::new(0);
static RENEW: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static PUBLISH_GEN: AtomicU64 = AtomicU64::new(0);

async fn token(params: &[(&str, &str)]) -> anyhow::Result<Auth> {
    use base64::Engine;
    let mut form: Vec<(&str, &str)> = params.to_vec();
    form.push(("token_type", "eg1"));
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}"));
    let res = crate::net::client()
        .post(OAUTH)
        .header("authorization", format!("basic {basic}"))
        .form(&form)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    let st = res.status().as_u16();
    let j: Value = res.json().await.unwrap_or(json!({}));
    let Some(at) = j["access_token"].as_str().filter(|_| (200..300).contains(&st)) else {
        let msg = j["errorMessage"].as_str().map(String::from).unwrap_or_else(|| t_args("Epic-Anmeldung fehlgeschlagen ({0})", &[&st.to_string()]));
        let code = j["errorCode"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {st}"));
        return Err(super::HttpError { status: st, msg: format!("{msg} ({code})") }.into());
    };
    Ok(Auth {
        access_token: at.into(),
        refresh_token: j["refresh_token"].as_str().unwrap_or("").into(),
        account_id: j["account_id"].as_str().unwrap_or("").into(),
        expires_at: now() + j["expires_in"].as_i64().unwrap_or(7200) * 1000,
    })
}

fn save(a: &Auth) {
    crate::secrets::set(SECRET, json!({ "refresh_token": a.refresh_token, "account_id": a.account_id }));
}

async fn ensure_token() -> anyhow::Result<Auth> {
    let _g = RENEW.lock().await;
    let cur = ST.lock().auth.clone().ok_or_else(|| anyhow::anyhow!(t("Nicht angemeldet")))?;
    if cur.expires_at - 60_000 > now() {
        return Ok(cur);
    }
    let mut rt = cur.refresh_token.clone();
    if let Some(d) = crate::secrets::get(SECRET) {
        if d["account_id"].as_str() == Some(&cur.account_id) {
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
    let redirect = format!("https://www.epicgames.com/id/api/redirect?clientId={CLIENT_ID}&responseType=code");
    let url = format!("https://www.epicgames.com/id/login?redirectUrl={}", crate::net::enc(&redirect));
    let redirect2 = redirect.clone();
    let code = super::login_window(app, LABEL, &t("Bei Epic Games anmelden"), &url, move |u, w| {
        let redirect = redirect2.clone();
        async move {
            if !u.contains("/id/api/redirect") {
                return None;
            }
            // Die Seite zeigt JSON mit dem Code – mit den Cookies des Fensters selbst abrufen
            let cookie = super::cookie_header(&w, "https://www.epicgames.com/id/api/redirect")?;
            let j = get_json(crate::net::client().get(&redirect).header("cookie", cookie).header("accept", "application/json")).await.ok()?;
            j["authorizationCode"].as_str().filter(|c| !c.is_empty()).map(String::from)
        }
    })
    .await;
    let Some(code) = code else { return json!({ "ok": false, "error": t("Anmeldung abgebrochen") }) };
    match token(&[("grant_type", "authorization_code"), ("code", &code)]).await {
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
        s.sender = None;
        s.presence.clear();
    }
    crate::secrets::set(SECRET, Value::Null);
    super::clear_login_data(LABEL);
    STORE.set(json!({ "status": "disconnected", "needsLogin": true, "friends": [], "error": null }));
}

async fn load_friends() -> anyhow::Result<()> {
    let a = ensure_token().await?;
    let bearer = format!("bearer {}", a.access_token);
    let sum = get_json(crate::net::client().get(format!("{FRIENDS}/{}/summary", a.account_id)).header("authorization", &bearer)).await?;
    let ids: Vec<String> = {
        let mut s = ST.lock();
        let mut ids = vec![];
        for f in sum["friends"].as_array().cloned().unwrap_or_default() {
            let Some(id) = f["accountId"].as_str() else { continue };
            if let Some(al) = f["alias"].as_str().filter(|x| !x.is_empty()) {
                s.names.insert(id.into(), al.into());
            }
            ids.push(id.to_string());
        }
        s.friend_ids = ids.clone();
        ids
    };
    let missing: Vec<String> = { let s = ST.lock(); ids.into_iter().filter(|id| !s.names.contains_key(id)).collect() };
    for chunk in missing.chunks(100) {
        let qs = chunk.iter().map(|id| format!("accountId={}", crate::net::enc(id))).collect::<Vec<_>>().join("&");
        let list = get_json(crate::net::client().get(format!("{ACCOUNTS}?{qs}")).header("authorization", &bearer)).await.unwrap_or(json!([]));
        let mut s = ST.lock();
        for acc in list.as_array().cloned().unwrap_or_default() {
            let Some(id) = acc["id"].as_str() else { continue };
            let ext = acc["externalAuths"].as_object().and_then(|o| o.values().find_map(|x| x["externalDisplayName"].as_str().map(String::from)));
            let name = acc["displayName"].as_str().map(String::from).or(ext).unwrap_or_else(|| id.to_string());
            s.names.insert(id.into(), name);
        }
    }
    Ok(())
}

fn parse_status(raw: &str) -> Value {
    let u = unescape_xml(raw);
    serde_json::from_str::<Value>(&u).ok().filter(|v| v.is_object()).unwrap_or_else(|| json!({ "Status": u }))
}

fn app_label(app: &str) -> Option<String> {
    match app {
        "Fortnite" => Some("Fortnite".into()),
        "launcher" => None,
        "RocketLeague" => Some("Rocket League".into()),
        "FallGuys" => Some("Fall Guys".into()),
        x => Some(x.into()),
    }
}

fn build_list(s: &S) -> Vec<Value> {
    let launcher = crate::re!(r"(?i)launcher");
    s.friend_ids
        .iter()
        .map(|id| {
            // Bester Status über alle Geräte/Apps (Spiel > online > abwesend)
            let mut best: Option<(i32, &Pres, String)> = None;
            if let Some(res) = s.presence.get(id) {
                for (resource, p) in res {
                    let app = resource.split(':').nth(1).unwrap_or("").to_string();
                    let playing = p.status.as_ref().is_some_and(|st| st["bIsPlaying"] == true);
                    let sc = (if playing { 4 } else { 0 }) + (if p.show.is_some() { 1 } else { 2 }) + (if launcher.is_match(&app) { 0 } else { 1 });
                    if best.as_ref().map_or(true, |b| sc > b.0) {
                        best = Some((sc, p, app));
                    }
                }
            }
            let (state, game, rich) = match &best {
                None => ("offline", None, None),
                Some((_, p, app)) => {
                    let state = match p.show.as_deref() {
                        Some("away") | Some("xa") => "away",
                        Some("dnd") => "busy",
                        _ => "online",
                    };
                    let name = app_label(app);
                    let playing = p.status.as_ref().is_some_and(|st| st["bIsPlaying"] == true);
                    let game = if playing || (name.is_some() && !launcher.is_match(app)) { name } else { None };
                    let rich = p.status.as_ref().and_then(|st| st["Status"].as_str()).filter(|x| !x.is_empty()).map(String::from);
                    (state, game, rich)
                }
            };
            json!({ "id": id, "name": s.names.get(id).cloned().unwrap_or_else(|| id.clone()), "avatar": null, "state": state, "gameName": game, "richText": rich, "lastOnline": null })
        })
        .collect()
}

fn publish() {
    let list = build_list(&ST.lock());
    STORE.set(json!({ "status": "connected", "needsLogin": false, "error": null, "friends": list }));
}

fn schedule_publish() {
    let my = PUBLISH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if PUBLISH_GEN.load(Ordering::SeqCst) == my {
            publish();
        }
    });
}

// ---------- XMPP ----------

fn attr(head: &str, name: &str) -> Option<String> {
    let re = match name {
        "from" => crate::re!(r#"from=["']([^"']+)["']"#),
        "type" => crate::re!(r#"type=["']([^"']+)["']"#),
        "id" => crate::re!(r#"id=["']([^"']+)["']"#),
        _ => return None,
    };
    re.captures(head).map(|c| c[1].to_string())
}

/// Eingehende Chatnachricht -> (from, text)
pub fn parse_message(xml: &str) -> Option<(String, String)> {
    let head = crate::re!(r"^<message\b[^>]*>").find(xml)?.as_str().to_string();
    if !crate::re!(r#"type=["']chat["']"#).is_match(&head) {
        return None;
    }
    let from = crate::re!(r#"from=["']([^"'@]+)@"#).captures(&head)?[1].to_string();
    let body = crate::re!(r"(?s)<body>(.*?)</body>").captures(xml)?[1].to_string();
    Some((from, unescape_xml(&body)))
}

/// <presence …/> und <presence …>…</presence> aus einer Nachricht lösen
pub fn split_presences(msg: &str) -> Vec<String> {
    let re = crate::re!(r"<presence\b[^>]*?(/?)>");
    let mut out = vec![];
    let mut pos = 0;
    while let Some(c) = re.captures_at(msg, pos) {
        let m = c.get(0).unwrap();
        if &c[1] == "/" {
            out.push(m.as_str().to_string());
            pos = m.end();
            continue;
        }
        match msg[m.end()..].find("</presence>") {
            None => {
                out.push(m.as_str().to_string());
                pos = m.end();
            }
            Some(e) => {
                let end = m.end() + e + 11;
                out.push(msg[m.start()..end].to_string());
                pos = end;
            }
        }
    }
    out
}

fn handle_presence(s: &mut S, xml: &str) -> bool {
    let head = crate::re!(r"^<presence\b[^>]*>").find(xml).map(|m| m.as_str()).unwrap_or(xml).to_string();
    let Some(from) = attr(&head, "from") else { return false };
    let (bare, resource) = from.split_once('/').unwrap_or((&from, ""));
    let id = bare.split('@').next().unwrap_or("").to_string();
    if id.is_empty() || Some(&id) == s.auth.as_ref().map(|a| &a.account_id) {
        return false;
    }
    let ty = attr(&head, "type");
    let map = s.presence.entry(id).or_default();
    if ty.as_deref() == Some("unavailable") {
        map.remove(resource);
    } else {
        let show = crate::re!(r"<show>([^<]*)</show>").captures(xml).map(|c| c[1].to_string());
        let status = crate::re!(r"(?s)<status>(.*?)</status>").captures(xml).map(|c| parse_status(&c[1]));
        map.insert(resource.to_string(), Pres { show, status });
    }
    true
}

fn receive(xml: &str) {
    let Some((from, text)) = parse_message(xml) else { return };
    if Some(&from) == ST.lock().auth.as_ref().map(|a| &a.account_id) {
        return;
    }
    let ev = json!({ "type": "message", "steamid": format!("epic:{from}"), "fromMe": false, "text": text, "ts": now() });
    super::chatlog::add(&format!("epic:{from}"), &ev);
    if let Some(app) = super::app() {
        crate::on_chat_event(app, ev);
    }
}

async fn run_xmpp(my: u64, a: Auth) -> anyhow::Result<()> {
    use base64::Engine;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
    let mut req = XMPP_URL.into_client_request()?;
    req.headers_mut().insert("Sec-WebSocket-Protocol", "xmpp".parse()?);
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let open = format!(r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="{XMPP_DOMAIN}" version="1.0"/>"#);
    tx.send(open.clone())?;
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(s) = rx.recv().await {
            if write.send(Message::Text(s)).await.is_err() {
                break;
            }
        }
    });
    let mut step = "open";
    let mut ping = tokio::time::interval(Duration::from_secs(45));
    ping.tick().await;
    let result = loop {
        let msg = tokio::select! {
            m = read.next() => m,
            _ = ping.tick() => {
                if step == "ready" {
                    let _ = tx.send(format!(r#"<iq type="get" id="ping{}"><ping xmlns="urn:xmpp:ping"/></iq>"#, now()));
                    publish();
                }
                continue;
            }
        };
        if GEN.load(Ordering::SeqCst) != my {
            break Ok(());
        }
        let msg = match msg {
            Some(Ok(Message::Text(s))) => s,
            Some(Ok(Message::Close(_))) | None => break Ok(()),
            Some(Ok(_)) => continue,
            Some(Err(e)) => break Err(e.into()),
        };
        if step == "open" && msg.contains("<mechanisms") {
            let plain = base64::engine::general_purpose::STANDARD.encode(format!("\u{0}{}\u{0}{}", a.account_id, a.access_token));
            let _ = tx.send(format!(r#"<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">{plain}</auth>"#));
            step = "auth";
        } else if step == "auth" && msg.contains("<success") {
            step = "bind";
            let _ = tx.send(open.clone());
        } else if step == "auth" && msg.contains("<failure") {
            STORE.set(json!({ "error": t("Epic-Chat: Anmeldung abgelehnt – Status nicht verfügbar.") }));
            // nicht automatisch neu verbinden
            GEN.fetch_add(0, Ordering::SeqCst);
            break Err(anyhow::anyhow!("sasl failure"));
        } else if step == "bind" && msg.contains("<bind") && !msg.contains("<jid>") {
            let resource = format!("V2:launcher:WIN::Ludora{}", hex::encode_upper(rand::random::<[u8; 8]>()));
            let _ = tx.send(format!(r#"<iq type="set" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>{}</resource></bind></iq>"#, escape_xml(&resource)));
        } else if step == "bind" && msg.contains("<jid>") {
            step = "ready";
            let _ = tx.send(r#"<iq type="set" id="sess1"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>"#.into());
            let status = escape_xml(&json!({ "Status": "", "bIsPlaying": false, "bIsJoinable": false, "bHasVoiceSupport": false, "SessionId": "", "Properties": {} }).to_string());
            let _ = tx.send(format!("<presence><show>away</show><status>{status}</status></presence>"));
            ST.lock().sender = Some(tx.clone());
        } else if step == "ready" {
            let ping_re = crate::re!(r#"<iq[^>]*type=["']get["'][^>]*>\s*<ping[^>]*/>\s*</iq>"#);
            for p in ping_re.find_iter(&msg) {
                let id = attr(p.as_str(), "id");
                let from = attr(p.as_str(), "from");
                let _ = tx.send(format!(
                    r#"<iq type="result"{}{}/>"#,
                    id.map(|i| format!(r#" id="{}""#, escape_xml(&i))).unwrap_or_default(),
                    from.map(|f| format!(r#" to="{}""#, escape_xml(&f))).unwrap_or_default()
                ));
            }
            for m in crate::re!(r"(?s)<message\b.*?</message>").find_iter(&msg) {
                receive(m.as_str());
            }
            let mut changed = false;
            {
                let mut s = ST.lock();
                for p in split_presences(&msg) {
                    changed = handle_presence(&mut s, &p) || changed;
                }
            }
            if changed {
                schedule_publish();
            }
        }
    };
    writer.abort();
    ST.lock().sender = None;
    result
}

fn start_xmpp(my: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            if GEN.load(Ordering::SeqCst) != my {
                return;
            }
            let Ok(a) = ensure_token().await else {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            };
            let res = run_xmpp(my, a).await;
            if GEN.load(Ordering::SeqCst) != my {
                return;
            }
            if let Err(e) = &res {
                if e.to_string() == "sasl failure" {
                    return;
                }
            }
            {
                let mut s = ST.lock();
                s.sender = None;
                s.presence.clear(); // nach dem Neuverbinden schickt Epic die aktuellen Status neu
            }
            schedule_publish();
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn refresh_once(my: u64) {
    let res = load_friends().await;
    if GEN.load(Ordering::SeqCst) != my {
        return;
    }
    match res {
        Ok(()) => publish(),
        Err(e) => {
            let msg = e.to_string();
            if status_of(&e) == 401 || crate::re!(r"(?i)Nicht angemeldet|Not signed in|invalid_grant|refresh").is_match(&msg) {
                STORE.set(json!({ "status": "disconnected", "needsLogin": true, "error": t("Epic-Anmeldung abgelaufen – bitte neu anmelden.") }));
                return;
            }
            STORE.set(json!({ "status": "error", "error": format!("Epic: {msg}") }));
        }
    }
}

fn start() {
    let my = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    STORE.set(json!({ "status": "connecting", "needsLogin": false, "error": null }));
    tauri::async_runtime::spawn(async move {
        let mut retries = 0u32;
        loop {
            match ensure_token().await {
                Ok(_) => break,
                Err(e) => {
                    if GEN.load(Ordering::SeqCst) != my {
                        return;
                    }
                    if super::is_transient(&e.to_string()) && status_of(&e) == 0 || status_of(&e) >= 500 {
                        STORE.set(json!({ "status": "connecting", "error": t("Epic nicht erreichbar – neuer Versuch läuft …") }));
                        tokio::time::sleep(Duration::from_millis((10_000u64 * 2u64.pow(retries)).min(300_000))).await;
                        retries += 1;
                        if GEN.load(Ordering::SeqCst) != my {
                            return;
                        }
                        continue;
                    }
                    STORE.set(json!({ "status": "disconnected", "needsLogin": true, "error": t("Epic-Anmeldung abgelaufen – bitte neu anmelden.") }));
                    let _ = crate::vault::sync().await;
                    return;
                }
            }
        }
        start_xmpp(my);
        loop {
            refresh_once(my).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
            if GEN.load(Ordering::SeqCst) != my || ST.lock().auth.is_none() {
                return;
            }
        }
    });
}

fn load_saved() -> Option<Auth> {
    let s = crate::secrets::get(SECRET)?;
    let rt = s["refresh_token"].as_str().filter(|x| !x.is_empty())?;
    Some(Auth { refresh_token: rt.into(), account_id: s["account_id"].as_str().unwrap_or("").into(), ..Default::default() })
}

pub fn init() {
    if let Some(a) = load_saved() {
        ST.lock().auth = Some(a);
        start();
    }
}

pub fn restore() {
    let Some(a) = load_saved() else { return };
    if ST.lock().auth.as_ref().is_some_and(|x| x.refresh_token == a.refresh_token) {
        return;
    }
    ST.lock().auth = Some(a);
    start();
}

pub fn refresh() {
    if ST.lock().auth.is_none() {
        return;
    }
    let my = GEN.load(Ordering::SeqCst);
    if STORE.status() == "disconnected" {
        start();
    } else {
        tauri::async_runtime::spawn(refresh_once(my));
    }
}

pub async fn link_proof() -> Option<Value> {
    ST.lock().auth.as_ref()?;
    let a = ensure_token().await.ok()?;
    Some(json!({ "token": a.access_token, "accountId": a.account_id }))
}

// ---------- Chat ----------

pub fn history(id: &str) -> Vec<Value> {
    super::chatlog::list(&format!("epic:{id}"))
}

pub fn send(id: &str, text: &str) -> anyhow::Result<()> {
    let Some(tx) = ST.lock().sender.clone() else {
        anyhow::bail!(t("Epic-Chat ist gerade nicht verbunden – kurz warten und erneut senden."));
    };
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!(t("Epic-Freund nicht gefunden."));
    }
    let body: String = text.chars().take(2000).collect();
    tx.send(format!(r#"<message to="{id}@{XMPP_DOMAIN}" type="chat" id="ludora{}"><body>{}</body></message>"#, now(), escape_xml(&body)))?;
    let ev = json!({ "type": "message", "steamid": format!("epic:{id}"), "fromMe": true, "text": body, "ts": now() });
    super::chatlog::add(&format!("epic:{id}"), &ev);
    if let Some(app) = super::app() {
        crate::on_chat_event(app, ev);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presences_and_messages() {
        let msg = r#"<presence from="abc@prod.ol.epicgames.com/V2:Fortnite:WIN::X"><show>away</show><status>{&quot;Status&quot;:&quot;Lobby&quot;,&quot;bIsPlaying&quot;:true}</status><delay/></presence><presence from="def@x/y" type="unavailable"/>"#;
        let parts = split_presences(msg);
        assert_eq!(parts.len(), 2);
        let mut s = S::default();
        s.friend_ids = vec!["abc".into()];
        assert!(handle_presence(&mut s, &parts[0]));
        let l = build_list(&s);
        assert_eq!(l[0]["state"], "away");
        assert_eq!(l[0]["gameName"], "Fortnite");
        assert_eq!(l[0]["richText"], "Lobby");
        let m = parse_message(r#"<message from="abc@prod/x" type="chat"><body>hi &amp; du</body></message>"#).unwrap();
        assert_eq!(m, ("abc".to_string(), "hi & du".to_string()));
    }
}
