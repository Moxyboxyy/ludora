//! Steam-Chat über die CM-Verbindung (Websocket), wie steam-user in der Electron-Version.
//! Nachrichten senden geht über die Web-API nicht (404) – nur über eine angemeldete CM-Sitzung.
//! Anmeldung mit einem kurzlebigen Web-Chat-Token (steamcommunity.com/chat/clientjstoken).

use futures::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

use crate::protobuf::{self, Writer};
use crate::util::t;

const PROTO_MASK: u32 = 0x8000_0000;
const PROTOCOL_VERSION: u64 = 65580;
const EMSG_MULTI: u32 = 1;
const EMSG_SERVICE_METHOD: u32 = 146;
const EMSG_SERVICE_METHOD_RESPONSE: u32 = 147;
const EMSG_SERVICE_METHOD_CALL: u32 = 151;
const EMSG_CLIENT_HEARTBEAT: u32 = 703;
const EMSG_CLIENT_LOGON_RESPONSE: u32 = 751;
const EMSG_CLIENT_LOGGED_OFF: u32 = 757;
const EMSG_CLIENT_LOGON: u32 = 5514;
const EMSG_CLIENT_CHANGE_STATUS: u32 = 716;
const EMSG_CLIENT_PERSONA_STATE: u32 = 766;

type Job = oneshot::Sender<(i32, Vec<u8>)>;

struct Session {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    steamid: u64,
    session_id: i32,
    jobs: Arc<Mutex<HashMap<u64, Job>>>,
    alive: Arc<AtomicBool>,
}

static SESSION: Lazy<tokio::sync::Mutex<Option<Arc<Session>>>> = Lazy::new(|| tokio::sync::Mutex::new(None));
static JOB_ID: AtomicU64 = AtomicU64::new(1);

fn header(steamid: u64, session_id: i32, job_source: Option<u64>, job_name: Option<&str>) -> Vec<u8> {
    let mut h = Writer::default();
    h.fixed64(1, steamid);
    h.uint(2, session_id as u32 as u64);
    if let Some(j) = job_source {
        h.fixed64(10, j);
    }
    if let Some(n) = job_name {
        h.string(12, n);
    }
    h.buf
}

fn frame(emsg: u32, hdr: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + hdr.len() + body.len());
    out.extend_from_slice(&(emsg | PROTO_MASK).to_le_bytes());
    out.extend_from_slice(&(hdr.len() as u32).to_le_bytes());
    out.extend_from_slice(hdr);
    out.extend_from_slice(body);
    out
}

/// Eine eingehende Nachricht zerlegen: (EMsg, Kopf, Inhalt)
fn split(msg: &[u8]) -> Option<(u32, Vec<u8>, Vec<u8>)> {
    if msg.len() < 8 {
        return None;
    }
    let raw = u32::from_le_bytes(msg[0..4].try_into().ok()?);
    if raw & PROTO_MASK == 0 {
        return Some((raw, vec![], vec![])); // alte Nachrichten ohne Protobuf: brauchen wir nicht
    }
    let hl = u32::from_le_bytes(msg[4..8].try_into().ok()?) as usize;
    let hdr = msg.get(8..8 + hl)?.to_vec();
    Some((raw & !PROTO_MASK, hdr, msg[8 + hl..].to_vec()))
}

/// CMsgMulti entpacken (ggf. gzip) -> einzelne Nachrichten
fn unpack_multi(body: &[u8]) -> Vec<Vec<u8>> {
    let Some(f) = protobuf::decode(body) else { return vec![] };
    let size = protobuf::int(&f, 1).unwrap_or(0);
    let Some(data) = protobuf::bytes(&f, 2) else { return vec![] };
    let data = if size > 0 {
        let mut out = Vec::new();
        if flate2::read::GzDecoder::new(data).read_to_end(&mut out).is_err() {
            return vec![];
        }
        out
    } else {
        data.to_vec()
    };
    let mut msgs = vec![];
    let mut pos = 0;
    while pos + 4 <= data.len() {
        let len = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        if pos + len > data.len() {
            break;
        }
        msgs.push(data[pos..pos + len].to_vec());
        pos += len;
    }
    msgs
}

async fn cm_servers() -> anyhow::Result<Vec<String>> {
    let j: serde_json::Value = crate::net::client()
        .get("https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0&format=json")
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    let list: Vec<String> = j["response"]["serverlist"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|s| s["type"] == "websockets")
        .filter_map(|s| s["endpoint"].as_str().map(String::from))
        .collect();
    if list.is_empty() {
        anyhow::bail!("keine Steam-Server");
    }
    Ok(list)
}

async fn connect() -> anyhow::Result<Arc<Session>> {
    use tokio_tungstenite::tungstenite::Message;
    // Web-Chat-Token mit den Cookies der Steam-Anmeldung
    let cookie = crate::steam::community_cookie().await?;
    let tok: serde_json::Value = crate::net::client()
        .get("https://steamcommunity.com/chat/clientjstoken")
        .header("cookie", cookie)
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .json()
        .await
        .unwrap_or_default();
    let (Some(token), Some(account), true) = (tok["token"].as_str(), tok["account_name"].as_str(), tok["logged_in"] == true) else {
        anyhow::bail!(t("Steam-Chat-Anmeldung fehlgeschlagen"));
    };
    let steamid: u64 = match &tok["steamid"] {
        serde_json::Value::String(s) => s.parse()?,
        v => v.as_u64().ok_or_else(|| anyhow::anyhow!("steamid"))?,
    };

    let servers = cm_servers().await?;
    let mut last_err = anyhow::anyhow!("keine Verbindung");
    let mut ws = None;
    for ep in servers.iter().take(4) {
        match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(format!("wss://{ep}/cmsocket/"))).await {
            Ok(Ok((s, _))) => {
                ws = Some(s);
                break;
            }
            Ok(Err(e)) => last_err = e.into(),
            Err(_) => last_err = anyhow::anyhow!("Zeitüberschreitung"),
        }
    }
    let ws = ws.ok_or(last_err)?;
    let (mut write, mut read) = ws.split();

    // Anmelden (wie steam-user mit webLogonToken)
    let mut logon = Writer::default();
    logon
        .uint(1, PROTOCOL_VERSION)
        .uint(7, 4294966596) // EOSType.Web
        .uint(32, 4) // ui_mode
        .uint(33, 2) // chat_mode: neuer Chat
        .string(50, account)
        .string(103, token);
    write.send(Message::Binary(frame(EMSG_CLIENT_LOGON, &header(steamid, 0, None, None), &logon.buf))).await?;

    // Auf die Antwort warten
    let (session_id, heartbeat) = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(m) = read.next().await {
            let Message::Binary(b) = m? else { continue };
            let mut queue = vec![b];
            while let Some(b) = queue.pop() {
                let Some((emsg, hdr, body)) = split(&b) else { continue };
                if emsg == EMSG_MULTI {
                    queue.extend(unpack_multi(&body));
                    continue;
                }
                if emsg == EMSG_CLIENT_LOGON_RESPONSE {
                    let f = protobuf::decode(&body).unwrap_or_default();
                    let er = protobuf::int(&f, 1).unwrap_or(2) as i32;
                    if er != 1 {
                        anyhow::bail!("{} (EResult {er})", t("Steam-Chat-Anmeldung fehlgeschlagen"));
                    }
                    let h = protobuf::decode(&hdr).unwrap_or_default();
                    let sid = protobuf::int(&h, 2).unwrap_or(0) as i32;
                    let hb = protobuf::int(&f, 3).or(protobuf::int(&f, 2)).unwrap_or(30).max(10);
                    return Ok((sid, hb));
                }
            }
        }
        anyhow::bail!("Verbindung zu Steam getrennt")
    })
    .await
    .map_err(|_| anyhow::anyhow!(t("Zeitüberschreitung beim Steam-Chat")))??;

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let jobs: Arc<Mutex<HashMap<u64, Job>>> = Arc::default();
    let alive = Arc::new(AtomicBool::new(true));
    let sess = Arc::new(Session { tx: tx.clone(), steamid, session_id, jobs: jobs.clone(), alive: alive.clone() });

    // Schreiben + Herzschlag
    let alive_w = alive.clone();
    let hb_frame = frame(EMSG_CLIENT_HEARTBEAT, &header(steamid, session_id, None, None), &[]);
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(heartbeat));
        tick.tick().await;
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(b) => if write.send(Message::Binary(b)).await.is_err() { break },
                    None => break,
                },
                _ = tick.tick() => if write.send(Message::Binary(hb_frame.clone())).await.is_err() { break },
            }
        }
        alive_w.store(false, Ordering::SeqCst);
        let _ = write.close().await;
    });

    // Lesen: Antworten auf Aufträge zuordnen
    let alive_r = alive.clone();
    let tx_r = tx.clone();
    let my_id = steamid;
    tauri::async_runtime::spawn(async move {
        while let Some(Ok(m)) = read.next().await {
            let Message::Binary(b) = m else { continue };
            let mut queue = vec![b];
            while let Some(b) = queue.pop() {
                let Some((emsg, hdr, body)) = split(&b) else { continue };
                match emsg {
                    EMSG_MULTI => queue.extend(unpack_multi(&body)),
                    EMSG_SERVICE_METHOD_RESPONSE => {
                        let h = protobuf::decode(&hdr).unwrap_or_default();
                        let target = h.iter().find(|f| f.field == 11 && f.wire == 1).and_then(|f| f.bytes.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0);
                        let er = protobuf::int(&h, 13).unwrap_or(1) as i32;
                        if let Some(j) = jobs.lock().remove(&target) {
                            let _ = j.send((er, body));
                        }
                    }
                    EMSG_SERVICE_METHOD => {
                        let h = protobuf::decode(&hdr).unwrap_or_default();
                        if protobuf::string(&h, 12).as_deref() == Some("FriendMessagesClient.IncomingMessage#1") {
                            handle_incoming(&body);
                        }
                    }
                    EMSG_CLIENT_PERSONA_STATE => {
                        // Eigener Status im Steam-Client geändert? Dann mitziehen, sonst Freundesliste neu laden
                        if let Some(st) = own_state_change(&body, my_id) {
                            if st != 0 && st != MY_STATE.swap(st, Ordering::SeqCst) {
                                let mut w = Writer::default();
                                w.uint(1, st);
                                let _ = tx_r.send(frame(EMSG_CLIENT_CHANGE_STATUS, &header(my_id, session_id, None, None), &w.buf));
                            }
                        }
                        crate::steam::poke_live();
                    }
                    EMSG_CLIENT_LOGGED_OFF => {
                        alive_r.store(false, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
            if !alive_r.load(Ordering::SeqCst) {
                break;
            }
        }
        alive_r.store(false, Ordering::SeqCst);
    });
    crate::log::info("[chat] Steam-Chat verbunden");
    // Steam schickt Status-Änderungen der Freunde nur an Sitzungen mit eigenem Status: deinen
    // aktuellen übernehmen (für deine Freunde ändert sich nichts; offline -> unsichtbar)
    let s2 = sess.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(st) = crate::steam::my_persona_state().await {
            let target = if st == 0 { 7 } else { st };
            MY_STATE.store(target, Ordering::SeqCst);
            let mut w = Writer::default();
            w.uint(1, target);
            let _ = s2.tx.send(frame(EMSG_CLIENT_CHANGE_STATUS, &header(s2.steamid, s2.session_id, None, None), &w.buf));
        }
    });
    Ok(sess)
}

static MY_STATE: AtomicU64 = AtomicU64::new(0);

/// CMsgClientPersonaState: Status des eigenen Kontos, falls enthalten
fn own_state_change(body: &[u8], me: u64) -> Option<u64> {
    let f = protobuf::decode(body)?;
    for fr in f.iter().filter(|x| x.field == 2 && x.wire == 2) {
        let Some(inner) = protobuf::decode(fr.bytes) else { continue };
        let id = inner.iter().find(|x| x.field == 1 && x.wire == 1).and_then(|x| x.bytes.try_into().ok()).map(u64::from_le_bytes);
        if id == Some(me) {
            return protobuf::int(&inner, 2);
        }
    }
    None
}

/// CFriendMessages_IncomingMessage_Notification
fn handle_incoming(body: &[u8]) {
    let Some(f) = protobuf::decode(body) else { return };
    let fixed64 = |n: u64| f.iter().find(|x| x.field == n && x.wire == 1).and_then(|x| x.bytes.try_into().ok()).map(u64::from_le_bytes);
    let fixed32 = |n: u64| f.iter().find(|x| x.field == n && x.wire == 5).and_then(|x| x.bytes.try_into().ok()).map(u32::from_le_bytes);
    let Some(sid) = fixed64(1) else { return };
    let entry = protobuf::int(&f, 2).unwrap_or(0);
    let text = protobuf::string(&f, 8).filter(|t| !t.is_empty()).or_else(|| protobuf::string(&f, 4)).unwrap_or_default();
    let ts = fixed32(5).map(|x| x as i64).or_else(|| protobuf::int(&f, 5).map(|x| x as i64)).unwrap_or(0);
    let ordinal = protobuf::int(&f, 6).unwrap_or(0) as i64;
    let echo = protobuf::int(&f, 7).unwrap_or(0) != 0;
    crate::steam::on_cm_message(sid.to_string(), entry, text, ts, ordinal, echo);
}

static KEEP_GEN: AtomicU64 = AtomicU64::new(0);

/// Verbindung halten, solange die Steam-Anmeldung (Generation `my`) gilt; bei Abbruch neu verbinden
pub fn keep_alive(my: u64, current: fn() -> u64) {
    KEEP_GEN.store(my, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let mut wait = 5u64;
        loop {
            if current() != my || KEEP_GEN.load(Ordering::SeqCst) != my {
                return;
            }
            let ok = match session().await {
                Ok(s) => {
                    wait = 5;
                    // warten, bis die Verbindung abbricht
                    while s.alive.load(Ordering::SeqCst) && current() == my {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    true
                }
                Err(e) => {
                    crate::log::warn(&format!("[chat] Steam-Chat-Verbindung: {e}"));
                    false
                }
            };
            if current() != my {
                stop().await;
                return;
            }
            tokio::time::sleep(Duration::from_secs(if ok { 3 } else { wait })).await;
            if !ok {
                wait = (wait * 2).min(300);
            }
        }
    });
}

async fn session() -> anyhow::Result<Arc<Session>> {
    let mut g = SESSION.lock().await;
    if let Some(s) = g.as_ref() {
        if s.alive.load(Ordering::SeqCst) {
            return Ok(s.clone());
        }
    }
    let s = connect().await?;
    *g = Some(s.clone());
    Ok(s)
}

/// Steht die Chat-Verbindung gerade? (für den Funktionstest)
pub fn is_alive() -> bool {
    SESSION.try_lock().ok().and_then(|g| g.as_ref().map(|s| s.alive.load(Ordering::SeqCst))).unwrap_or(false)
}

pub async fn stop() {
    *SESSION.lock().await = None; // Schreib-Kanal fällt weg -> Verbindung wird geschlossen
}

/// Dienst-Aufruf über die CM-Verbindung; mit `reply` wird auf die Antwort gewartet
async fn call(method: &str, body: Vec<u8>, reply: bool) -> anyhow::Result<Vec<u8>> {
    let s = session().await?;
    let job = JOB_ID.fetch_add(1, Ordering::SeqCst);
    let rx = if reply {
        let (tx, rx) = oneshot::channel();
        s.jobs.lock().insert(job, tx);
        Some(rx)
    } else {
        None
    };
    let hdr = header(s.steamid, s.session_id, if reply { Some(job) } else { None }, Some(method));
    s.tx.send(frame(EMSG_SERVICE_METHOD_CALL, &hdr, &body)).map_err(|_| anyhow::anyhow!("Verbindung zu Steam getrennt"))?;
    let Some(rx) = rx else { return Ok(vec![]) };
    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok((1, b))) => Ok(b),
        Ok(Ok((er, _))) => anyhow::bail!("EResult {er}"),
        _ => {
            s.jobs.lock().remove(&job);
            s.alive.store(false, Ordering::SeqCst);
            anyhow::bail!(t("Zeitüberschreitung beim Steam-Chat"))
        }
    }
}

/// Nachricht senden -> (Server-Zeit in Sekunden, Ordnungsnummer)
pub async fn send_message(steamid: &str, text: &str) -> anyhow::Result<(i64, i64)> {
    let id: u64 = steamid.parse()?;
    let mut w = Writer::default();
    w.fixed64(1, id).uint(2, 1).string(3, text).uint(4, 0).uint(5, 0); // kein Echo an diese Sitzung (sonst doppelt)
    let r = match call("FriendMessages.SendMessage#1", w.buf.clone(), true).await {
        Ok(r) => r,
        Err(_) => {
            // Verbindung war wohl abgelaufen: einmal neu verbinden
            stop().await;
            call("FriendMessages.SendMessage#1", w.buf, true).await?
        }
    };
    let f = protobuf::decode(&r).unwrap_or_default();
    Ok((protobuf::int(&f, 2).unwrap_or(0) as i64, protobuf::int(&f, 3).unwrap_or(0) as i64))
}

pub async fn typing(steamid: &str) {
    let Ok(id) = steamid.parse::<u64>() else { return };
    let mut w = Writer::default();
    w.fixed64(1, id).uint(2, 2);
    let _ = call("FriendMessages.SendMessage#1", w.buf, true).await;
}

pub async fn ack(steamid: &str, timestamp: u64) {
    let Ok(id) = steamid.parse::<u64>() else { return };
    if SESSION.lock().await.as_ref().map_or(true, |s| !s.alive.load(Ordering::SeqCst)) {
        return; // nur über eine bestehende Verbindung, nicht extra dafür anmelden
    }
    let mut w = Writer::default();
    w.fixed64(1, id).uint(2, timestamp);
    let _ = call("FriendMessages.AckMessage#1", w.buf, false).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_roundtrip() {
        let f = frame(EMSG_CLIENT_LOGON, &header(76561198000000000, 5, Some(7), Some("A.B#1")), b"xy");
        let (e, h, b) = split(&f).unwrap();
        assert_eq!(e, EMSG_CLIENT_LOGON);
        assert_eq!(b, b"xy");
        let h = protobuf::decode(&h).unwrap();
        assert_eq!(protobuf::int(&h, 2), Some(5));
        assert_eq!(protobuf::string(&h, 12).as_deref(), Some("A.B#1"));
    }
    #[test]
    fn incoming_message_decoded() {
        let mut w = Writer::default();
        w.fixed64(1, 76561198000000001).uint(2, 1).string(4, "[b]hi[/b]").string(8, "hi").uint(6, 3).uint(7, 0);
        w.buf.extend_from_slice(&[(5 << 3) | 5]);
        w.buf.extend_from_slice(&1700000000u32.to_le_bytes());
        let f = protobuf::decode(&w.buf).unwrap();
        assert_eq!(protobuf::string(&f, 8).as_deref(), Some("hi"));
        assert_eq!(f.iter().find(|x| x.field == 5).unwrap().bytes, &1700000000u32.to_le_bytes());
    }
    #[test]
    fn own_state() {
        let mut fr = Writer::default();
        fr.fixed64(1, 42).uint(2, 3);
        let mut w = Writer::default();
        w.uint(1, 0).bytes(2, &fr.buf);
        assert_eq!(own_state_change(&w.buf, 42), Some(3));
        assert_eq!(own_state_change(&w.buf, 7), None);
    }
    #[test]
    fn multi_gzip() {
        use std::io::Write;
        let inner = frame(EMSG_CLIENT_HEARTBEAT, &[], b"");
        let mut payload = (inner.len() as u32).to_le_bytes().to_vec();
        payload.extend(&inner);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&payload).unwrap();
        let mut w = Writer::default();
        w.uint(1, payload.len() as u64).bytes(2, &gz.finish().unwrap());
        let msgs = unpack_multi(&w.buf);
        assert_eq!(msgs.len(), 1);
        assert_eq!(split(&msgs[0]).unwrap().0, EMSG_CLIENT_HEARTBEAT);
    }
}
