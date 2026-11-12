//! Steam-Konto in Ludora:
//! QR-Anmeldung (IAuthenticationService), Zugriffs-Token über die Web-Cookies, Freundesliste,
//! Chat über IFriendMessagesService, Stream-Geräte und Update-Fernsteuerung (IClientCommService).

use base64::{engine::general_purpose::STANDARD as B64, engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;

use crate::protobuf as pb;
use crate::util::*;

const API: &str = "https://api.steampowered.com";
pub const STEAMID_BASE: u64 = 76561197960265728;
const TOKEN_KEY: &str = "steamWebToken";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

static APP: OnceCell<AppHandle> = OnceCell::new();

#[derive(Default)]
struct Inner {
    gen: u64,
    refresh: Option<String>,
    access: Option<String>,
    access_exp: i64,
    cookie_header: Option<(String, i64)>,
    state: Value,
    unread: HashMap<String, u64>,
    last_msg: HashMap<String, i64>,
    watched: HashMap<String, u32>,
    game_names: HashMap<String, String>,
    fast: bool,
    retries: u32,
    messages_checked: bool,
}

static S: Lazy<Mutex<Inner>> = Lazy::new(|| {
    Mutex::new(Inner { state: json!({ "status": "disconnected", "error": null, "qr": null, "me": null, "friends": [] }), ..Default::default() })
});

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn emit(patch: Value) {
    let st = {
        let mut s = S.lock();
        for (k, v) in patch.as_object().unwrap() {
            s.state[k] = v.clone();
        }
        if patch.get("friends").is_some() {
            s.state["updatedAt"] = json!(now_ms());
        }
        s.state.clone()
    };
    if let Some(app) = APP.get() {
        crate::broadcast(app, "friends:update", st);
    }
}

fn emit_chat(ev: Value) {
    if let Some(app) = APP.get() {
        crate::on_chat_event(app, ev);
    }
}

pub fn get_state() -> Value {
    S.lock().state.clone()
}

pub fn status() -> String {
    S.lock().state["status"].as_str().unwrap_or("").to_string()
}

pub fn is_connected() -> bool {
    status() == "connected"
}

fn load_token() -> Option<String> {
    crate::secrets::get(TOKEN_KEY).and_then(|v| v.as_str().map(String::from))
}

fn save_token(t: Option<&str>) {
    crate::secrets::set(TOKEN_KEY, t.map(|x| json!(x)).unwrap_or(Value::Null));
}

/// Inhalt eines JWT (ohne Prüfung – nur für SteamID und Ablauf)
pub fn jwt_payload(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|p| B64URL.decode(p.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({}))
}

pub fn to_steam_id(account: u64) -> String {
    (STEAMID_BASE + account).to_string()
}

pub fn to_account_id(steamid: &str) -> String {
    steamid.parse::<u64>().map(|x| x.saturating_sub(STEAMID_BASE).to_string()).unwrap_or_default()
}

// ---------- Web-API ----------

/// Protobuf-Anfrage an IAuthenticationService (wie steam-session)
async fn auth_call(method: &str, body: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    let form = reqwest::multipart::Form::new().text("input_protobuf_encoded", B64.encode(body));
    let res = crate::net::client()
        .post(format!("{API}/IAuthenticationService/{method}/v1/"))
        .header("user-agent", UA)
        .header("origin", "https://steamcommunity.com")
        .header("referer", "https://steamcommunity.com")
        .multipart(form)
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    let er = res.headers().get("x-eresult").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i32>().ok()).unwrap_or(1);
    if !res.status().is_success() {
        anyhow::bail!("Steam {}", res.status().as_u16());
    }
    if er != 1 {
        anyhow::bail!(t_args("Steam-Fehler {0}", &[&er.to_string()]));
    }
    Ok(res.bytes().await?.to_vec())
}

/// Web-Cookies holen (wie die Anmeldung im Browser): steamLoginSecure enthält das Zugriffs-Token
async fn web_cookies(refresh: &str) -> anyhow::Result<Vec<String>> {
    let steamid = jwt_payload(refresh)["sub"].as_str().unwrap_or("").to_string();
    let session_id = hex::encode((0..12).map(|_| rand::random::<u8>()).collect::<Vec<_>>());
    let form = reqwest::multipart::Form::new()
        .text("nonce", refresh.to_string())
        .text("sessionid", session_id.clone())
        .text("redir", "https://steamcommunity.com/login/home/?goto=");
    let res = crate::net::client()
        .post("https://login.steampowered.com/jwt/finalizelogin")
        .header("origin", "https://steamcommunity.com")
        .header("referer", "https://steamcommunity.com/")
        .header("user-agent", UA)
        .multipart(form)
        .send()
        .await?;
    let j: Value = res.json().await?;
    if let Some(e) = j["error"].as_i64() {
        anyhow::bail!("{}", if e == 15 { "AccessDenied".to_string() } else { format!("EResult {e}") });
    }
    let transfers = j["transfer_info"].as_array().cloned().ok_or_else(|| anyhow::anyhow!("Malformed login response"))?;
    let mut cookies = vec![];
    for tr in transfers {
        let Some(url) = tr["url"].as_str() else { continue };
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let mut form = reqwest::multipart::Form::new().text("steamID", steamid.clone());
        if let Some(p) = tr["params"].as_object() {
            for (k, v) in p {
                form = form.text(k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()));
            }
        }
        let Ok(r) = crate::net::client().post(url).header("user-agent", UA).multipart(form).send().await else { continue };
        for c in r.headers().get_all("set-cookie") {
            if let Ok(s) = c.to_str() {
                let mut s = s.to_string();
                if !s.to_lowercase().contains("domain=") {
                    s.push_str(&format!("; Domain={host}"));
                }
                cookies.push(s);
            }
        }
    }
    if !cookies.iter().any(|c| c.starts_with("steamLoginSecure=")) {
        anyhow::bail!("AccessDenied");
    }
    Ok(cookies)
}

/// Aus Set-Cookie-Zeilen: Zugriffs-Token (Store bevorzugt) + Cookie-Kopf für steamcommunity.com
pub fn cookie_tokens(cookies: &[String]) -> (Option<String>, String) {
    let (mut store, mut community, mut other) = (None, None, None);
    let mut jar: Vec<(String, String)> = vec![];
    for c in cookies {
        let mut parts = c.split(';');
        let pair = parts.next().unwrap_or("");
        let Some(i) = pair.find('=').filter(|i| *i > 0) else { continue };
        let name = pair[..i].trim().to_string();
        let value = pair[i + 1..].trim().to_string();
        let domain = parts.map(|a| a.trim()).find(|a| a.to_lowercase().starts_with("domain=")).unwrap_or("").to_lowercase();
        let is_community = domain.is_empty() || domain.contains("steamcommunity.com");
        if name == "steamLoginSecure" {
            let decoded = crate::covers::urlencoding_decode(&value);
            if let Some(tok) = decoded.split("||").nth(1).filter(|t| !t.is_empty()).map(String::from) {
                if domain.contains("store.steampowered.com") {
                    store = Some(tok);
                } else if is_community {
                    community = Some(tok);
                } else if other.is_none() {
                    other = Some(tok);
                }
            }
        }
        if is_community {
            jar.retain(|(k, _)| *k != name);
            jar.push((name, value));
        }
    }
    if !jar.iter().any(|(k, _)| k == "sessionid") {
        jar.push(("sessionid".into(), hex::encode((0..12).map(|_| rand::random::<u8>()).collect::<Vec<_>>())));
    }
    (store.or(community).or(other), jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; "))
}

/// Gespeichertes Token einer anderen Ludora-Instanz übernehmen
fn adopt_stored() {
    if let Some(stored) = load_token() {
        let mut s = S.lock();
        if s.refresh.as_deref() != Some(&stored) {
            s.refresh = Some(stored);
            s.access = None;
            s.access_exp = 0;
            s.cookie_header = None;
        }
    }
}

/// Gültiges Zugriffs-Token (über die Web-Cookies erneuert)
async fn ensure_access() -> anyhow::Result<String> {
    {
        let s = S.lock();
        if let Some(a) = &s.access {
            if s.access_exp - 300 > now_ms() / 1000 {
                return Ok(a.clone());
            }
        }
    }
    adopt_stored();
    let refresh = S.lock().refresh.clone().ok_or_else(|| anyhow::anyhow!(t("Nicht mit Steam verbunden")))?;
    let cookies = web_cookies(&refresh).await?;
    let (access, header) = cookie_tokens(&cookies);
    let access = access.ok_or_else(|| anyhow::anyhow!(t("Steam hat kein Zugriffs-Token geliefert")))?;
    let exp = jwt_payload(&access)["exp"].as_i64().unwrap_or(now_ms() / 1000 + 3600);
    let mut s = S.lock();
    s.access = Some(access.clone());
    s.access_exp = exp;
    s.cookie_header = Some((header, now_ms()));
    Ok(access)
}

/// Cookie-Kopf für steamcommunity.com (für den Web-Chat-Token)
pub async fn community_cookie() -> anyhow::Result<String> {
    ensure_access().await?;
    S.lock().cookie_header.as_ref().map(|c| c.0.clone()).ok_or_else(|| anyhow::anyhow!(t("Nicht mit Steam verbunden")))
}

/// JSON lesen, große Ganzzahlen (64-Bit-IDs) als Text behalten
pub fn parse_json_big(text: &str) -> Value {
    let re = crate::re!(r"([:\[,]\s*)(-?\d{16,})(\s*[,\]}])");
    // zweimal, weil sich Treffer überlappen können ("[1234…,5678…]")
    let a = re.replace_all(text, "$1\"$2\"$3").into_owned();
    let b = re.replace_all(&a, "$1\"$2\"$3").into_owned();
    serde_json::from_str(&b).unwrap_or(json!({}))
}

/// Web-API-Methode (access_token); Antwort = "response"
pub async fn call(iface: &str, method: &str, params: &[(&str, String)], post: bool, timeout_ms: u64) -> anyhow::Result<Value> {
    let token = ensure_access().await?;
    let mut q: Vec<(String, String)> = vec![("access_token".into(), token)];
    q.extend(params.iter().map(|(k, v)| (k.to_string(), v.clone())));
    let url = format!("{API}/{iface}/{method}/v1/");
    let req = if post {
        crate::net::client().post(&url).header("content-type", "application/x-www-form-urlencoded").body(crate::net::form(&q.iter().map(|(k, v)| (k.as_str(), v.clone())).collect::<Vec<_>>()))
    } else {
        crate::net::client().get(&url).query(&q)
    };
    let res = req.timeout(Duration::from_millis(timeout_ms)).send().await.map_err(|e| {
        if e.is_timeout() { anyhow::anyhow!(t_args("Steam antwortet nicht ({0})", &[method])) } else { anyhow::anyhow!(e) }
    })?;
    let st = res.status().as_u16();
    if st == 401 || st == 403 {
        S.lock().access_exp = 0;
        anyhow::bail!(t_args("Steam lehnt die Anfrage ab ({0})", &[&st.to_string()]));
    }
    if !res.status().is_success() {
        anyhow::bail!(t_args("Steam antwortet mit {0}", &[&st.to_string()]));
    }
    let er = res.headers().get("x-eresult").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i32>().ok()).unwrap_or(1);
    if er != 1 {
        anyhow::bail!(t_args("Steam-Fehler {0}", &[&er.to_string()]));
    }
    let v = parse_json_big(&res.text().await.unwrap_or_default());
    Ok(v["response"].clone())
}

// ---------- Anmeldung ----------

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    if let Some(t) = load_token() {
        tauri::async_runtime::spawn(connect(t, None));
    }
}

/// Anmeldung kam über das Ludora-Konto von einem anderen Gerät
pub fn restore() {
    if let Some(t) = load_token() {
        if S.lock().refresh.as_deref() != Some(&t) {
            S.lock().retries = 0;
            tauri::async_runtime::spawn(connect(t, None));
        }
    }
}

fn qr_svg_data_url(text: &str) -> String {
    let code = qrcode::QrCode::new(text.as_bytes()).expect("QR");
    let svg = code.render::<qrcode::render::svg::Color>().min_dimensions(260, 260).dark_color(qrcode::render::svg::Color("#0f1115")).light_color(qrcode::render::svg::Color("#ffffff")).build();
    format!("data:image/svg+xml;base64,{}", B64.encode(svg))
}

/// QR-Code anfordern und im Hintergrund auf die Bestätigung in der Steam-App warten
pub async fn start_qr() -> Value {
    let my = {
        let mut s = S.lock();
        s.gen += 1;
        s.gen
    };
    let mut dev = pb::Writer::default();
    dev.string(1, UA).uint(2, 2); // WebBrowser
    let mut req = pb::Writer::default();
    req.string(1, UA).uint(2, 2).bytes(3, &dev.buf).string(4, "Community");
    let res = match auth_call("BeginAuthSessionViaQR", req.buf).await {
        Ok(r) => r,
        Err(e) => {
            emit(json!({ "status": "disconnected", "qr": null, "error": e.to_string() }));
            return get_state();
        }
    };
    let Some(m) = pb::decode(&res) else {
        emit(json!({ "status": "disconnected", "qr": null, "error": "QR" }));
        return get_state();
    };
    let mut client_id = pb::int(&m, 1).unwrap_or(0);
    let url = pb::string(&m, 2).unwrap_or_default();
    let request_id = pb::bytes(&m, 3).map(|b| b.to_vec()).unwrap_or_default();
    let interval = m.iter().find(|f| f.field == 4 && f.wire == 5).map(|f| f32::from_le_bytes(f.bytes.try_into().unwrap_or([0; 4]))).unwrap_or(5.0).max(1.0);
    emit(json!({ "status": "qr", "qr": qr_svg_data_url(&url), "error": null, "friends": [], "me": null }));

    tauri::async_runtime::spawn(async move {
        let end = std::time::Instant::now() + Duration::from_secs(180);
        while std::time::Instant::now() < end {
            tokio::time::sleep(Duration::from_secs_f32(interval)).await;
            if S.lock().gen != my {
                return;
            }
            let mut p = pb::Writer::default();
            p.uint(1, client_id).bytes(2, &request_id);
            let Ok(r) = auth_call("PollAuthSessionStatus", p.buf).await else { continue };
            let Some(m) = pb::decode(&r) else { continue };
            if let Some(n) = pb::int(&m, 1).filter(|x| *x != 0) {
                client_id = n;
                if let Some(u) = pb::string(&m, 2) {
                    emit(json!({ "qr": qr_svg_data_url(&u) }));
                }
            }
            if pb::int(&m, 5) == Some(1) && status() == "qr" {
                emit(json!({ "status": "qr-scanned" }));
            }
            if let Some(refresh) = pb::string(&m, 3).filter(|s| !s.is_empty()) {
                let access = pb::string(&m, 4).filter(|s| !s.is_empty());
                save_token(Some(&refresh));
                emit(json!({ "qr": null }));
                connect(refresh, access).await;
                return;
            }
        }
        if S.lock().gen == my {
            emit(json!({ "status": "disconnected", "qr": null, "error": t("QR-Code abgelaufen – bitte neu anfordern.") }));
        }
    });
    get_state()
}

fn is_transient(e: &str) -> bool {
    let l = e.to_lowercase();
    ["timeout", "timed out", "connect", "dns", "network", "nicht erreichbar", "antwortet nicht", "502", "503", "504"].iter().any(|x| l.contains(x))
}

pub fn connect(token: String, first_access: Option<String>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(connect_inner(token, first_access))
}

async fn connect_inner(token: String, first_access: Option<String>) {
    let my = {
        let mut s = S.lock();
        s.gen += 1;
        s.refresh = Some(token.clone());
        s.cookie_header = None;
        s.access_exp = first_access.as_deref().and_then(|a| jwt_payload(a)["exp"].as_i64()).unwrap_or(0);
        s.access = first_access;
        s.gen
    };
    let steamid = jwt_payload(&token)["sub"].as_str().unwrap_or("").to_string();
    let me = if steamid.is_empty() { Value::Null } else { json!({ "steamid": steamid }) };
    emit(json!({ "status": "connecting", "error": null, "me": me }));
    match ensure_access().await {
        Ok(_) => {
            if S.lock().gen != my {
                return;
            }
            S.lock().retries = 0;
            emit(json!({ "status": "connected", "error": null, "me": { "steamid": steamid } }));
            schedule_poll(my, 100);
            // Live-Chat (Nachrichten sofort, "schreibt gerade …") über die CM-Verbindung
            crate::steamcm::keep_alive(my, || S.lock().gen);
            // Steam-Konto mit dem Ludora-Konto verknüpfen (wie bei Riot/Epic/GOG direkt nach der Anmeldung)
            crate::hub::auto_link("steam");
        }
        Err(e) => {
            if S.lock().gen != my {
                return;
            }
            if let Some(stored) = load_token().filter(|s| *s != token) {
                S.lock().retries = 0;
                connect(stored, None).await;
                return;
            }
            let msg = e.to_string();
            let rejected = crate::re!(r"(?i)AccessDenied|Expired|Revoked|InvalidSignature|InvalidPassword").is_match(&msg);
            let retries = S.lock().retries;
            if !rejected && (is_transient(&msg) || retries < 6) {
                emit(json!({ "status": "connecting", "error": t("Steam nicht erreichbar – neuer Versuch läuft …") }));
                S.lock().retries += 1;
                let wait = (10_000u64 * 2u64.pow(retries)).min(300_000);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    if S.lock().gen == my {
                        connect(token, None).await;
                    }
                });
                return;
            }
            emit(json!({ "status": "disconnected", "error": t_args("Steam-Anmeldung abgelaufen – bitte neu per QR-Code anmelden. ({0})", &[&msg]) }));
        }
    }
}

pub fn logout() {
    tauri::async_runtime::spawn(crate::steamcm::stop());
    {
        let mut s = S.lock();
        s.gen += 1;
        s.refresh = None;
        s.access = None;
        s.cookie_header = None;
        s.unread.clear();
        s.last_msg.clear();
    }
    save_token(None);
    emit(json!({ "status": "disconnected", "me": null, "friends": [], "qr": null, "error": null }));
}

pub fn set_fast(on: bool) {
    S.lock().fast = on;
    if on && is_connected() {
        let g = S.lock().gen;
        schedule_poll(g, 200);
    }
}

// ---------- Freundesliste ----------

fn avatar_url(digest: &Value) -> Value {
    let Some(d) = digest.as_str().filter(|d| !d.is_empty()) else { return Value::Null };
    let hex = if d.len() == 40 && d.chars().all(|c| c.is_ascii_hexdigit()) { d.to_string() } else { B64.decode(d).map(hex::encode).unwrap_or_default() };
    if hex.is_empty() || hex.chars().all(|c| c == '0') {
        return json!("https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg");
    }
    json!(format!("https://avatars.steamstatic.com/{hex}_medium.jpg"))
}

fn state_name(n: u64) -> &'static str {
    match n {
        1 | 5 | 6 => "online",
        2 => "busy",
        3 => "away",
        4 => "snooze",
        _ => "offline",
    }
}

fn sv(v: &Value) -> String {
    v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() })
}

async fn resolve_game_names(appids: &[String]) {
    let missing: Vec<String> = {
        let s = S.lock();
        let mut m: Vec<String> = appids.iter().filter(|a| !a.is_empty() && !s.game_names.contains_key(*a)).cloned().collect();
        m.sort();
        m.dedup();
        m
    };
    if missing.is_empty() {
        return;
    }
    let input = json!({
        "ids": missing.iter().filter_map(|a| a.parse::<u64>().ok()).map(|a| json!({ "appid": a })).collect::<Vec<_>>(),
        "context": { "language": "german", "country_code": "DE", "steam_realm": 1 },
    });
    let Ok(r) = crate::net::client().get(format!("{API}/IStoreBrowseService/GetItems/v1/?input_json={}", crate::net::enc(&input.to_string()))).send().await else { return };
    let Ok(d) = r.json::<Value>().await else { return };
    let mut s = S.lock();
    for it in d["response"]["store_items"].as_array().cloned().unwrap_or_default() {
        if let (Some(id), Some(name)) = (it["appid"].as_u64(), it["name"].as_str()) {
            s.game_names.insert(id.to_string(), name.to_string());
        }
    }
}

async fn load_friends() -> anyhow::Result<Vec<Value>> {
    let r = call("IFriendsListService", "GetFriendsList", &[], false, 20_000).await?;
    let ids: Vec<String> = r["friendslist"]["friends"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|f| f["efriendrelationship"].as_u64() == Some(3) || f["efriendrelationship"] == "3")
        .map(|f| sv(&f["ulfriendid"]))
        .collect();
    let mut details: HashMap<String, (Value, Value)> = HashMap::new();
    for chunk in ids.chunks(100) {
        let params: Vec<(String, String)> = chunk.iter().enumerate().map(|(i, id)| (format!("steamids[{i}]"), id.clone())).collect();
        let p: Vec<(&str, String)> = params.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let r = call("IPlayerService", "GetPlayerLinkDetails", &p, false, 20_000).await?;
        for a in r["accounts"].as_array().cloned().unwrap_or_default() {
            let id = sv(&a["public_data"]["steamid"]);
            if !id.is_empty() {
                details.insert(id, (a["public_data"].clone(), a["private_data"].clone()));
            }
        }
    }
    let mut appids = vec![];
    let mut friends: Vec<Value> = ids
        .iter()
        .map(|id| {
            let (pubd, privd) = details.get(id).cloned().unwrap_or((json!({}), json!({})));
            let game_id = Some(sv(&privd["game_id"])).filter(|g| !g.is_empty() && g != "0");
            let appid = game_id.clone().filter(|g| g.parse::<u64>().is_ok_and(|x| x < 0x1000000));
            if let Some(a) = &appid {
                appids.push(a.clone());
            }
            let rp: Vec<(String, String)> = match &privd["rich_presence_kv"] {
                Value::Array(a) => a.iter().map(|x| (sv(&x["key"]), sv(&x["value"]))).collect(),
                Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), sv(v))).collect(),
                _ => vec![],
            };
            let connect = rp.iter().find(|(k, _)| k == "connect").map(|(_, v)| v.clone());
            let lobby = Some(sv(&privd["lobby_steam_id"])).filter(|l| !l.is_empty() && l != "0");
            let last_off = privd["last_seen_online"].as_i64().or(privd["last_logoff_time"].as_i64()).unwrap_or(0);
            let server = privd["game_server_ip_and_port"].as_u64().unwrap_or(0) > 0;
            json!({
                "steamid": id,
                "name": pubd["persona_name"].as_str().unwrap_or(id),
                "avatar": avatar_url(&pubd["sha_digest_avatar"]),
                "state": state_name(privd["persona_state"].as_u64().unwrap_or(0)),
                "appid": appid.clone().or(game_id.clone()),
                "gameName": privd["game_extra_info"],
                "richText": rp.iter().find(|(k, _)| k == "status").map(|(_, v)| v.clone()),
                "lobby": lobby,
                "joinable": game_id.is_some() && (lobby.is_some() || connect.is_some() || server),
                "lastOnline": if last_off > 0 { json!(last_off * 1000) } else { Value::Null },
            })
        })
        .collect();
    resolve_game_names(&appids).await;
    let s = S.lock();
    for f in friends.iter_mut() {
        if f["gameName"].is_null() {
            if let Some(a) = f["appid"].as_str() {
                f["gameName"] = s.game_names.get(a).map(|n| json!(n)).unwrap_or(Value::Null);
            }
        }
        f["unread"] = json!(s.unread.get(f["steamid"].as_str().unwrap_or("")).copied().unwrap_or(0));
    }
    Ok(friends)
}

/// Freundesliste einmal laden und melden
async fn refresh_once(my: u64) {
    if S.lock().gen != my || !is_connected() {
        return;
    }
    match load_friends().await {
        Ok(friends) => {
            check_messages(my).await;
            if S.lock().gen != my {
                return;
            }
            let s = S.lock();
            let friends: Vec<Value> = friends
                .into_iter()
                .map(|mut f| {
                    f["unread"] = json!(s.unread.get(f["steamid"].as_str().unwrap_or("")).copied().unwrap_or(0));
                    f
                })
                .collect();
            drop(s);
            // "live": Status-Änderungen kommen sofort über die Chat-Verbindung (Anzeige in der Freundesliste)
            emit(json!({ "friends": friends, "error": null, "live": crate::steamcm::is_alive() }));
        }
        Err(e) => {
            if S.lock().gen == my {
                emit(json!({ "error": t_args("Freunde konnten nicht geladen werden: {0}", &[&e.to_string()]) }));
            }
        }
    }
}

fn schedule_poll(my: u64, ms: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        if S.lock().gen != my || !is_connected() {
            return;
        }
        refresh_once(my).await;
        let fast = S.lock().fast;
        if S.lock().gen == my && is_connected() {
            schedule_poll(my, if fast { 5000 } else { crate::idle_ms(15000) });
        }
    });
}

static LIVE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Live-Änderung (Status/Spiel eines Freundes kam über die CM-Verbindung): Liste gleich neu laden
pub fn poke_live() {
    use std::sync::atomic::Ordering;
    let n = LIVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let my = S.lock().gen;
    tauri::async_runtime::spawn(async move {
        // Steam schickt Änderungen oft in Schüben – kurz sammeln
        tokio::time::sleep(Duration::from_millis(1500)).await;
        if LIVE_GEN.load(Ordering::SeqCst) == n {
            refresh_once(my).await;
        }
    });
}

/// Eigener Online-Status (0 = offline, 1 = online, 2 = beschäftigt, 3 = abwesend, …, 7 = unsichtbar)
pub async fn my_persona_state() -> Option<u64> {
    let me = S.lock().state["me"]["steamid"].as_str()?.to_string();
    let r = call("IPlayerService", "GetPlayerLinkDetails", &[("steamids[0]", me)], false, 15_000).await.ok()?;
    let p = &r["accounts"][0]["private_data"]["persona_state"];
    p.as_u64().or_else(|| p.as_str().and_then(|x| x.parse().ok()))
}

// ---------- Chat ----------

async fn recent(steamid: &str, count: u32) -> anyhow::Result<Vec<Value>> {
    let me = S.lock().state["me"]["steamid"].as_str().unwrap_or("").to_string();
    let r = call(
        "IFriendMessagesService",
        "GetRecentMessages",
        &[("steamid1", me.clone()), ("steamid2", steamid.to_string()), ("count", count.to_string()), ("most_recent_conversation", "false".into()), ("bbcode_format", "false".into())],
        false,
        20_000,
    )
    .await?;
    let my_acc = to_account_id(&me);
    let mut msgs: Vec<Value> = r["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|m| json!({
            "fromMe": sv(&m["accountid"]) == my_acc,
            "text": m["message"].as_str().unwrap_or(""),
            "ts": m["timestamp"].as_i64().unwrap_or(0) * 1000,
            "ordinal": m["ordinal"].as_i64().unwrap_or(0),
        }))
        .collect();
    msgs.sort_by_key(|m| (m["ts"].as_i64().unwrap_or(0), m["ordinal"].as_i64().unwrap_or(0)));
    Ok(msgs)
}

/// Ungelesene Nachrichten abgleichen und neue als Ereignis melden
async fn check_messages(my: u64) {
    let Ok(r) = call("IFriendMessagesService", "GetActiveMessageSessions", &[("only_sessions_with_messages", "true".into())], false, 20_000).await else { return };
    if S.lock().gen != my {
        return;
    }
    let first = {
        let mut s = S.lock();
        let f = s.last_msg.is_empty() && !s.messages_checked;
        s.messages_checked = true;
        f
    };
    let mut changed = false;
    for sess in r["message_sessions"].as_array().cloned().unwrap_or_default() {
        let acc = sess["accountid_friend"].as_u64().or_else(|| sv(&sess["accountid_friend"]).parse().ok()).unwrap_or(0);
        let id = to_steam_id(acc);
        let last = sess["last_message"].as_i64().unwrap_or(0);
        let n = sess["unread_message_count"].as_u64().unwrap_or(0);
        let (known, watched) = {
            let mut s = S.lock();
            let before = s.unread.get(&id).copied().unwrap_or(0);
            if n > 0 {
                s.unread.insert(id.clone(), n);
            } else {
                s.unread.remove(&id);
            }
            if before != n {
                changed = true;
            }
            let known = s.last_msg.get(&id).copied().unwrap_or(0);
            s.last_msg.insert(id.clone(), known.max(last));
            (known, s.watched.contains_key(&id))
        };
        if !first && last > known && (n > 0 || watched) {
            if let Ok(msgs) = recent(&id, 10).await {
                for m in msgs {
                    if m["ts"].as_i64().unwrap_or(0) / 1000 > known {
                        let mut ev = m.clone();
                        ev["type"] = json!("message");
                        ev["steamid"] = json!(id);
                        emit_chat(ev);
                    }
                }
            }
        }
    }
    if changed {
        apply_unread();
    }
}

/// Live vom Steam-Chat (CM): Nachricht (eigene von anderen Geräten = Echo) oder "schreibt gerade"
pub fn on_cm_message(steamid: String, entry_type: u64, text: String, ts_secs: i64, ordinal: i64, echo: bool) {
    if entry_type == 2 {
        if !echo {
            emit_chat(json!({ "type": "typing", "steamid": steamid }));
        }
        return;
    }
    if entry_type != 1 || text.is_empty() {
        return;
    }
    let ts = if ts_secs > 0 { ts_secs * 1000 } else { now_ms() };
    {
        let mut s = S.lock();
        let k = s.last_msg.get(&steamid).copied().unwrap_or(0);
        s.last_msg.insert(steamid.clone(), k.max(ts / 1000));
        if !echo {
            *s.unread.entry(steamid.clone()).or_insert(0) += 1;
        }
    }
    emit_chat(json!({ "type": "message", "steamid": steamid, "fromMe": echo, "text": text, "ts": ts, "ordinal": ordinal }));
    if !echo {
        apply_unread();
    }
}

fn apply_unread() {
    let friends: Vec<Value> = {
        let s = S.lock();
        s.state["friends"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut f| {
                f["unread"] = json!(s.unread.get(f["steamid"].as_str().unwrap_or("")).copied().unwrap_or(0));
                f
            })
            .collect()
    };
    emit(json!({ "friends": friends }));
}

/// Chatfenster offen/geschlossen – solange offen, alle 4 s nach Nachrichten schauen
pub fn watch(steamid: &str, on: bool) {
    let start = {
        let mut s = S.lock();
        let n = s.watched.get(steamid).copied().unwrap_or(0) as i64 + if on { 1 } else { -1 };
        if n > 0 {
            s.watched.insert(steamid.to_string(), n as u32);
        } else {
            s.watched.remove(steamid);
        }
        on && s.watched.len() == 1 && n == 1
    };
    if start {
        tauri::async_runtime::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(4)).await;
                let (my, any) = {
                    let s = S.lock();
                    (s.gen, !s.watched.is_empty())
                };
                if !any || !is_connected() {
                    return;
                }
                check_messages(my).await;
            }
        });
    }
}

fn require_connected() -> anyhow::Result<()> {
    if !is_connected() {
        anyhow::bail!(t("Nicht mit Steam verbunden"));
    }
    Ok(())
}

pub async fn history(steamid: &str) -> anyhow::Result<Vec<Value>> {
    require_connected()?;
    let msgs = recent(steamid, 60).await?;
    if let Some(last) = msgs.last() {
        let ts = last["ts"].as_i64().unwrap_or(0) / 1000;
        let mut s = S.lock();
        let k = s.last_msg.get(steamid).copied().unwrap_or(0);
        s.last_msg.insert(steamid.to_string(), k.max(ts));
    }
    Ok(msgs)
}

pub async fn send(steamid: &str, text: &str) -> anyhow::Result<Value> {
    require_connected()?;
    let msg: String = text.chars().take(4000).collect();
    if msg.trim().is_empty() {
        return Ok(Value::Null);
    }
    // Senden geht nur über die CM-Verbindung (die Web-API kennt SendMessage nicht -> 404)
    let (server_ts, ordinal) = crate::steamcm::send_message(steamid, &msg)
        .await
        .map_err(|e| anyhow::anyhow!(t_args("Senden fehlgeschlagen ({0}). Notfalls den Chat in Steam öffnen (Symbol oben rechts).", &[&e.to_string()])))?;
    let ts = if server_ts > 0 { server_ts * 1000 } else { now_ms() };
    {
        let mut s = S.lock();
        let k = s.last_msg.get(steamid).copied().unwrap_or(0);
        s.last_msg.insert(steamid.to_string(), k.max(ts / 1000));
    }
    let ev = json!({ "type": "message", "steamid": steamid, "fromMe": true, "text": msg, "ts": ts, "ordinal": ordinal });
    emit_chat(ev.clone());
    Ok(ev)
}

pub fn typing(steamid: &str) {
    if !is_connected() {
        return;
    }
    let id = steamid.to_string();
    tauri::async_runtime::spawn(async move {
        crate::steamcm::typing(&id).await;
    });
}

pub fn mark_read(steamid: &str) {
    if is_connected() {
        let id = steamid.to_string();
        tauri::async_runtime::spawn(async move {
            let ts = (now_ms() / 1000) as u64;
            crate::steamcm::ack(&id, ts).await;
            let _ = call("IFriendMessagesService", "AckMessage", &[("steamid_partner", id), ("timestamp", ts.to_string())], true, 10_000).await;
        });
    }
    S.lock().unread.remove(steamid);
    apply_unread();
}

pub fn find_friend(id: &str) -> Option<Value> {
    S.lock().state["friends"].as_array().and_then(|a| a.iter().find(|f| f["steamid"] == id).cloned())
}

/// Steams "Spiel beitreten"-Link
pub fn join_url(f: &Value) -> Option<String> {
    f["appid"].as_str().map(|_| format!("steam://friends/joingame/{}", f["steamid"].as_str().unwrap_or("")))
}

/// Nachweis für die Ludora-Verknüpfung: frisches Zugriffs-Token + Name
pub async fn link_proof() -> Option<Value> {
    if !is_connected() {
        return None;
    }
    let token = ensure_access().await.ok()?;
    let me = S.lock().state["me"]["steamid"].as_str().unwrap_or("").to_string();
    let name = call("IPlayerService", "GetPlayerLinkDetails", &[("steamids[0]", me.clone())], false, 15_000)
        .await
        .ok()
        .and_then(|r| r["accounts"][0]["public_data"]["persona_name"].as_str().map(String::from));
    Some(json!({ "token": token, "claim": name.map(|n| json!({ "name": n })).unwrap_or(json!({})), "accountId": me }))
}

// ---------- Geräte: Streamen und Update-Fernsteuerung ----------

/// Rechnername vergleichen (Groß/Klein, Domain-Anhang egal)
pub fn same_machine(a: &str, b: &str) -> bool {
    let f = |x: &str| x.to_lowercase().split('.').next().unwrap_or("").to_string();
    f(a) == f(b)
}

pub fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_default()
}

/// Diesen PC unter Steams angemeldeten Clients finden (ohne Namen: einziger namenloser mit gleichem OS)
pub fn pick_this_client(sessions: &[Value], this_machine: &str, platform: &str) -> Option<Value> {
    let list: Vec<&Value> = sessions.iter().filter(|x| !sv(&x["client_instanceid"]).is_empty()).collect();
    if let Some(x) = list.iter().find(|x| same_machine(x["machine_name"].as_str().unwrap_or(""), this_machine)) {
        return Some((*x).clone());
    }
    let os = match platform {
        "win32" => "windows",
        "darwin" => "mac",
        _ => "linux",
    };
    let nameless: Vec<&&Value> = list
        .iter()
        .filter(|x| x["machine_name"].as_str().unwrap_or("").is_empty() && x["os_name"].as_str().map_or(true, |o| o.to_lowercase().contains(os) || (os == "linux" && o.to_lowercase().contains("steamos"))))
        .collect();
    if nameless.len() == 1 { Some((*nameless[0]).clone()) } else { None }
}

async fn this_client() -> Option<String> {
    if !is_connected() {
        return None;
    }
    let r = call("IClientCommService", "GetAllClientLogonInfo", &[], false, 20_000).await.ok()?;
    let sessions = r["sessions"].as_array().cloned().unwrap_or_default();
    let host = hostname();
    let s = pick_this_client(&sessions, &host, crate::ipc::platform());
    crate::log::info(&format!(
        "[update] Steam-Clients: {} | dieser PC: {host} -> {}",
        sessions.iter().map(|x| format!("{}/{}", x["machine_name"].as_str().filter(|n| !n.is_empty()).unwrap_or("(ohne Name)"), x["os_name"].as_str().unwrap_or("?"))).collect::<Vec<_>>().join(", "),
        s.as_ref().map(|x| x["machine_name"].as_str().filter(|n| !n.is_empty()).unwrap_or("(ohne Name)").to_string()).unwrap_or("nicht gefunden".into())
    ));
    s.map(|x| sv(&x["client_instanceid"]))
}

pub async fn wait_for_this_client(ms: u64) -> bool {
    let until = std::time::Instant::now() + Duration::from_millis(ms);
    loop {
        if this_client().await.is_some() {
            return true;
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Update auf diesem PC über Steams Fernsteuerung starten (wie "Remote-Download" auf der Webseite)
pub async fn start_update(appid: &str, wait_ms: u64) -> anyhow::Result<bool> {
    if !is_connected() {
        anyhow::bail!(t("In Ludora nicht bei Steam angemeldet"));
    }
    let until = std::time::Instant::now() + Duration::from_millis(wait_ms);
    let id = loop {
        if let Some(i) = this_client().await {
            break Some(i);
        }
        if std::time::Instant::now() >= until {
            break None;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    };
    let Some(id) = id else { anyhow::bail!(t_args("Steam läuft auf diesem PC nicht mit deinem Konto ({0})", &[&hostname()])) };
    crate::log::info(&format!("[update] SetClientAppUpdateState {appid} …"));
    call("IClientCommService", "SetClientAppUpdateState", &[("appid", appid.to_string()), ("action", "1".into()), ("client_instanceid", id)], true, 30_000).await?;
    crate::log::info(&format!("[update] SetClientAppUpdateState {appid} ok"));
    Ok(true)
}

/// Andere Geräte mit Steam: (Name, installierte Spiele)
pub async fn remote_installed() -> anyhow::Result<Vec<(String, Vec<String>)>> {
    if !is_connected() {
        return Ok(vec![]);
    }
    let r = call("IClientCommService", "GetAllClientLogonInfo", &[], false, 20_000).await?;
    let sessions = r["sessions"].as_array().cloned().unwrap_or_default();
    let host = hostname();
    let me = pick_this_client(&sessions, &host, crate::ipc::platform());
    let mut out = vec![];
    for s in sessions {
        let id = sv(&s["client_instanceid"]);
        let name = s["machine_name"].as_str().unwrap_or("").to_string();
        if id.is_empty() || me.as_ref().is_some_and(|m| sv(&m["client_instanceid"]) == id) || same_machine(&name, &host) {
            continue;
        }
        // Namenlose Geräte (Handy-App, ausgeschaltete Rechner) antworten nicht -> überspringen
        if name.is_empty() {
            continue;
        }
        match call("IClientCommService", "GetClientAppList", &[("client_instanceid", id), ("fields", "games".into()), ("filters", "installed".into()), ("language", "english".into())], false, 20_000).await {
            Ok(list) => {
                let apps = list["apps"].as_array().cloned().unwrap_or_default().iter().filter(|a| a["installed"] != false && !a["appid"].is_null()).map(|a| sv(&a["appid"])).collect();
                out.push((name, apps));
            }
            Err(e) => crate::log::warn(&format!("[steam] Geräteliste {name} {e}")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hilfen() {
        let (acc, header) = cookie_tokens(&[
            "steamLoginSecure=7656%7C%7Cstoretok; Domain=store.steampowered.com".into(),
            "steamLoginSecure=7656%7C%7Ccommtok; Domain=steamcommunity.com".into(),
            "sessionid=abc; Domain=steamcommunity.com".into(),
        ]);
        assert_eq!(acc.as_deref(), Some("storetok"));
        assert!(header.contains("sessionid=abc"));
        let v = parse_json_big(r#"{"response":{"sessions":[{"client_instanceid":12345678901234567891}]}}"#);
        assert_eq!(v["response"]["sessions"][0]["client_instanceid"], "12345678901234567891");
        let s = vec![json!({ "client_instanceid": "1", "machine_name": "", "os_name": "Windows 11" }), json!({ "client_instanceid": "2", "machine_name": "Air-von-Max", "os_name": "macOS" })];
        assert_eq!(pick_this_client(&s, "MAX", "win32").unwrap()["client_instanceid"], "1");
        assert_eq!(pick_this_client(&s, "air-von-max.local", "darwin").unwrap()["client_instanceid"], "2");
        assert_eq!(to_steam_id(1), "76561197960265729");
        let jwt = format!("x.{}.y", B64URL.encode(br#"{"sub":"7656","exp":5}"#));
        assert_eq!(jwt_payload(&jwt)["sub"], "7656");
        assert_eq!(avatar_url(&json!("0000000000000000000000000000000000000000")), json!("https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg"));
    }
}
