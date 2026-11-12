//! Eigene Launcher (custom-launchers.json im Datenordner): Name, optional das Launcher-Programm und ein
//! Spieleordner. Spiele kommen aus dem Ordner (jeder Unterordner = ein Spiel) und aus den eigenen Spielen,
//! die diesem Launcher zugeordnet sind. Keine Freundesliste, keine Updates – nur der Launcher mit seinen Spielen.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{Detected, Provider, P};
use crate::util::*;

fn store_file() -> PathBuf {
    crate::paths::data_dir().join("custom-launchers.json")
}

pub fn load() -> Vec<Value> {
    std::fs::read_to_string(store_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l["id"].as_str().is_some_and(is_custom_id) && !l["name"].as_str().unwrap_or("").trim().is_empty())
        .collect()
}

fn save(list: &[Value]) {
    let f = store_file();
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, serde_json::to_string_pretty(list).unwrap_or_default());
}

pub fn is_custom_id(id: &str) -> bool {
    crate::re!(r"^x-[0-9a-f]{8}$").is_match(id)
}

/// Neuer Launcher; Fehlertext, wenn etwas nicht passt
pub fn add(name: &str, exe: &str, folder: &str) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(t("Bitte einen Namen eingeben."));
    }
    if name.chars().count() > 40 {
        return Err(t("Der Name ist zu lang (höchstens 40 Zeichen)."));
    }
    if exe.is_empty() && folder.is_empty() {
        return Err(t("Wähle das Programm des Launchers oder einen Spieleordner (oder beides)."));
    }
    if !folder.is_empty() && !Path::new(folder).is_dir() {
        return Err(t("Der Spieleordner wurde nicht gefunden."));
    }
    let mut list = load();
    if list.iter().any(|l| l["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))) {
        return Err(t_args("Einen Launcher „{0}“ gibt es schon.", &[name]));
    }
    let id = format!("x-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let entry = json!({ "id": id, "name": name, "exe": exe, "folder": folder });
    list.push(entry.clone());
    save(&list);
    Ok(entry)
}

/// Launcher entfernen; seine einzeln hinzugefügten Spiele wandern zu „Eigene Spiele“
pub fn remove(id: &str) {
    save(&load().into_iter().filter(|l| l["id"] != id).collect::<Vec<_>>());
    super::manual::reassign(id, "manual");
}

/// Farbe aus dem Namen (damit jeder eigene Launcher seine eigene Plakette hat)
fn accent_of(id: &str) -> String {
    const COLORS: [&str; 8] = ["#7c9cff", "#ff9f6b", "#6be3a1", "#ffc857", "#d78bff", "#5fd3e8", "#ff7aa2", "#a6e36b"];
    let n = id.bytes().fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize));
    COLORS[n % COLORS.len()].to_string()
}

pub struct Custom {
    id: String,
    name: String,
    exe: String,
    folder: String,
    accent: String,
}

pub fn providers() -> Vec<P> {
    load()
        .into_iter()
        .map(|l| {
            let id = l["id"].as_str().unwrap_or("").to_string();
            Arc::new(Custom {
                accent: accent_of(&id),
                id,
                name: l["name"].as_str().unwrap_or("").trim().to_string(),
                exe: l["exe"].as_str().unwrap_or("").to_string(),
                folder: l["folder"].as_str().unwrap_or("").to_string(),
            }) as P
        })
        .collect()
}

/// Minecraft-Launcher u. ä.: Ordner „instances“/„modpacks“/„profiles“ – jeder Unterordner ist eine Instanz ohne eigene .exe
pub fn is_instances_dir(folder: &Path) -> bool {
    folder.file_name().is_some_and(|n| crate::re!(r"(?i)^(instances|modpacks|profiles)$").is_match(&n.to_string_lossy()))
}

/// Instanzen in einem instances-Ordner: (Ordnername, Anzeigename, Ordner)
pub fn scan_instances(folder: &Path) -> Vec<(String, String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(folder) else { return vec![] };
    let mut out: Vec<(String, String, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let key = e.file_name().to_string_lossy().into_owned();
            if key.starts_with('.') || key.starts_with('_') {
                return None;
            }
            let dir = e.path();
            Some((key.clone(), instance_name(&dir).unwrap_or(key), dir))
        })
        .collect();
    out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    out
}

/// Anzeigename einer Instanz aus den Dateien der bekannten Launcher (Prism/MultiMC, CurseForge, ATLauncher, Modrinth)
fn instance_name(dir: &Path) -> Option<String> {
    if let Ok(t) = std::fs::read_to_string(dir.join("instance.cfg")) {
        if let Some(n) = t.lines().find_map(|l| l.strip_prefix("name=")) {
            return Some(n.trim().to_string()).filter(|n| !n.is_empty());
        }
    }
    for f in ["minecraftinstance.json", "instance.json", "profile.json"] {
        if let Some(v) = std::fs::read_to_string(dir.join(f)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            if let Some(n) = v["name"].as_str().or(v["launcher"]["name"].as_str()).filter(|n| !n.trim().is_empty()) {
                return Some(n.trim().to_string());
            }
        }
    }
    None
}

/// Start einer Instanz: bekannte Launcher können eine Instanz direkt starten, sonst öffnet sich der Launcher
fn instance_launch(launcher_exe: &str, key: &str, name: &str) -> Value {
    let stem = Path::new(launcher_exe).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let cwd = Path::new(launcher_exe).parent().map(|d| d.to_string_lossy().into_owned());
    let args: Vec<String> = if crate::re!(r"prism|multimc|polymc").is_match(&stem) {
        vec!["-l".into(), key.into()]
    } else if stem.contains("atlauncher") {
        vec!["--launch".into(), name.into()]
    } else {
        vec![]
    };
    json!({ "type": "exe", "target": launcher_exe, "args": args, "cwd": cwd })
}

/// Spiele in einem Ordner: jeder Unterordner mit einer passenden Programmdatei (Mac: jedes .app)
pub fn scan_folder(folder: &Path) -> Vec<(String, String, PathBuf, PathBuf)> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(folder) else { return out };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let path = e.path();
        if IS_MAC && name.to_lowercase().ends_with(".app") {
            out.push((name.clone(), name.trim_end_matches(".app").to_string(), path.clone(), folder.to_path_buf()));
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let exe = if IS_MAC {
            std::fs::read_dir(&path).ok().and_then(|r| r.flatten().map(|x| x.path()).find(|p| p.extension().is_some_and(|x| x == "app")))
        } else {
            crate::icons::guess_game_exe(&path).or_else(|| if IS_LINUX { guess_linux_exe(&path) } else { None })
        };
        if let Some(exe) = exe {
            out.push((name.clone(), name, exe, path));
        }
    }
    out
}

/// Kein Spieleordner angegeben: im Launcher selbst nach Spielen suchen – im Programmordner (und eine Ebene
/// darüber) sowie in den Datenordnern mit dem Namen des Launchers (z. B. %APPDATA%\itch\apps), jeweils in
/// typischen Unterordnern wie games, library oder apps.
pub fn auto_folders(exe: &str, name: &str) -> Vec<PathBuf> {
    let exe = Path::new(exe);
    let mut roots: Vec<PathBuf> = vec![];
    if let Some(dir) = exe.parent() {
        roots.push(dir.to_path_buf());
        if let Some(up) = dir.parent() {
            roots.push(up.to_path_buf());
        }
    }
    // Datenordner des Launchers: Ordner, deren Name das Kernwort enthält (z. B. „norisk“ aus „NoRisk Launcher“
    // bzw. noriskclient-launcher-v3.exe) – in AppData, Local und im Benutzerordner
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let keys = key_words(&[name, &stem]);
    let home = crate::util::home();
    for base in [dirs::config_dir(), dirs::data_local_dir(), dirs::data_dir(), Some(home)].into_iter().flatten() {
        let Ok(rd) = std::fs::read_dir(&base) else { continue };
        for e in rd.flatten() {
            let n = squash(&e.file_name().to_string_lossy());
            if e.path().is_dir() && keys.iter().any(|k| n.contains(k.as_str())) {
                roots.push(e.path());
            }
        }
    }
    let sub = crate::re!(r"(?i)^(games?|spiele|library|apps|installed|content|common|steamapps|instances|modpacks|profiles)$");
    // Nicht hineinschauen: Caches, Logs, Browser-Daten der Launcher-Oberfläche …
    let skip = crate::re!(r"(?i)^(\.git|node_modules|cache|caches|.*cache|logs?|ebwebview|webview2?|crashpad|gpucache|assets|libraries|natives|runtimes?|java|jre|meta|temp|tmp|backups?|trash|screenshots|saves|mods|resourcepacks|shaderpacks|config)$");
    let mut out: Vec<PathBuf> = vec![];
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // Bis zu drei Ebenen tief nach passend benannten Ordnern suchen (z. B. norisk/NoRiskClientV3/data/profiles)
        let mut level = vec![root.clone()];
        for _ in 0..3 {
            let mut next = vec![];
            for d in &level {
                let Ok(rd) = std::fs::read_dir(d) else { continue };
                for e in rd.flatten() {
                    let p = e.path();
                    if !p.is_dir() {
                        continue;
                    }
                    let n = e.file_name().to_string_lossy().into_owned();
                    if sub.is_match(&n) {
                        if seen.insert(p.clone()) {
                            out.push(p.clone());
                        }
                    } else if !skip.is_match(&n) {
                        next.push(p);
                    }
                }
            }
            level = next.into_iter().take(300).collect();
        }
    }
    out
}

/// Nur Buchstaben und Ziffern, klein („NoRisk Launcher“ -> „noriskclient“ …)
fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Kernwörter aus Name und Programmdatei: ohne allgemeine Wörter wie launcher, client, app, setup, Versionsnummern
fn key_words(names: &[&str]) -> Vec<String> {
    let generic = crate::re!(r"^(launcher|client|app|application|game|games|setup|desktop|beta|win|win64|x64|x86|the|v?\d+)$");
    let mut out: Vec<String> = vec![];
    for n in names {
        for w in crate::re!(r"[A-Za-z0-9]+").find_iter(n) {
            let w = w.as_str().to_lowercase();
            // „noriskclient“ -> zusätzlich ohne die allgemeinen Endungen
            let trimmed = crate::re!(r"(launcher|client|app)+$").replace(&w, "").into_owned();
            for k in [w, trimmed] {
                if k.len() >= 4 && !generic.is_match(&k) && !out.contains(&k) {
                    out.push(k);
                }
            }
        }
    }
    out
}

/// Linux: größte ausführbare Datei (ohne Endung, .x86_64 oder .sh) im Ordner
fn guess_linux_exe(dir: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let ok_ext = crate::re!(r"(?i)^[^.]+$|\.(x86_64|x86|sh|run)$");
        let mut found: Vec<(PathBuf, u64)> = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                let n = e.file_name().to_string_lossy().into_owned();
                (m.is_file() && m.permissions().mode() & 0o111 != 0 && ok_ext.is_match(&n)).then(|| (e.path(), m.len()))
            })
            .collect();
        found.sort_by(|a, b| b.1.cmp(&a.1));
        found.into_iter().next().map(|x| x.0)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

#[async_trait]
impl Provider for Custom {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn color(&self) -> &str {
        "#1d2230"
    }
    fn accent(&self) -> &str {
        &self.accent
    }
    fn platforms(&self) -> &[&str] {
        &["win32", "darwin", "linux"]
    }
    fn has_client(&self) -> bool {
        !self.exe.is_empty()
    }
    async fn client(&self) -> Option<Value> {
        if self.exe.is_empty() {
            return None;
        }
        let dir = Path::new(&self.exe).parent().map(|d| d.to_string_lossy().into_owned());
        Some(json!({ "type": "exe", "target": self.exe, "args": [], "cwd": dir }))
    }

    async fn detect(&self) -> anyhow::Result<Detected> {
        let mut games: Vec<Value> = super::manual::load().iter().filter(|g| g["launcher"] == self.id.as_str()).map(super::manual::to_game).collect();
        // Spieleordner angegeben -> nur der; sonst selbst im Launcher suchen
        let folders: Vec<PathBuf> = if !self.folder.is_empty() {
            let folder = PathBuf::from(&self.folder);
            if !folder.is_dir() {
                return Ok(Detected { games, warning: Some(t_args("Spieleordner nicht gefunden: {0}", &[&self.folder])) });
            }
            vec![folder]
        } else if !self.exe.is_empty() {
            let (exe, name) = (self.exe.clone(), self.name.clone());
            tokio::task::spawn_blocking(move || auto_folders(&exe, &name)).await.unwrap_or_default()
        } else {
            vec![]
        };
        if !folders.is_empty() {
            let launcher_exe = self.exe.to_lowercase();
            // Instanzen (Minecraft-Launcher u. ä.): starten über den Launcher
            let inst_dirs: Vec<PathBuf> = folders.iter().filter(|f| is_instances_dir(f)).cloned().collect();
            let instances = tokio::task::spawn_blocking(move || inst_dirs.iter().flat_map(|f| scan_instances(f)).collect::<Vec<_>>()).await.unwrap_or_default();
            for (key, name, dir) in instances {
                let nid = format!("inst:{key}");
                if self.exe.is_empty() || games.iter().any(|g| g["nativeId"] == nid.as_str()) {
                    continue;
                }
                games.push(json!({
                    "nativeId": nid, "name": name, "installDir": dir.to_string_lossy(),
                    "status": "installed", "covers": [], "instance": true,
                    "launch": instance_launch(&self.exe, &key, &name),
                }));
            }
            let folders: Vec<PathBuf> = folders.into_iter().filter(|f| !is_instances_dir(f)).collect();
            let found = tokio::task::spawn_blocking(move || folders.iter().flat_map(|f| scan_folder(f)).collect::<Vec<_>>()).await.unwrap_or_default();
            for (key, name, exe, dir) in found {
                let exe_s = exe.to_string_lossy().into_owned();
                if games.iter().any(|g| g["launch"]["target"] == exe_s.as_str()) || exe_s.to_lowercase() == launcher_exe {
                    continue; // schon einzeln hinzugefügt bzw. der Launcher selbst
                }
                let nid = format!("dir:{key}");
                if games.iter().any(|g| g["nativeId"] == nid.as_str()) {
                    continue; // gleicher Ordnername in zwei Spieleordnern
                }
                let dir_s = dir.to_string_lossy().into_owned();
                games.push(json!({
                    "nativeId": nid, "name": name, "installDir": dir_s,
                    "status": "installed", "covers": [],
                    "launch": { "type": "exe", "target": exe_s, "args": [], "cwd": dir_s },
                }));
            }
        }
        Ok(games.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_custom_id("x-0a1b2c3d"));
        assert!(!is_custom_id("steam"));
        assert!(!is_custom_id("x-../../a"));
    }

    #[test]
    fn selbst_suchen() {
        let dir = std::env::temp_dir().join(format!("ludora-auto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("MyLauncher").join("apps").join("Spiel Eins")).unwrap();
        std::fs::write(dir.join("MyLauncher").join("launcher.exe"), b"x").unwrap();
        std::fs::write(dir.join("MyLauncher").join("apps").join("Spiel Eins").join("eins.exe"), vec![0u8; 100]).unwrap();
        let f = auto_folders(&dir.join("MyLauncher").join("launcher.exe").to_string_lossy(), "Mein Launcher");
        assert!(f.iter().any(|p| p.ends_with("apps")));
        let games: Vec<_> = f.iter().flat_map(|p| scan_folder(p)).collect();
        assert!(games.iter().any(|g| g.1 == "Spiel Eins"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kernwoerter() {
        let k = key_words(&["NoRisk Launcher", "noriskclient-launcher-v3"]);
        assert!(k.contains(&"norisk".to_string()));
        assert!(!k.iter().any(|w| w == "launcher" || w == "v3"));
    }

    #[test]
    fn norisk_profile() {
        // Aufbau wie beim NoRisk-Launcher: <Daten>/norisk/NoRiskClientV3/data/profiles/<Profil>
        let dir = std::env::temp_dir().join(format!("ludora-nr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let prof = dir.join("norisk").join("NoRiskClientV3").join("data").join("profiles");
        std::fs::create_dir_all(prof.join("Fabric 26.3")).unwrap();
        std::fs::create_dir_all(dir.join("norisk").join("NoRiskClientV3").join("logs")).unwrap();
        let roots = vec![dir.join("norisk")];
        // auto_folders nutzt die echten Datenordner – hier die Suche ab einem Wurzelordner nachstellen
        let sub = |p: &Path| is_instances_dir(p);
        let mut found = vec![];
        let mut level = roots;
        for _ in 0..3 {
            let mut next = vec![];
            for d in &level {
                for e in std::fs::read_dir(d).unwrap().flatten() {
                    if e.path().is_dir() {
                        if sub(&e.path()) { found.push(e.path()); } else { next.push(e.path()); }
                    }
                }
            }
            level = next;
        }
        assert_eq!(found.len(), 1);
        assert_eq!(scan_instances(&found[0])[0].1, "Fabric 26.3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn instanzen() {
        let dir = std::env::temp_dir().join(format!("ludora-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let inst = dir.join("PrismLauncher").join("instances");
        std::fs::create_dir_all(inst.join("1.20.1")).unwrap();
        std::fs::write(inst.join("1.20.1").join("instance.cfg"), "InstanceType=OneSix\nname=Survival mit Freunden\n").unwrap();
        std::fs::create_dir_all(inst.join("_LAUNCHER_TEMP")).unwrap();
        std::fs::write(dir.join("PrismLauncher").join("prismlauncher.exe"), b"x").unwrap();
        let exe = dir.join("PrismLauncher").join("prismlauncher.exe").to_string_lossy().into_owned();
        let found = auto_folders(&exe, "Prism");
        assert!(found.iter().any(|f| is_instances_dir(f)));
        let list = scan_instances(&inst);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].1, "Survival mit Freunden");
        assert_eq!(instance_launch(&exe, &list[0].0, &list[0].1)["args"], json!(["-l", "1.20.1"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ordner() {
        let dir = std::env::temp_dir().join(format!("ludora-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Cool Game")).unwrap();
        std::fs::create_dir_all(dir.join("Leer")).unwrap();
        std::fs::write(dir.join("Cool Game").join("CoolGame.exe"), vec![0u8; 2048]).unwrap();
        std::fs::write(dir.join("Cool Game").join("unins000.exe"), vec![0u8; 9999]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(dir.join("Native")).unwrap();
            let f = dir.join("Native").join("native.x86_64");
            std::fs::write(&f, b"x").unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = scan_folder(&dir);
        let cool = found.iter().find(|f| f.1 == "Cool Game").expect("Spiel gefunden");
        assert!(cool.2.ends_with("CoolGame.exe"));
        assert!(!found.iter().any(|f| f.1 == "Leer"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
