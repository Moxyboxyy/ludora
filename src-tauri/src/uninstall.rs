//! Deinstallieren (entspricht electron/lib/silentUninstall.js und uninstallPlan in main.js).

use regex::Regex;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use crate::providers::{self, P};
use crate::running::{hidden_command, is_process_running, spawn_detached};
use crate::util::*;

async fn wait_gone(names: &[String], ms: u64) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end {
        if !is_process_running(names).await {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    false
}

/// dir liegt wirklich in parent (nicht parent selbst, kein "..")
pub fn inside_safe(dir: &Path, parent: &Path) -> bool {
    let Ok(rel) = dir.strip_prefix(parent) else { return false };
    let parts: Vec<_> = rel.components().collect();
    !parts.is_empty() && !parts.iter().any(|c| matches!(c, Component::ParentDir))
}

/// Mindestens Laufwerk + 2 Ordner (E:\Spiele\Fortnite, nicht E:\Spiele)
pub fn deep_enough(dir: &Path) -> bool {
    dir.components().filter(|c| matches!(c, Component::Normal(_))).count() >= 2
}

async fn remove_dir(dir: &Path) -> std::io::Result<()> {
    for i in 0..3 {
        match tokio::fs::remove_dir_all(dir).await {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) if i == 2 => return Err(e),
            Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
    Ok(())
}

/// Steam: Manifest entfernen (Steam dafür kurz unsichtbar beenden), dann Ordner löschen
async fn steam_uninstall(game: &Value) -> anyhow::Result<String> {
    use providers::steam;
    let id = game["nativeId"].as_str().unwrap_or("");
    let sp = steam::find_steam_path().await.ok_or_else(|| anyhow::anyhow!(t("Steam-Ordner nicht gefunden.")))?;
    let mut found = None;
    for lib in steam::library_folders(&sp).await {
        let f = lib.join(format!("appmanifest_{id}.acf"));
        if f.exists() {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            let dir = Regex::new(r#"(?i)"installdir"\s+"([^"]+)""#).unwrap().captures(&text).map(|c| c[1].to_string());
            found = Some((f, lib, dir));
            break;
        }
    }
    let (manifest, lib, installdir) = found.ok_or_else(|| anyhow::anyhow!(t("Steam kennt das Spiel nicht mehr als installiert.")))?;
    let common = lib.join("common");
    let game_dir = installdir.map(|d| common.join(d));
    if let Some(d) = &game_dir {
        if !inside_safe(d, &common) {
            anyhow::bail!(t("Unerwarteter Spielordner – abgebrochen."));
        }
    }
    let names: Vec<String> = if IS_MAC { vec!["steam_osx".into(), "Steam".into()] } else { vec!["steam".into()] };
    let was_running = is_process_running(&names).await;
    if was_running {
        if IS_MAC {
            let _ = spawn_detached("osascript", &["-e".into(), "quit app \"Steam\"".into()], None);
        } else if let Some(exe) = steam::find_steam_exe().await {
            let _ = spawn_detached(&exe.to_string_lossy(), &["-shutdown".into()], None);
        }
        if !wait_gone(&names, 45_000).await {
            anyhow::bail!(t("Steam ließ sich nicht im Hintergrund beenden."));
        }
    }
    let _ = std::fs::remove_file(&manifest);
    for extra in [lib.join("downloading").join(id), lib.join("temp").join(id)] {
        if inside_safe(&extra, &lib) {
            let _ = remove_dir(&extra).await;
        }
    }
    if was_running {
        let exe = steam::find_steam_exe().await;
        if IS_MAC {
            let _ = spawn_detached("open", &["-g".into(), "-a".into(), exe.map(|e| e.to_string_lossy().into_owned()).unwrap_or("Steam".into())], None);
        } else if let Some(e) = exe {
            let _ = spawn_detached(&e.to_string_lossy(), &["-silent".into()], None);
        }
    }
    if let Some(d) = game_dir {
        remove_dir(&d).await?;
    }
    Ok("Steam".into())
}

/// Epic (Windows): Manifeste + LauncherInstalled.dat bereinigen, Ordner löschen
async fn epic_uninstall(game: &Value) -> anyhow::Result<String> {
    let id = game["nativeId"].as_str().unwrap_or("");
    let man = providers::epic::epic_data_dir().join("Manifests");
    let mut items: Vec<(PathBuf, Value)> = vec![];
    for sub in ["", "Pending"] {
        let d = if sub.is_empty() { man.clone() } else { man.join(sub) };
        for f in list_dir(&d).await.into_iter().filter(|f| f.to_lowercase().ends_with(".item")) {
            if let Some(m) = read_json(d.join(&f)).await {
                if m["AppName"] == id || m["MainGameAppName"] == id {
                    items.push((d.join(&f), m));
                }
            }
        }
    }
    let main = items.iter().find(|(_, m)| m["AppName"] == id).ok_or_else(|| anyhow::anyhow!(t("Epic kennt das Spiel nicht mehr als installiert.")))?;
    let dir = PathBuf::from(main.1["InstallLocation"].as_str().unwrap_or(""));
    if !deep_enough(&dir) || !dir.join(".egstore").exists() {
        anyhow::bail!(t("Unerwarteter Spielordner – abgebrochen."));
    }
    let names = vec!["EpicGamesLauncher".to_string()];
    let was_running = is_process_running(&names).await;
    if was_running {
        let _ = hidden_command("taskkill").args(["/IM", "EpicGamesLauncher.exe", "/F"]).status();
        if !wait_gone(&names, 20_000).await {
            anyhow::bail!(t("Epic ließ sich nicht im Hintergrund beenden."));
        }
    }
    for (f, _) in &items {
        let _ = std::fs::remove_file(f);
    }
    let pd = { let x = env("PROGRAMDATA"); if x.is_empty() { r"C:\ProgramData".into() } else { x } };
    let dat = PathBuf::from(pd).join(r"Epic\UnrealEngineLauncher\LauncherInstalled.dat");
    if let Some(raw) = read_text(&dat).await {
        if let Ok(mut j) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) {
            let apps: Vec<&Value> = items.iter().map(|(_, m)| &m["AppName"]).collect();
            if let Some(list) = j["InstallationList"].as_array_mut() {
                list.retain(|e| !apps.contains(&&e["AppName"]) && !apps.contains(&&e["ArtifactId"]));
                let mut buf = Vec::new();
                let fmt = serde_json::ser::PrettyFormatter::with_indent(b"\t");
                let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
                let _ = serde::Serialize::serialize(&j, &mut ser);
                let mut out = String::from_utf8(buf).unwrap_or_default();
                if raw.contains("\r\n") {
                    out = out.replace('\n', "\r\n");
                }
                let _ = std::fs::write(&dat, out);
            }
        }
    }
    if was_running {
        if let Some(exe) = providers::epic::find_epic_exe().await {
            let _ = spawn_detached(&exe.to_string_lossy(), &["-silent".into()], None);
        }
    }
    remove_dir(&dir).await?;
    Ok("Epic Games".into())
}

/// Lautlos über den Launcher selbst; Some(Ok(via)) = erledigt
pub async fn uninstall_silent(provider: &str, game: &Value) -> Option<anyhow::Result<String>> {
    match provider {
        "steam" => Some(steam_uninstall(game).await),
        "epic" if IS_WIN => Some(epic_uninstall(game).await),
        _ => None,
    }
}

fn has_silent(provider: &str) -> bool {
    provider == "steam" || (provider == "epic" && IS_WIN)
}

/// Befehl so umbauen, dass das Deinstallationsprogramm ohne Fenster läuft
pub fn silent_command(cmd: &str, quiet: Option<&str>) -> Option<String> {
    if let Some(q) = quiet.filter(|q| !q.is_empty()) {
        return Some(q.to_string());
    }
    let c = cmd.trim();
    if c.is_empty() {
        return None;
    }
    if let Some(m) = Regex::new(r#"(?i)msiexec(?:\.exe)?"?\s+/[IX]\s*(\{[0-9A-F-]+\})"#).unwrap().captures(c) {
        return Some(format!("MsiExec.exe /X{} /qn /norestart", &m[1]));
    }
    let exe = Regex::new(r#"^"([^"]+)""#).unwrap().captures(c).map(|m| m[1].to_string()).unwrap_or_else(|| c.split_whitespace().next().unwrap_or("").to_string()).to_lowercase();
    let base = exe.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    if Regex::new(r"^unins\d{3}\.exe$").unwrap().is_match(&base) {
        return Some(format!("{c} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART"));
    }
    if Regex::new(r"^(uninst|uninstall)[^\\/]*\.exe$").unwrap().is_match(&base) && !Regex::new(r"\s/S(\s|$)").unwrap().is_match(c) {
        return Some(format!("{c} /S"));
    }
    None
}

/// Lautlos ausführen und auf das Ende warten (Exitcode)
pub async fn run_hidden(cmdline: &str) -> i32 {
    let line = format!("\"{cmdline}\"");
    let res = tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            hidden_command("cmd.exe").args(["/d", "/s", "/c"]).raw_arg(line).status()
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("sh").args(["-c", &line]).status()
        }
    })
    .await;
    match res {
        Ok(Ok(s)) => s.code().unwrap_or(0),
        _ => -1,
    }
}

/// Deinstallations-Befehl mit Fenster des Herstellers starten
pub fn run_uninstall_command(cmd: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd.exe").args(["/d", "/s", "/c"]).raw_arg(format!("\"{cmd}\"")).spawn();
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

pub struct Entry {
    pub cmd: String,
    pub quiet: Option<String>,
    pub name: String,
}

pub fn find_uninstall_entry(game: &Value) -> Option<Entry> {
    let dir = game["installDir"].as_str().map(crate::running::norm);
    let name = normalize(game["name"].as_str().unwrap_or(""));
    let mut best = None;
    for e in crate::reg::uninstall_entries() {
        let v = &e.values;
        let (Some(cmd), Some(dn)) = (crate::reg::val_str(v, "UninstallString"), crate::reg::val_str(v, "DisplayName")) else { continue };
        if v.get("SystemComponent").and_then(|x| x.as_u64()) == Some(1) {
            continue;
        }
        let quiet = crate::reg::val_str(v, "QuietUninstallString");
        let loc = crate::reg::val_str(v, "InstallLocation").map(|l| crate::running::norm(&l));
        if let (Some(d), Some(l)) = (&dir, &loc) {
            if d == l {
                return Some(Entry { cmd, quiet, name: dn });
            }
        }
        if best.is_none() && !name.is_empty() && normalize(&dn) == name {
            best = Some(Entry { cmd, quiet, name: dn });
        }
    }
    best
}

/// Wie wird das Spiel deinstalliert? (Reihenfolge wie in der Electron-Version)
pub async fn plan(game: &Value, p: &P) -> Option<Value> {
    let name = p.name().to_string();
    let prov = game["provider"].as_str().unwrap_or("");
    if has_silent(prov) {
        let restart = prov == "steam" || prov == "epic";
        let mut detail = t_args("Ludora entfernt das Spiel im Hintergrund – {0} bleibt unsichtbar.", &[&name]);
        if restart {
            detail += &t_args(" {0} wird dafür kurz im Hintergrund beendet und neu gestartet; laufende Downloads machen danach weiter.", &[&name]);
        }
        detail += &t(" Spielstände in der Cloud bleiben erhalten, lokale Spielstände im Spielordner werden mit gelöscht.");
        return Some(json!({ "silent": true, "via": name, "detail": detail }));
    }
    if IS_WIN {
        if let Some(e) = find_uninstall_entry(game) {
            if let Some(q) = silent_command(&e.cmd, e.quiet.as_deref()) {
                return Some(json!({ "quietCommand": q, "via": e.name, "detail": t_args("Das Deinstallationsprogramm von „{0}“ läuft unsichtbar im Hintergrund. Spielstände in der Cloud bleiben erhalten; lokale Spielstände können verloren gehen.", &[&e.name]) }));
            }
        }
    }
    if let Some(l) = p.uninstall(game) {
        return Some(json!({ "launch": l, "via": name, "detail": t_args("{0} übernimmt die Deinstallation und fragt ggf. noch einmal nach.", &[&name]) }));
    }
    if IS_WIN {
        if let Some(e) = find_uninstall_entry(game) {
            return Some(json!({ "command": e.cmd, "via": e.name, "detail": t_args("Das Deinstallationsprogramm von „{0}“ wird gestartet. Spielstände in der Cloud bleiben erhalten; lokale Spielstände können verloren gehen.", &[&e.name]) }));
        }
    }
    if prov == "manual" {
        return None;
    }
    let page = match p.uninstall_page(game) {
        Some(x) => Some(x),
        None => p.client().await,
    }?;
    Some(json!({ "launch": page, "via": name, "page": true, "detail": t_args("{0} lässt das Deinstallieren nicht von außen zu. Ludora öffnet {1} – dort beim Spiel „Deinstallieren“ wählen.", &[&name, &name]) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn befehle_und_ordner() {
        assert_eq!(silent_command(r#"MsiExec.exe /I{12345678-1234-1234-1234-123456789012}"#, None).unwrap(), "MsiExec.exe /X{12345678-1234-1234-1234-123456789012} /qn /norestart");
        assert!(silent_command(r#""C:\Games\X\unins000.exe""#, None).unwrap().ends_with("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"));
        assert_eq!(silent_command(r"C:\x\uninstall.exe", None).unwrap(), r"C:\x\uninstall.exe /S");
        assert!(silent_command(r"C:\x\game.exe", None).is_none());
        assert!(inside_safe(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(!inside_safe(Path::new("/a/b"), Path::new("/a/b")));
        assert!(deep_enough(Path::new("/spiele/fortnite")));
    }
}
