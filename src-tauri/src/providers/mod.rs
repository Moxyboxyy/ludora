//! Alle Launcher.
//! Spiele und Start-Beschreibungen sind serde_json::Value – exakt das Format, das die Oberfläche kennt.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

use crate::util::{normalize, t};

pub mod amazon;
pub mod battlenet;
pub mod custom;
pub mod ea;
pub mod epic;
pub mod galaxy;
pub mod gog;
pub mod linux;
pub mod manual;
pub mod riot;
pub mod rockstar;
pub mod steam;
pub mod ubisoft;

/// Ergebnis eines Scans eines Launchers
#[derive(Default)]
pub struct Detected {
    pub games: Vec<Value>,
    pub warning: Option<String>,
}

impl From<Vec<Value>> for Detected {
    fn from(games: Vec<Value>) -> Self {
        Detected { games, warning: None }
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn color(&self) -> &str;
    fn accent(&self) -> &str;
    /// Systeme, auf denen es den Launcher gibt (Node-Namen: win32, darwin, linux)
    fn platforms(&self) -> &[&str] {
        &["win32"]
    }
    /// Prozessnamen (ohne .exe) – zum Erkennen, ob der Launcher läuft, und zum Verstecken
    fn processes(&self) -> &[&str] {
        &[]
    }
    fn processes_mac(&self) -> &[&str] {
        &[]
    }
    /// Läuft über ein anderes Programm (Linux: "Heroic", "Lutris")
    fn via(&self) -> Option<&str> {
        None
    }

    async fn detect(&self) -> anyhow::Result<Detected>;

    /// Download-/Update-Zustände: [{ nativeId, update }]; None = kann dieser Launcher nicht
    async fn updates(&self) -> Option<Vec<Value>> {
        None
    }

    fn has_client(&self) -> bool {
        true
    }
    /// Launcher selbst öffnen
    async fn client(&self) -> Option<Value> {
        None
    }
    /// Shop öffnen
    fn store(&self) -> Option<Value> {
        None
    }
    /// Launcher unsichtbar starten bzw. Update anstoßen
    async fn background_update(&self, _game: &Value) -> Option<Value> {
        None
    }
    fn has_background_update(&self) -> bool {
        false
    }
    /// Spielseite im Launcher (Update von Hand anstoßen)
    fn update_page(&self, _game: &Value) -> Option<Value> {
        None
    }
    async fn downloads_page(&self, _game: &Value) -> Option<Value> {
        None
    }
    fn uninstall(&self, _game: &Value) -> Option<Value> {
        None
    }
    fn uninstall_page(&self, _game: &Value) -> Option<Value> {
        None
    }
    fn update_wait_ms(&self) -> u64 {
        25_000
    }
    /// Battle.net: Download direkt beim Dienst anhalten/fortsetzen
    async fn pause_download(&self, _game: &Value) -> Option<bool> {
        None
    }
    async fn resume_download(&self, _game: &Value) -> Option<bool> {
        None
    }
}

pub type P = Arc<dyn Provider>;

fn current_platform() -> &'static str {
    crate::ipc::platform()
}

/// Alle Launcher, die es auf diesem System gibt (Reihenfolge wie in Electron: bei doppelten
/// nicht installierten Spielen gewinnt der erste)
pub fn all() -> Vec<P> {
    let mut list: Vec<P> = vec![
        Arc::new(steam::Steam),
        Arc::new(epic::Epic),
        Arc::new(gog::Gog),
        Arc::new(ea::Ea),
        Arc::new(ubisoft::Ubisoft),
        Arc::new(battlenet::BattleNet),
        Arc::new(amazon::Amazon),
        Arc::new(riot::Riot),
        Arc::new(rockstar::Rockstar),
    ];
    list.extend(linux::providers());
    list.extend(custom::providers());
    list.push(Arc::new(manual::Manual));
    let plat = current_platform();
    list.into_iter().filter(|p| p.platforms().contains(&plat)).collect()
}

// Eigene Launcher können dazukommen oder wegfallen -> Liste lässt sich neu aufbauen
static PROVIDERS: once_cell::sync::Lazy<parking_lot::RwLock<Vec<P>>> = once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(all()));

pub fn providers() -> Vec<P> {
    PROVIDERS.read().clone()
}

/// Nach dem Hinzufügen/Entfernen eines eigenen Launchers
pub fn reload() {
    *PROVIDERS.write() = all();
}

pub fn by_id(id: &str) -> Option<P> {
    PROVIDERS.read().iter().find(|p| p.id() == id).cloned()
}

/// Prozessnamen des Launchers auf diesem System (None = keine bekannt)
pub fn proc_names(p: &P) -> Option<Vec<String>> {
    let names = if crate::util::IS_MAC { p.processes_mac() } else { p.processes() };
    if names.is_empty() { None } else { Some(names.iter().map(|s| s.to_string()).collect()) }
}

/// Download für nicht installierte Launcher (offizielle Quellen, feste Liste)
pub fn download_url(id: &str) -> Option<&'static str> {
    let list: &[(&str, &str)] = match current_platform() {
        "win32" => &[
            ("steam", "https://cdn.akamai.steamstatic.com/client/installer/SteamSetup.exe"),
            ("epic", "https://store.epicgames.com/download"),
            ("gog", "https://webinstallers.gog-statics.com/download/GOG_Galaxy_2.0.exe"),
            ("ea", "https://origin-a.akamaihd.net/EA-Desktop-Client-Download/installer-releases/EAappInstaller.exe"),
            ("ubisoft", "https://ubisoftconnect.com/"),
            ("battlenet", "https://www.battle.net/download/getInstallerForGame?os=win&gameProgram=BATTLENET_APP&version=Live"),
            ("amazon", "https://download.amazongames.com/AmazonGamesSetup.exe"),
            ("riot", "https://www.riotgames.com/"),
            ("rockstar", "https://www.rockstargames.com/downloads"),
        ],
        "darwin" => &[
            ("steam", "https://cdn.akamai.steamstatic.com/client/installer/steam.dmg"),
            ("epic", "https://store.epicgames.com/download"),
            ("gog", "https://www.gog.com/galaxy"),
            ("battlenet", "https://www.battle.net/download/getInstallerForGame?os=mac&gameProgram=BATTLENET_APP&version=Live"),
            ("riot", "https://www.riotgames.com/"),
        ],
        _ => &[
            ("steam", "https://store.steampowered.com/about/"),
            ("epic", "https://heroicgameslauncher.com/downloads"),
            ("gog", "https://heroicgameslauncher.com/downloads"),
            ("amazon", "https://heroicgameslauncher.com/downloads"),
            ("battlenet", "https://lutris.net/downloads"),
            ("ea", "https://lutris.net/downloads"),
            ("ubisoft", "https://lutris.net/downloads"),
            ("rockstar", "https://lutris.net/downloads"),
            ("lutris", "https://lutris.net/downloads"),
        ],
    };
    list.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}

/// Ist das Programm des Launchers installiert? (Start zeigt auf eine Programmdatei, nicht auf eine Webseite)
async fn client_installed(p: &P) -> bool {
    match p.client().await {
        Some(l) => !matches!(l["type"].as_str(), Some("url") | Some("uri")),
        None => false,
    }
}

/// Alle eingeschalteten Launcher parallel durchsuchen; fällt einer aus, laufen die anderen weiter
pub async fn scan_all(enabled: &serde_json::Map<String, Value>) -> Value {
    crate::reg::clear_cache();
    galaxy::clear_cache();
    linux::clear_cache();
    let started = std::time::Instant::now();

    let tasks = providers().into_iter().map(|p| {
        let on = enabled.get(p.id()).and_then(|v| v.as_bool()) != Some(false);
        tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            if !on {
                return (p, Vec::new(), true, None, 0u128, true);
            }
            match p.detect().await {
                Ok(d) => {
                    let client = if d.games.is_empty() { client_installed(&p).await } else { true };
                    (p, d.games, client, d.warning, t0.elapsed().as_millis(), false)
                }
                Err(e) => {
                    crate::log::warn(&format!("[{}] {e}", p.id()));
                    let client = client_installed(&p).await;
                    (p, Vec::new(), client, Some(e.to_string()), t0.elapsed().as_millis(), false)
                }
            }
        })
    });
    let results = futures::future::join_all(tasks).await;

    let mut games: Vec<Value> = Vec::new();
    let mut infos = Vec::new();
    for r in results.into_iter().flatten() {
        let (p, list, client, error, ms, disabled) = r;
        let installed = list.iter().filter(|g| g["status"] != "notInstalled").count();
        infos.push(json!({
            "id": p.id(), "name": t(p.name()), "color": p.color(), "accent": p.accent(),
            "hasClient": p.has_client(), "hasStore": p.store().is_some(),
            "clientInstalled": client, "download": if client { Value::Null } else { json!(download_url(p.id())) },
            "count": list.len(), "installed": installed, "error": error, "ms": ms as u64, "enabled": !disabled,
        }));
        for mut g in list {
            let native = g["nativeId"].as_str().map(String::from).unwrap_or_else(|| g["nativeId"].to_string());
            g["id"] = json!(format!("{}:{}", p.id(), native));
            g["provider"] = json!(p.id());
            games.push(g);
        }
    }

    // Über irgendeinen Launcher installiert -> nicht zusätzlich woanders als "nicht installiert"
    let installed_names: HashSet<String> = games
        .iter()
        .filter(|g| g["status"] != "notInstalled")
        .map(|g| normalize(g["name"].as_str().unwrap_or("")))
        .collect();
    games.retain(|g| g["status"] != "notInstalled" || !installed_names.contains(&normalize(g["name"].as_str().unwrap_or(""))));
    // Nicht installierte Doppelte: den ersten Launcher behalten
    let mut seen = HashSet::new();
    games.retain(|g| g["status"] != "notInstalled" || seen.insert(normalize(g["name"].as_str().unwrap_or(""))));

    games.sort_by(|a, b| {
        let x = crate::util::normalize_sort(a["name"].as_str().unwrap_or(""));
        let y = crate::util::normalize_sort(b["name"].as_str().unwrap_or(""));
        x.cmp(&y)
    });
    json!({
        "games": games,
        "providers": infos,
        "scannedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "totalMs": started.elapsed().as_millis() as u64,
    })
}
