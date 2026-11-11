//! Riot-Freundesliste und -Chat über die lokale Schnittstelle des laufenden Riot Client.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

use super::Store;
use crate::providers::riot::client as rc;
use crate::util::{t, t_args};

pub static STORE: Lazy<Store> = Lazy::new(|| Store::new("riot", json!({ "needsLogin": false })));
static FAST: AtomicBool = AtomicBool::new(false);
static WAKE: Lazy<Notify> = Lazy::new(Notify::new);
static CHAT_WAKE: Lazy<Notify> = Lazy::new(Notify::new);

#[derive(Default)]
struct S {
    pid_by_puuid: HashMap<String, String>,
    watched: HashMap<String, i32>,
    last_seen: HashMap<String, i64>,
    my_puuid: Option<String>,
}
static ST: Lazy<Mutex<S>> = Lazy::new(Default::default);

fn product_name(p: &str) -> String {
    match p {
        "league_of_legends" => "League of Legends",
        "valorant" => "VALORANT",
        "bacon" => "Legends of Runeterra",
        "lion" => "2XKO",
        "teamfighttactics" => "Teamfight Tactics",
        x => x,
    }
    .to_string()
}

fn state_of(s: &str) -> &'static str {
    match s {
        "chat" => "online",
        "away" => "away",
        "dnd" => "busy",
        "mobile" | "offline" | "unavailable" => "offline",
        _ => "online",
    }
}

fn not_a_game(p: &str) -> bool {
    matches!(p, "" | "keystone" | "riot_client" | "riotclient" | "rso")
}

fn decode_private(p: &Value) -> Option<Value> {
    use base64::Engine;
    let s = p.as_str().filter(|s| !s.is_empty())?;
    if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(s) {
        if let Ok(v) = serde_json::from_slice::<Value>(&b) {
            if v.is_object() {
                return Some(v);
            }
        }
    }
    serde_json::from_str::<Value>(s).ok().filter(|v| v.is_object())
}

fn s_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Text zur Spielphase (VALORANT: Modus + Spielstand, LoL/TFT: Phase)
pub fn rich_text_for(product: &str, priv_: Option<&Value>) -> Option<String> {
    let p = priv_?;
    if product == "valorant" {
        let m = if p["matchPresenceData"].is_object() { &p["matchPresenceData"] } else { p };
        let party = if p["partyPresenceData"].is_object() { &p["partyPresenceData"] } else { p };
        let loop_ = m["sessionLoopState"].as_str().or(p["sessionLoopState"].as_str()).unwrap_or("");
        let q = [&m["queueId"], &p["queueId"], &party["queueId"]].iter().find_map(|v| v.as_str().filter(|s| !s.is_empty())).unwrap_or("").to_lowercase();
        let mode = match q.as_str() {
            "competitive" => "Competitive".to_string(),
            "unrated" => "Unrated".into(),
            "swiftplay" => "Swiftplay".into(),
            "spikerush" => "Spike Rush".into(),
            "deathmatch" => "Deathmatch".into(),
            "ggteam" => "Escalation".into(),
            "onefa" => "Replication".into(),
            "hurm" => "Team Deathmatch".into(),
            "premier" => "Premier".into(),
            "newmap" => "New Map".into(),
            "" => String::new(),
            x => {
                let mut c = x.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            }
        };
        if loop_ == "INGAME" {
            let ally = s_of(&party["partyOwnerMatchScoreAllyTeam"]).or(s_of(&p["partyOwnerMatchScoreAllyTeam"]));
            let enemy = s_of(&party["partyOwnerMatchScoreEnemyTeam"]).or(s_of(&p["partyOwnerMatchScoreEnemyTeam"]));
            let score = match (ally, enemy) {
                (Some(a), Some(e)) if a.parse::<f64>().is_ok() && e.parse::<f64>().is_ok() => format!("{a} - {e}"),
                _ => String::new(),
            };
            let head = if mode.is_empty() { t("Im Spiel") } else { mode };
            return Some([head, score].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "));
        }
        let base = match loop_ {
            "MENUS" => Some(t("Im Menü")),
            "PREGAME" => Some(t("Agenten-Auswahl")),
            "INGAME" => Some(t("Im Spiel")),
            _ => None,
        };
        let s = [base.unwrap_or_default(), mode].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
        return if s.is_empty() { None } else { Some(s) };
    }
    if product == "league_of_legends" || product == "teamfighttactics" {
        let gs = p["gameStatus"].as_str()?;
        let label = match gs {
            "outOfGame" => Some("Im Client"),
            "inQueue" => Some("In der Warteschlange"),
            "championSelect" => Some("Champion-Auswahl"),
            "inGame" => Some("Im Spiel"),
            "hosting_NORMAL" | "hosting_RANKED_SOLO_5x5" => Some("Erstellt eine Lobby"),
            "spectating" => Some("Schaut zu"),
            _ => None,
        };
        return Some(label.map(t).unwrap_or_else(|| gs.to_string()));
    }
    None
}

fn score(p: &Value) -> i32 {
    let st = state_of(p["state"].as_str().unwrap_or(""));
    if st == "offline" {
        return 0;
    }
    let game = !not_a_game(&p["product"].as_str().unwrap_or("").to_lowercase());
    (if game { 10 } else { 0 }) + match st {
        "online" => 3,
        "busy" => 2,
        _ => 1,
    }
}

/// Freunde + Presences -> einheitliches Format
pub fn merge(friends: &[Value], presences: &[Value]) -> Vec<Value> {
    let mut pres: HashMap<String, Value> = HashMap::new();
    for p in presences {
        let Some(id) = p["puuid"].as_str() else { continue };
        if pres.get(id).map_or(true, |cur| score(p) > score(cur)) {
            pres.insert(id.to_string(), p.clone());
        }
    }
    friends
        .iter()
        .map(|f| {
            let p = f["puuid"].as_str().and_then(|id| pres.get(id));
            let state = p.map_or("offline", |p| state_of(p["state"].as_str().unwrap_or("")));
            let online = state != "offline";
            let prod_raw = p.and_then(|p| p["product"].as_str()).unwrap_or("").to_lowercase();
            let product = if online && !not_a_game(&prod_raw) { Some(prod_raw) } else { None };
            let pick = |a: &Value, b: &Value| a.as_str().filter(|s| !s.is_empty()).or(b.as_str().filter(|s| !s.is_empty())).map(String::from);
            let name = pick(&f["game_name"], &f["name"]).or_else(|| p.and_then(|p| p["game_name"].as_str().map(String::from))).unwrap_or_else(|| "Unbekannt".into());
            let tag = f["game_tag"].as_str().filter(|s| !s.is_empty()).map(String::from).or_else(|| p.and_then(|p| p["game_tag"].as_str().map(String::from))).unwrap_or_default();
            let priv_ = p.and_then(|p| decode_private(&p["private"]));
            json!({
                "id": f["puuid"],
                "name": name,
                "tag": tag,
                "avatar": null,
                "state": state,
                "gameName": product.as_ref().map(|x| product_name(x)),
                "richText": product.as_ref().and_then(|x| rich_text_for(x, priv_.as_ref())),
                "lastOnline": null
            })
        })
        .collect()
}

fn body(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(json!({}))
}

async fn poll() {
    if rc::read_lockfile().is_none() {
        STORE.set(json!({ "status": "unavailable", "reason": "notRunning", "error": null, "friends": [] }));
        return;
    }
    let ((fs, fb), (ps, pb)) = tokio::join!(rc::api("GET", "/chat/v4/friends", None), rc::api("GET", "/chat/v4/presences", None));
    if fs == 404 || fs == 0 {
        STORE.set(json!({ "status": "unavailable", "reason": if fs == 404 { "chatOff" } else { "notRunning" }, "error": null, "friends": [] }));
        return;
    }
    if fs != 200 {
        STORE.set(json!({ "status": "error", "error": t_args("Riot Client antwortet mit {0}", &[&fs.to_string()]) }));
        return;
    }
    let friends = body(&fb)["friends"].as_array().cloned().unwrap_or_default();
    {
        let mut s = ST.lock();
        for f in &friends {
            if let (Some(p), Some(pid)) = (f["puuid"].as_str(), f["pid"].as_str()) {
                s.pid_by_puuid.insert(p.into(), pid.into());
            }
        }
    }
    let presences = if ps == 200 { body(&pb)["presences"].as_array().cloned().unwrap_or_default() } else { vec![] };
    STORE.set(json!({ "status": "connected", "error": null, "hint": null, "friends": merge(&friends, &presences) }));
}

pub fn init() {
    tauri::async_runtime::spawn(async {
        loop {
            poll().await;
            let d = if FAST.load(Ordering::SeqCst) { 3000 } else { crate::idle_ms(10000) };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(d)) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
    tauri::async_runtime::spawn(async {
        loop {
            check_chats().await;
            let d = if ST.lock().watched.is_empty() { crate::idle_ms(8000) } else { 2000 };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(d)) => {}
                _ = CHAT_WAKE.notified() => {}
            }
        }
    });
}

pub fn refresh() {
    WAKE.notify_one();
}

pub fn set_fast(on: bool) {
    FAST.store(on, Ordering::SeqCst);
    if on {
        WAKE.notify_one();
    }
}

// ---------- Chat ----------

async fn me() -> Option<String> {
    if let Some(p) = ST.lock().my_puuid.clone() {
        return Some(p);
    }
    let (st, b) = rc::api("GET", "/chat/v1/session", None).await;
    if st == 200 {
        let p = body(&b)["puuid"].as_str().map(String::from);
        ST.lock().my_puuid = p.clone();
        return p;
    }
    None
}

fn chat_error(status: u16) -> anyhow::Error {
    match status {
        404 => anyhow::anyhow!(t("Der Riot-Chat ist gerade aus (Riot Client läuft nur im Hintergrund). Öffne den Riot Client einmal normal.")),
        0 => anyhow::anyhow!(t("Der Riot Client läuft nicht.")),
        s => anyhow::anyhow!(t_args("Riot Client antwortet mit {0}", &[&s.to_string()])),
    }
}

fn cid_for(puuid: &str) -> anyhow::Result<String> {
    ST.lock().pid_by_puuid.get(puuid).cloned().ok_or_else(|| anyhow::anyhow!(t("Riot-Freund nicht gefunden – Freundesliste neu laden.")))
}

fn parse_time(v: &Value) -> i64 {
    if let Some(n) = v.as_i64() {
        return n;
    }
    let s = v.as_str().unwrap_or("");
    s.parse::<i64>().ok().or_else(|| chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())).unwrap_or_else(super::now)
}

/// Nachrichten eines Gesprächs -> einheitliches Format
pub fn to_messages(list: &[Value], mine: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = list
        .iter()
        .filter(|m| (m["type"] == "chat" || m["type"].is_null()) && m["body"].as_str().is_some_and(|b| !b.is_empty()))
        .map(|m| {
            let from_me = mine.is_some_and(|me| m["puuid"].as_str() == Some(me) || m["pid"].as_str().unwrap_or("").starts_with(&format!("{me}@")));
            json!({ "fromMe": from_me, "text": m["body"], "ts": parse_time(&m["time"]), "id": if m["id"].is_null() { m["mid"].clone() } else { m["id"].clone() } })
        })
        .collect();
    out.sort_by_key(|m| m["ts"].as_i64().unwrap_or(0));
    out
}

async fn messages(cid: &str) -> Result<Vec<Value>, u16> {
    let (st, b) = rc::api("GET", &format!("/chat/v6/messages?cid={}", crate::net::enc(cid)), None).await;
    if st != 200 {
        return Err(st);
    }
    let mine = me().await;
    Ok(to_messages(body(&b)["messages"].as_array().map(|a| a.as_slice()).unwrap_or(&[]), mine.as_deref()))
}

pub async fn history(puuid: &str) -> anyhow::Result<Vec<Value>> {
    let cid = cid_for(puuid)?;
    let msgs = messages(&cid).await.map_err(chat_error)?;
    if let Some(last) = msgs.last().and_then(|m| m["ts"].as_i64()) {
        let mut s = ST.lock();
        let cur = s.last_seen.get(&cid).copied().unwrap_or(0);
        s.last_seen.insert(cid, cur.max(last));
    }
    Ok(msgs)
}

pub async fn send(puuid: &str, text: &str) -> anyhow::Result<()> {
    let cid = cid_for(puuid)?;
    let msg: String = text.chars().take(2000).collect();
    let (st, _) = rc::api("POST", "/chat/v6/messages", Some(json!({ "cid": cid, "message": msg, "type": "chat" }))).await;
    if !(200..300).contains(&st) {
        return Err(chat_error(st));
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_millis(400)).await;
        CHAT_WAKE.notify_one();
    });
    Ok(())
}

/// Neue Nachrichten suchen: offene Chats alle 2 s, sonst alle 8 s über die Ungelesen-Zähler
async fn check_chats() {
    if rc::read_lockfile().is_none() {
        return;
    }
    let mut cids: Vec<String> = {
        let s = ST.lock();
        s.watched.keys().filter_map(|p| s.pid_by_puuid.get(p).cloned()).collect()
    };
    let (st, b) = rc::api("GET", "/chat/v6/conversations", None).await;
    if st == 200 {
        for c in body(&b)["conversations"].as_array().cloned().unwrap_or_default() {
            let unread = c["unread_count"].as_f64().or_else(|| c["unread_count"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0);
            if c["type"] == "chat" && unread > 0.0 {
                if let Some(cid) = c["cid"].as_str() {
                    if !cids.iter().any(|x| x == cid) {
                        cids.push(cid.into());
                    }
                }
            }
        }
    }
    for cid in cids {
        let Ok(msgs) = messages(&cid).await else { continue };
        let newest = msgs.last().and_then(|m| m["ts"].as_i64()).unwrap_or(0);
        let known = ST.lock().last_seen.get(&cid).copied();
        let Some(known) = known else {
            ST.lock().last_seen.insert(cid, newest);
            continue;
        };
        let puuid = cid.split('@').next().unwrap_or("").to_string();
        for m in &msgs {
            if m["ts"].as_i64().unwrap_or(0) > known {
                let mut ev = json!({ "type": "message", "steamid": format!("riot:{puuid}") });
                super::merge(&mut ev, m.clone());
                if let Some(app) = super::app() {
                    crate::on_chat_event(app, ev);
                }
            }
        }
        ST.lock().last_seen.insert(cid, known.max(newest));
    }
}

pub fn watch(puuid: &str, on: bool) {
    {
        let mut s = ST.lock();
        let n = s.watched.get(puuid).copied().unwrap_or(0) + if on { 1 } else { -1 };
        if n > 0 {
            s.watched.insert(puuid.into(), n);
        } else {
            s.watched.remove(puuid);
        }
    }
    if on {
        CHAT_WAKE.notify_one();
    }
}

pub async fn link_proof() -> Option<Value> {
    rc::read_lockfile()?;
    let (st, b) = rc::api("GET", "/chat/v1/session", None).await;
    if st != 200 {
        return None;
    }
    let j = body(&b);
    let p = j["puuid"].as_str()?;
    Some(json!({ "token": "", "claim": { "puuid": p, "game_name": j["game_name"], "game_tag": j["game_tag"] }, "accountId": p }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_picks_game_presence() {
        let f = vec![json!({ "puuid": "a", "game_name": "Max", "game_tag": "EUW" })];
        let p = vec![json!({ "puuid": "a", "state": "chat", "product": "keystone" }), json!({ "puuid": "a", "state": "dnd", "product": "valorant", "private": "" })];
        let m = merge(&f, &p);
        assert_eq!(m[0]["state"], "busy");
        assert_eq!(m[0]["gameName"], "VALORANT");
        assert_eq!(m[0]["tag"], "EUW");
    }
    #[test]
    fn messages_from_me() {
        let m = to_messages(&[json!({ "type": "chat", "body": "hi", "pid": "me@eu1", "time": "5" }), json!({ "type": "system", "body": "x" })], Some("me"));
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["fromMe"], true);
        assert_eq!(m[0]["ts"], 5);
    }
}
