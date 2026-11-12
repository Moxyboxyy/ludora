//! Bibliothek und Spiele:
//! Scan, Zwischenspeicher, Cover/Kompatibilität im Hintergrund, Downloads mit Tempo/Restzeit,
//! Starten, Updaten (Launcher erst bereit machen), Deinstallieren, eigene Spiele.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::providers::{self, proc_names, P};
use crate::running::run_launch;
use crate::util::*;
use crate::{covers, hide, log, settings};

pub static LAST_SCAN: Lazy<Mutex<Value>> = Lazy::new(|| Mutex::new(json!({ "games": [] })));
static COVER_RUN: AtomicU64 = AtomicU64::new(0);

fn cache_file() -> std::path::PathBuf {
    crate::paths::data_dir().join("library-cache.json")
}

pub fn find_game(id: &str) -> anyhow::Result<Value> {
    LAST_SCAN.lock()["games"]
        .as_array()
        .and_then(|a| a.iter().find(|g| g["id"] == id).cloned())
        .ok_or_else(|| anyhow::anyhow!(t("Spiel nicht gefunden – bitte Bibliothek neu laden.")))
}

fn provider_of(game: &Value) -> anyhow::Result<P> {
    providers::by_id(game["provider"].as_str().unwrap_or("")).ok_or_else(|| anyhow::anyhow!(t("Unbekannter Launcher")))
}

/// Felder eines Spiels im letzten Scan ändern
fn patch_game(id: &str, patch: &Value) {
    let mut s = LAST_SCAN.lock();
    if let Some(g) = s["games"].as_array_mut().and_then(|a| a.iter_mut().find(|g| g["id"] == id)) {
        if let Some(o) = patch.as_object() {
            for (k, v) in o {
                if k != "id" {
                    g[k] = v.clone();
                }
            }
        }
    }
}

static SAVE_PENDING: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

/// Zwischenspeicher für den Schnellstart (gebündelt, höchstens alle 2 s)
fn save_cache() {
    let mut p = SAVE_PENDING.lock();
    if p.is_some() {
        return;
    }
    *p = Some(Instant::now());
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        *SAVE_PENDING.lock() = None;
        let s = LAST_SCAN.lock().clone();
        let out = json!({ "games": s["games"], "providers": s["providers"], "scannedAt": s["scannedAt"] });
        let _ = tokio::fs::write(cache_file(), serde_json::to_string(&out).unwrap_or_default()).await;
    });
}

pub async fn cached() -> Value {
    let Some(c) = read_json(cache_file()).await else { return Value::Null };
    if !c["games"].is_array() {
        return Value::Null;
    }
    let mut s = LAST_SCAN.lock();
    if s["games"].as_array().map_or(true, |a| a.is_empty()) {
        *s = c.clone(); // Starten/Updaten geht schon vor dem neuen Scan
    }
    c
}

pub async fn scan(app: &AppHandle) -> Value {
    let enabled = settings::get("enabledLaunchers").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut result = providers::scan_all(&enabled).await;
    covers::clear_url_cache();
    crate::icons::clear_cache();
    if let Some(ps) = result["providers"].as_array_mut() {
        for p in ps {
            if p["hasClient"] == true {
                p["logo"] = json!(format!("ghimg://launcher/{}", p["id"].as_str().unwrap_or("")));
            }
        }
    }
    let games = result["games"].as_array_mut().unwrap();
    covers::apply_cached(games);
    // Installierte Spiele bekommen als letzte Reserve ihr Programm-Symbol
    for g in games.iter_mut() {
        if g["iconUrl"].is_null() && g["status"] != "notInstalled" && g["installDir"].is_string() {
            g["iconUrl"] = json!(format!("ghimg://icon/{}", crate::net::enc(g["id"].as_str().unwrap_or(""))));
        }
    }
    let missing = covers::needs_lookup(games);
    let compat_missing = covers::compat_apply_cached(games);
    *LAST_SCAN.lock() = result.clone();

    let run = COVER_RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let a1 = app.clone();
    let push: Arc<dyn Fn(String, Value) + Send + Sync> = Arc::new(move |id, imgs| {
        patch_game(&id, &imgs);
        save_cache();
        if COVER_RUN.load(Ordering::SeqCst) == run {
            let mut ev = imgs.clone();
            ev["id"] = json!(id);
            crate::broadcast(&a1, "library:cover", ev);
        }
    });
    tokio::spawn(async move {
        if !missing.is_empty() {
            covers::resolve_missing(missing, push.clone()).await;
        }
        if COVER_RUN.load(Ordering::SeqCst) != run {
            return;
        }
        let games = LAST_SCAN.lock()["games"].as_array().cloned().unwrap_or_default();
        covers::check_all(games, push).await;
    });
    if !compat_missing.is_empty() {
        let a2 = app.clone();
        let cb: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |g| {
            let id = g["id"].as_str().unwrap_or("").to_string();
            patch_game(&id, &json!({ "platforms": g["platforms"], "runsHere": g["runsHere"] }));
            save_cache();
            if COVER_RUN.load(Ordering::SeqCst) == run {
                crate::broadcast(&a2, "library:compat", json!({ "id": id, "platforms": g["platforms"], "runsHere": g["runsHere"] }));
            }
        });
        tokio::spawn(covers::compat_fetch_missing(compat_missing, cb));
    }
    crate::streams::refresh(app.clone());
    save_cache();
    crate::tray::refresh(app);
    result
}

// ---------- Laufende Spiele ----------

static RUNNING: Lazy<Mutex<(Option<Instant>, HashMap<String, u32>)>> = Lazy::new(|| Mutex::new((None, HashMap::new())));

/// Laufende Spiele (gameId -> pid), höchstens alle 3 s neu ermittelt
pub async fn running_games() -> HashMap<String, u32> {
    {
        let r = RUNNING.lock();
        if r.0.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return r.1.clone();
        }
    }
    let games = LAST_SCAN.lock()["games"].as_array().cloned().unwrap_or_default();
    let procs = crate::running::list_processes().await;
    let m = crate::running::detect(&games, &[], &procs);
    *RUNNING.lock() = (Some(Instant::now()), m.clone());
    m
}

pub fn running_cached(id: &str) -> Option<u32> {
    RUNNING.lock().1.get(id).copied()
}

// ---------- Launcher bereit machen ----------

/// Läuft der Launcher? Some(true/false); None = lässt sich hier nicht prüfen
pub async fn launcher_running(p: &P) -> Option<bool> {
    let names = proc_names(p)?;
    if !(IS_WIN || IS_MAC) {
        return None;
    }
    let procs = crate::running::list_processes().await;
    if procs.is_empty() {
        return None;
    }
    let want: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    Some(procs.iter().any(|x| {
        let b = x.exe.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        let b = b.strip_suffix(".exe").or_else(|| b.strip_suffix(".app")).unwrap_or(&b).to_string();
        want.contains(&b)
    }))
}

/// Launcher starten, falls er nicht läuft, und warten, bis er bereit ist
pub async fn ensure_launcher(p: &P, game: &Value, hide_window: bool) -> anyhow::Result<bool> {
    let up = launcher_running(p).await;
    log::info(&format!("[update] Launcher {} {}", p.name(), match up { None => "Zustand unbekannt", Some(true) => "läuft schon", Some(false) => "läuft nicht – wird gestartet" }));
    if up != Some(false) {
        return Ok(false);
    }
    if hide_window {
        let mode = settings::get_str("launcherMode", "hide");
        hide::keep_in_background(p.id(), proc_names(p), 90, if mode == "off" { "hide" } else { &mode });
    }
    let launch = match p.background_update(game).await {
        Some(l) => Some(l),
        None => p.client().await,
    };
    let Some(launch) = launch else { anyhow::bail!(t_args("{0} wurde nicht gefunden.", &[p.name()])) };
    run_launch(Some(&launch), true).await?;
    let until = Instant::now() + Duration::from_secs(60);
    while launcher_running(p).await != Some(true) {
        if Instant::now() >= until {
            anyhow::bail!(t_args("{0} ließ sich nicht starten", &[p.name()]));
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    if p.id() == "steam" && crate::steam::is_connected() {
        let ok = crate::steam::wait_for_this_client(60_000).await;
        log::info(&format!("[update] Steam {}", if ok { "ist bereit (bei deinem Konto angemeldet)" } else { "läuft, ist nach 60 s aber noch nicht angemeldet" }));
        tokio::time::sleep(Duration::from_secs(2)).await;
    } else {
        tokio::time::sleep(Duration::from_secs(12)).await;
    }
    log::info(&format!("[update] Launcher {} gestartet und bereit", p.name()));
    Ok(true)
}

/// Bis zu ms warten, ob der Launcher das Update lädt (oder einreiht)
pub async fn wait_for_download(game: &Value, p: &P, ms: u64) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    let id = game["nativeId"].as_str().unwrap_or("");
    while Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let Some(list) = p.updates().await else { return false };
        if list.iter().any(|u| u["nativeId"] == id && matches!(u["update"]["state"].as_str(), Some("downloading") | Some("queued"))) {
            return true;
        }
    }
    false
}

/// Neuinstallation: Launcher in den Hintergrund, sobald der Download wirklich läuft
fn watch_install_start(game: Value, p: P) {
    if proc_names(&p).is_none() {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(300) {
            if let Some(list) = p.updates().await {
                if list.iter().any(|u| u["nativeId"] == game["nativeId"] && u["update"]["state"] == "downloading") {
                    hide::keep_in_background(p.id(), proc_names(&p), 15, "hide");
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(2500)).await;
        }
    });
}

pub async fn launch_game(game: &Value) -> anyhow::Result<()> {
    let p = provider_of(game)?;
    let installed = game["status"] != "notInstalled";
    let mode = settings::get_str("launcherMode", "hide");
    if installed {
        hide::keep_in_background(p.id(), proc_names(&p), 60, &mode);
    } else {
        // Installieren: Launcher muss laufen und bereit sein, sonst verschluckt er den Installieren-Link
        log::info(&format!("[update] Installation angefordert: {} ({})", game["name"].as_str().unwrap_or(""), p.id()));
        if let Err(e) = ensure_launcher(&p, game, false).await {
            log::warn(&format!("[update] Launcher-Start {e}"));
        }
        if mode != "off" {
            watch_install_start(game.clone(), p.clone());
        }
    }
    run_launch(Some(&game["launch"]), installed && mode != "off").await
}

pub async fn launch(id: &str) -> Value {
    let r = async {
        let game = find_game(id)?;
        if let Some(pid) = running_cached(game["id"].as_str().unwrap_or("")) {
            crate::running::focus(pid);
            return Ok(json!({ "ok": true, "focused": true }));
        }
        launch_game(&game).await?;
        Ok::<_, anyhow::Error>(json!({ "ok": true }))
    }
    .await;
    r.unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

// ---------- Update ----------

/// Läuft gerade ein Spiel, das den Download aufhält? Das Spiel selbst lässt sich nie im laufenden Betrieb
/// aktualisieren; Steam (je nach Einstellung) und Ubisoft Connect pausieren Downloads, solange eines ihrer Spiele läuft.
/// reason: "self" | "steam" (perGame: Einstellung des laufenden Spiels) | "pauses" | "maybe" (unklar, nur ein Hinweis)
async fn download_blocker(p: &P, game: &Value) -> Option<Value> {
    let running = running_games().await;
    if running.is_empty() {
        return None;
    }
    let name = |g: &Value| g["name"].as_str().unwrap_or("").to_string();
    if running.contains_key(game["id"].as_str().unwrap_or("")) {
        return Some(json!({ "reason": "self", "game": name(game) }));
    }
    let games = LAST_SCAN.lock()["games"].as_array().cloned().unwrap_or_default();
    let others: Vec<Value> = games
        .into_iter()
        .filter(|g| g["provider"] == game["provider"] && g["id"] != game["id"] && running.contains_key(g["id"].as_str().unwrap_or("")))
        .collect();
    let first = others.first()?;
    match p.id() {
        "steam" => {
            for o in &others {
                if let Some(per_game) = crate::providers::steam::pauses_downloads_while(o["nativeId"].as_str().unwrap_or("")).await {
                    return Some(json!({ "reason": "steam", "game": name(o), "perGame": per_game }));
                }
            }
            None
        }
        "ubisoft" => Some(json!({ "reason": "pauses", "game": name(first) })),
        _ => Some(json!({ "reason": "maybe", "game": name(first) })),
    }
}

pub async fn update_game(id: &str, visible: bool) -> Value {
    let r = async {
        let game = find_game(id)?;
        let p = provider_of(&game)?;
        let name = game["name"].as_str().unwrap_or("").to_string();
        log::info(&format!("[update] Klick auf Update: {name} ({}, {}) {}", p.id(), game["nativeId"].as_str().unwrap_or(""), if visible { "– Launcher sichtbar öffnen" } else { "– im Hintergrund" }));
        let page = |p: &P, game: &Value| {
            let p = p.clone();
            let game = game.clone();
            async move {
                match p.update_page(&game) {
                    Some(x) => Some(x),
                    None => p.client().await.or_else(|| Some(game["launch"].clone())),
                }
            }
        };
        let blocked = download_blocker(&p, &game).await;
        if let Some(b) = &blocked {
            log::info(&format!("[update] {name}: Download wird aufgehalten – {b}"));
        }
        if visible {
            hide::stop(p.id());
            run_launch(page(&p, &game).await.as_ref(), false).await?;
            return Ok(json!({ "ok": true, "visible": true, "blocked": blocked }));
        }
        // Sicher aufgehalten: Auftrag trotzdem abgeben (der Launcher merkt ihn sich), aber nicht warten und den Launcher
        // nicht mitten ins laufende Spiel holen
        let sure = blocked.as_ref().is_some_and(|b| b["reason"] != "maybe");
        // 1. Launcher muss laufen und bereit sein
        ensure_launcher(&p, &game, true).await?;
        let mode = settings::get_str("launcherMode", "hide");
        hide::keep_in_background(p.id(), proc_names(&p), 60, if mode == "off" { "hide" } else { &mode });

        // 2. Update anstoßen
        let mut steam_error: Option<String> = None;
        if p.id() == "steam" {
            log::info(&format!("[update] Steam-Anmeldung in Ludora: {}", crate::steam::status()));
            match crate::steam::start_update(game["nativeId"].as_str().unwrap_or(""), 20_000).await {
                Ok(ok) => {
                    log::info(&format!("[update] Steam-Fernsteuerung: Auftrag für {} {}", game["nativeId"].as_str().unwrap_or(""), if ok { "angenommen" } else { "nicht angenommen" }));
                    if ok && sure {
                        return Ok(json!({ "ok": true, "visible": false, "blocked": blocked }));
                    }
                    if ok && wait_for_download(&game, &p, p.update_wait_ms()).await {
                        log::info(&format!("[update] {name} lädt"));
                        return Ok(json!({ "ok": true, "visible": false }));
                    }
                    if ok {
                        steam_error = Some(t("Steam hat den Auftrag angenommen, lädt aber nicht"));
                    }
                }
                Err(e) => {
                    log::warn(&format!("[update] Steam-Fernsteuerung {} {e}", game["nativeId"].as_str().unwrap_or("")));
                    steam_error = Some(e.to_string());
                }
            }
        } else {
            if let Some(l) = p.background_update(&game).await {
                run_launch(Some(&l), true).await?;
            }
            if sure {
                return Ok(json!({ "ok": true, "visible": false, "blocked": blocked }));
            }
            if wait_for_download(&game, &p, p.update_wait_ms()).await {
                log::info(&format!("[update] {name} lädt"));
                return Ok(json!({ "ok": true, "visible": false }));
            }
        }
        // 3. Ging nicht – läuft ein Spiel desselben Launchers, liegt es vermutlich daran: Launcher nicht ins Spiel holen
        if blocked.is_some() {
            log::warn(&format!("[update] {name} startet nicht – vermutlich, weil ein Spiel läuft"));
            return Ok(json!({ "ok": true, "visible": false, "blocked": blocked }));
        }
        // Sonst Launcher sichtbar beim Spiel öffnen
        log::warn(&format!("[update] {name} startet nicht von selbst – Launcher wird sichtbar geöffnet {}", steam_error.clone().unwrap_or_default()));
        hide::stop(p.id());
        run_launch(page(&p, &game).await.as_ref(), false).await?;
        Ok::<_, anyhow::Error>(json!({ "ok": true, "visible": true, "fallback": true, "steamError": steam_error }))
    }
    .await;
    r.unwrap_or_else(|e| {
        log::warn(&format!("[update] Fehler {e}"));
        json!({ "ok": false, "error": e.to_string() })
    })
}

/// Pausieren/Fortsetzen: Battle.net direkt, sonst Download-Ansicht des Launchers öffnen
pub async fn manage_download(id: &str) -> Value {
    let r = async {
        let game = find_game(id)?;
        let p = provider_of(&game)?;
        let paused = game["update"]["state"] == "paused";
        let direct = if paused { p.resume_download(&game).await } else { p.pause_download(&game).await };
        if direct == Some(true) {
            return Ok(json!({ "ok": true, "name": p.name(), "silent": true, "action": if paused { "resumed" } else { "paused" } }));
        }
        hide::stop(p.id());
        let launch = match p.downloads_page(&game).await {
            Some(l) => Some(l),
            None => p.client().await,
        };
        let Some(l) = launch else { anyhow::bail!(t_args("{0} wurde nicht gefunden.", &[p.name()])) };
        run_launch(Some(&l), false).await?;
        Ok::<_, anyhow::Error>(json!({ "ok": true, "name": p.name() }))
    }
    .await;
    r.unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

// ---------- Downloads: Tempo und Restzeit ----------

#[derive(Default)]
struct SpeedState {
    samples: HashMap<String, Vec<(Instant, f64, Option<f64>)>>,
    io: HashMap<String, (Vec<(Instant, f64)>, Option<f64>)>,
    io_done: HashMap<String, f64>,
    live: HashMap<String, (f64, f64)>,
}

static SPEED: Lazy<Mutex<SpeedState>> = Lazy::new(|| Mutex::new(SpeedState::default()));

fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Tempo (Bytes/s) und Restzeit (s) ergänzen – aus Launcher-Werten, Byte-Verlauf oder Prozent-Verlauf
fn add_speed(id: &str, u: &Value) -> Value {
    let mut st = SPEED.lock();
    if u["state"] != "downloading" {
        st.samples.remove(id);
        return u.clone();
    }
    let now = Instant::now();
    let list = st.samples.entry(id.to_string()).or_default();
    list.retain(|s| now.duration_since(s.0) < Duration::from_secs(60));
    let done = f(&u["bytesDone"]).unwrap_or(0.0);
    let progress = f(&u["progress"]);
    if let Some(last) = list.last() {
        if done < last.1 || progress.unwrap_or(0.0) < last.2.unwrap_or(0.0) - 0.001 {
            list.clear();
        }
    }
    list.push((now, done, progress));
    let mut out = u.clone();
    let remaining = f(&u["bytesTotal"]).map(|t| (t - done).max(0.0));
    if out["speed"].is_null() && done > 0.0 {
        if let Some(first) = list.iter().find(|s| now.duration_since(s.0) < Duration::from_secs(20)) {
            let dt = now.duration_since(first.0).as_secs_f64();
            if dt >= 2.0 {
                out["speed"] = json!(((done - first.1) / dt).max(0.0));
            }
        }
    }
    if out["eta"].is_null() {
        let sp = f(&out["speed"]).unwrap_or(0.0);
        out["eta"] = if sp > 0.0 && remaining.is_some() {
            json!(remaining.unwrap() / sp)
        } else if let Some(p) = progress {
            match list.iter().find(|s| s.2.is_some()) {
                Some(first) => {
                    let dt = now.duration_since(first.0).as_secs_f64();
                    let dp = p - first.2.unwrap();
                    if dt >= 10.0 && dp > 0.0 { json!((1.0 - p) / dp * dt) } else { Value::Null }
                }
                None => Value::Null,
            }
        } else {
            Value::Null
        };
    }
    out
}

/// Live-Messung der Launcher-Programme (Windows): sekundengenau
fn apply_live(id: &str, u: &Value, speed: f64, total: f64) -> Value {
    let mut st = SPEED.lock();
    let done0 = f(&u["bytesDone"]).unwrap_or(0.0);
    let e = st.live.entry(id.to_string()).or_insert((done0, total));
    let delta = (total - e.1).max(0.0);
    e.1 = total;
    e.0 = (e.0 + delta).max(done0);
    if let Some(t) = f(&u["bytesTotal"]) {
        e.0 = e.0.min(t * 0.995);
    }
    let d = e.0;
    let mut out = u.clone();
    out["speed"] = json!(speed);
    if let Some(o) = out.as_object_mut() {
        o.remove("ioMeasure");
    }
    if let Some(t) = f(&u["bytesTotal"]) {
        out["bytesDone"] = json!(d);
        out["progress"] = json!(f(&u["progress"]).unwrap_or(0.0).max(d / t));
        out["eta"] = if speed > 0.0 { json!((t - d).max(0.0) / speed) } else { Value::Null };
        out["etaUpper"] = json!(false);
    } else if let Some(o) = out.as_object_mut() {
        o.remove("eta");
    }
    out["live"] = json!(true);
    out
}

/// Für Launcher ohne eigenen Fortschritt (Epic): gelesene Bytes der Launcher-Prozesse
async fn measure_io(p: &P) -> Option<(Option<f64>, f64)> {
    let bytes = crate::io::read_io(&proc_names(p)?).await;
    let mut st = SPEED.lock();
    let Some(bytes) = bytes else {
        st.io.remove(p.id());
        return None;
    };
    let now = Instant::now();
    let e = st.io.entry(p.id().to_string()).or_insert((vec![], None));
    let delta = match e.1 { Some(l) if bytes >= l => bytes - l, _ => 0.0 };
    e.1 = Some(bytes);
    e.0.retain(|s| now.duration_since(s.0) < Duration::from_secs(20));
    e.0.push((now, bytes));
    let first = e.0[0];
    let dt = now.duration_since(first.0).as_secs_f64();
    let speed = if dt >= 2.0 { Some(((bytes - first.1) / dt).max(0.0)) } else { None };
    Some((speed, delta))
}

fn apply_io(id: &str, u: &Value, speed: Option<f64>, delta: f64) -> Value {
    let mut st = SPEED.lock();
    let done = st.io_done.get(id).copied().unwrap_or(0.0) + delta;
    st.io_done.insert(id.to_string(), done);
    let mut out = u.clone();
    if let Some(s) = speed.filter(|s| *s > 0.0) {
        out["speed"] = json!(s);
    }
    if let Some(t) = f(&u["bytesTotal"]) {
        let d = done.min(t);
        out["bytesDone"] = json!(d);
        out["progress"] = json!((d / t).min(0.99));
        out["eta"] = match speed { Some(s) if s > 0.0 => json!((t - d).max(0.0) / s), _ => Value::Null };
        out["etaUpper"] = json!(true);
    }
    out
}

pub async fn downloads_status() -> Value {
    let enabled = settings::get("enabledLaunchers").unwrap_or(json!({}));
    let tasks = providers::providers().iter().filter(|&p| enabled[p.id()] != false).cloned().map(|p| {
        tokio::spawn(async move {
            let list = p.updates().await?;
            let downloading: Vec<&Value> = list.iter().filter(|u| u["update"]["state"] == "downloading").collect();
            let need_live = downloading.iter().any(|u| u["update"]["source"] != "Battle.net");
            let mut live = None;
            if need_live && IS_WIN {
                crate::io::keep_alive();
                live = crate::io::rate(p.id());
            }
            let need_io = live.is_none() && list.iter().any(|u| u["update"]["ioMeasure"] == true && u["update"]["state"] == "downloading");
            let io = if need_io { measure_io(&p).await } else { None };
            let live_target = downloading.iter().find(|u| u["update"]["source"] != "Battle.net").map(|u| u["nativeId"].clone());
            let mut out = Map::new();
            for u in &list {
                let native = u["nativeId"].as_str().map(String::from).unwrap_or_else(|| u["nativeId"].to_string());
                let id = format!("{}:{native}", p.id());
                if u["update"]["state"] != "downloading" {
                    SPEED.lock().live.remove(&id);
                }
                let v = match (&live, &io) {
                    (Some((sp, total)), _) if Some(&u["nativeId"]) == live_target.as_ref() => add_speed(&id, &apply_live(&id, &u["update"], *sp, *total)),
                    (_, Some((sp, delta))) if u["update"]["ioMeasure"] == true => apply_io(&id, &u["update"], *sp, *delta),
                    _ => add_speed(&id, &u["update"]),
                };
                out.insert(id, v);
            }
            Some(out)
        })
    });
    let mut result = Map::new();
    for r in futures::future::join_all(tasks).await.into_iter().flatten().flatten() {
        result.extend(r);
    }
    // Im letzten Scan mitführen, damit "Update"-Knöpfe stimmen
    {
        let mut s = LAST_SCAN.lock();
        if let Some(games) = s["games"].as_array_mut() {
            for g in games {
                let id = g["id"].as_str().unwrap_or("").to_string();
                if !g["update"].is_null() || result.contains_key(&id) {
                    g["update"] = result.get(&id).cloned().unwrap_or(Value::Null);
                }
            }
        }
    }
    Value::Object(result)
}

// ---------- Deinstallieren ----------

pub async fn uninstall(app: &AppHandle, id: &str) -> Value {
    let r = async {
        let game = find_game(id)?;
        let p = provider_of(&game)?;
        let name = game["name"].as_str().unwrap_or("").to_string();
        if running_cached(id).is_some() {
            anyhow::bail!(t_args("{0} läuft gerade – bitte erst beenden.", &[&name]));
        }
        let plan = crate::uninstall::plan(&game, &p).await.ok_or_else(|| anyhow::anyhow!(t_args("Für {0} kenne ich keinen Deinstallations-Weg.", &[&name])))?;
        if !crate::dialogs::confirm(app, &t("Deinstallieren"), &format!("{name} deinstallieren?"), plan["detail"].as_str().unwrap_or(""), &t("Deinstallieren")).await {
            return Ok(json!({ "ok": false, "canceled": true }));
        }
        if plan["silent"] == true {
            match crate::uninstall::uninstall_silent(p.id(), &game).await {
                Some(Ok(via)) => {
                    crate::reg::clear_cache();
                    return Ok(json!({ "ok": true, "via": via, "silent": true, "done": true }));
                }
                Some(Err(e)) => return Ok(json!({ "ok": false, "error": t_args("Deinstallieren im Hintergrund nicht möglich: {0}", &[&e.to_string()]) })),
                None => {
                    let page = match p.uninstall_page(&game) { Some(x) => Some(x), None => p.client().await };
                    let Some(page) = page else { anyhow::bail!(t_args("{0} ist nicht erreichbar.", &[p.name()])) };
                    hide::stop(p.id());
                    run_launch(Some(&page), false).await?;
                    return Ok(json!({ "ok": true, "via": p.name(), "page": true }));
                }
            }
        }
        if let Some(q) = plan["quietCommand"].as_str() {
            let code = crate::uninstall::run_hidden(q).await;
            crate::reg::clear_cache();
            if code != 0 {
                return Ok(json!({ "ok": false, "error": t_args("Das Deinstallationsprogramm meldet Fehler {0}.", &[&code.to_string()]) }));
            }
            return Ok(json!({ "ok": true, "via": plan["via"], "silent": true, "done": true }));
        }
        if !plan["launch"].is_null() {
            hide::stop(p.id());
            run_launch(Some(&plan["launch"]), false).await?;
        } else if let Some(c) = plan["command"].as_str() {
            crate::uninstall::run_uninstall_command(c);
        }
        crate::reg::clear_cache();
        Ok::<_, anyhow::Error>(json!({ "ok": true, "via": plan["via"], "page": plan["page"] == true }))
    }
    .await;
    r.unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

// ---------- Eigenes Cover ----------

pub async fn set_cover(app: &AppHandle, id: &str) -> Value {
    let Ok(g) = find_game(id) else { return json!({ "ok": false }) };
    let Some(src) = crate::dialogs::pick_file(app, &crate::util::t_args("Cover für {0} wählen", &[g["name"].as_str().unwrap_or("")]), &[(&t("Bilder"), &["jpg", "jpeg", "png", "webp", "gif", "bmp", "ico"])]).await else {
        return json!({ "ok": false });
    };
    use sha1::Digest;
    let hash = hex::encode(sha1::Sha1::digest(id.as_bytes()));
    let ext = std::path::Path::new(&src).extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default();
    let name = format!("{}{ext}", &hash[..16]);
    let dir = covers::custom_cover_dir();
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::copy(&src, dir.join(&name)).is_err() {
        return json!({ "ok": false });
    }
    let imgs = covers::set_custom(id, &format!("ghimg://custom/{name}?v={}", chrono::Utc::now().timestamp_millis()));
    patch_game(id, &imgs);
    let mut out = imgs;
    out["ok"] = json!(true);
    out
}

pub async fn open_folder(app: &AppHandle, id: &str) -> Value {
    let Ok(g) = find_game(id) else { return json!({ "ok": false, "error": t("Spiel nicht gefunden – bitte Bibliothek neu laden.") }) };
    let Some(dir) = g["installDir"].as_str() else { return json!({ "ok": false, "error": t("Kein Installationsordner bekannt.") }) };
    crate::ipc::open_path(app, dir);
    json!({ "ok": true })
}

pub async fn open_launcher(provider_id: &str, what: &str) -> Value {
    let Some(p) = providers::by_id(provider_id) else { return json!({ "ok": false, "error": t("Unbekannter Launcher") }) };
    if what == "download" {
        let Some(url) = providers::download_url(p.id()) else {
            return json!({ "ok": false, "error": t_args("Für {0} gibt es hier keinen Download.", &[p.name()]) });
        };
        let _ = crate::running::open_with_system(url);
        return json!({ "ok": true });
    }
    hide::stop(p.id());
    let launch = if what == "store" { p.store() } else { p.client().await };
    let Some(l) = launch else { return json!({ "ok": false, "error": t_args("{0} ist nicht installiert.", &[p.name()]) }) };
    match run_launch(Some(&l), false).await {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

pub fn last_providers() -> Vec<Value> {
    LAST_SCAN.lock()["providers"].as_array().cloned().unwrap_or_default()
}

pub fn favorites_games() -> Vec<Value> {
    let ids: Vec<String> = settings::get("favorites").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let s = LAST_SCAN.lock();
    let games = s["games"].as_array().cloned().unwrap_or_default();
    let mut out: Vec<Value> = ids.iter().filter_map(|id| games.iter().find(|g| g["id"] == id.as_str()).cloned()).filter(|g| g["status"] != "notInstalled").collect();
    out.sort_by_key(|g| normalize_sort(g["name"].as_str().unwrap_or("")));
    out
}
