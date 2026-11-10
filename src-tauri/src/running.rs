//! Prozesse und laufende Spiele (entspricht electron/lib/running.js) und das Starten von
//! Programmen/Links (runLaunch in electron/main.js).
//! Die Prozessliste kommt direkt vom System (sysinfo) statt über PowerShell – schneller und sparsamer.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, MAIN_SEPARATOR};
use std::process::Stdio;

use crate::util::*;

#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub exe: String,
}

/// Alle Prozesse mit Programmpfad
pub async fn list_processes() -> Vec<Proc> {
    tokio::task::spawn_blocking(|| {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
        let mut sys = System::new_with_specifics(RefreshKind::new());
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_exe(UpdateKind::Always));
        sys.processes()
            .iter()
            .filter_map(|(pid, p)| Some(Proc { pid: pid.as_u32(), exe: p.exe()?.to_string_lossy().into_owned() }))
            .filter(|p| !p.exe.is_empty())
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Programmname ohne .exe/.app, klein
fn base_name(exe: &str) -> String {
    let b = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    let lower = b.to_lowercase();
    lower.strip_suffix(".exe").or_else(|| lower.strip_suffix(".app")).unwrap_or(&lower).to_string()
}

/// Läuft eines dieser Programme? (Namen ohne .exe)
pub async fn is_process_running(names: &[String]) -> bool {
    let want: Vec<String> = names.iter().map(|n| n.to_lowercase().trim_end_matches(".exe").to_string()).collect();
    list_processes().await.iter().any(|p| want.contains(&base_name(&p.exe)))
}

pub fn norm(p: &str) -> String {
    let mut s = p.replace(['/', '\\'], &MAIN_SEPARATOR.to_string());
    while s.len() > 1 && s.ends_with(MAIN_SEPARATOR) {
        s.pop();
    }
    if IS_WIN {
        s = s.to_lowercase();
    }
    s
}

/// Ordner tief genug (nicht "C:\" oder "/Applications")?
pub fn usable_dir(dir: &str) -> bool {
    if dir.is_empty() {
        return false;
    }
    let n = norm(dir);
    let parts = n.split(['\\', '/']).filter(|x| !x.is_empty()).count();
    parts >= 2 && !matches!(n.to_lowercase().as_str(), "/applications" | "/users/shared")
}

/// Laufende Spiele: gameId -> pid (exclude: Ordner der Launcher selbst)
pub fn detect(games: &[Value], exclude: &[String], procs: &[Proc]) -> HashMap<String, u32> {
    let sep = MAIN_SEPARATOR.to_string();
    let ex: Vec<String> = exclude.iter().filter(|d| !d.is_empty()).map(|d| norm(d)).collect();
    let list: Vec<(u32, String)> = procs
        .iter()
        .map(|p| (p.pid, norm(&p.exe)))
        .filter(|(_, e)| !ex.iter().any(|d| e == d || e.starts_with(&format!("{d}{sep}"))))
        .collect();
    let mut out = HashMap::new();
    for g in games {
        let st = g["status"].as_str().unwrap_or("");
        if st == "notInstalled" || st == "missing" {
            continue;
        }
        let target = g["launch"]["target"].as_str().unwrap_or("");
        let lower = target.to_lowercase();
        let exact = if g["provider"] == "manual" && (lower.ends_with(".exe") || lower.ends_with(".app")) { Some(norm(target)) } else { None };
        let dir = if exact.is_none() && usable_dir(g["installDir"].as_str().unwrap_or("")) { Some(norm(g["installDir"].as_str().unwrap())) } else { None };
        let hit = list.iter().find(|(_, e)| match (&exact, &dir) {
            (Some(x), _) => e == x || e.starts_with(&format!("{x}{sep}")),
            (None, Some(d)) => e.starts_with(&format!("{d}{sep}")),
            _ => false,
        });
        if let (Some((pid, _)), Some(id)) = (hit, g["id"].as_str()) {
            out.insert(id.to_string(), *pid);
        }
    }
    out
}

/// Fenster eines laufenden Spiels nach vorne holen
pub fn focus(pid: u32) {
    if pid == 0 {
        return;
    }
    if IS_WIN {
        let _ = hidden_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &format!("(New-Object -ComObject WScript.Shell).AppActivate({pid}) | Out-Null")])
            .spawn();
    } else if IS_MAC {
        let _ = std::process::Command::new("osascript")
            .args(["-e", &format!("tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true")])
            .spawn();
    }
}

/// Befehl ohne Konsolenfenster (Windows)
pub fn hidden_command(cmd: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Programm abgekoppelt von Ludora starten (läuft weiter, wenn Ludora beendet wird)
pub fn spawn_detached(cmd: &str, args: &[String], cwd: Option<&str>) -> anyhow::Result<()> {
    let mut c = std::process::Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(d) = cwd.filter(|d| !d.is_empty() && Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    c.spawn()?;
    Ok(())
}

/// Link/Datei mit dem zuständigen Programm öffnen (Protokolle wie steam://, Dateien, Webseiten)
pub fn open_with_system(target: &str) -> anyhow::Result<()> {
    if IS_WIN {
        // rundll32 + url.dll öffnet Protokoll-Links ohne Konsolenfenster und ohne Shell-Auswertung
        hidden_command("rundll32.exe").args(["url.dll,FileProtocolHandler", target]).spawn()?;
    } else if IS_MAC {
        std::process::Command::new("open").arg(target).spawn()?;
    } else {
        std::process::Command::new("xdg-open").arg(target).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    }
    Ok(())
}

fn args_of(l: &Value) -> Vec<String> {
    l["args"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Start-Beschreibung ausführen ({ type: exe|uri|url|none, target, args, cwd })
pub async fn run_launch(launch: Option<&Value>, background: bool) -> anyhow::Result<()> {
    let Some(l) = launch.filter(|l| !l.is_null()) else { anyhow::bail!(t("Launcher nicht gefunden.")) };
    let ty = l["type"].as_str().unwrap_or("");
    let target = l["target"].as_str().unwrap_or("");
    if ty == "none" {
        return Ok(());
    }
    if ty == "url" && !target.starts_with("https://") {
        anyhow::bail!(t("Ungültige Adresse"));
    }
    let args = args_of(l);
    let cwd = l["cwd"].as_str().map(String::from).or_else(|| Path::new(target).parent().map(|p| p.to_string_lossy().into_owned()));

    if IS_MAC {
        // "open -g" lässt Programme im Hintergrund
        let mut a: Vec<String> = if background { vec!["-g".into()] } else { vec![] };
        if ty == "url" || ty == "uri" {
            a.push(target.into());
            return spawn_detached("open", &a, None);
        }
        if let Some(bundle) = app_bundle(target) {
            a.push("-a".into());
            a.push(bundle);
            if !args.is_empty() {
                a.push("--args".into());
                a.extend(args);
            }
            return spawn_detached("open", &a, None);
        }
        return spawn_detached(target, &args, cwd.as_deref());
    }
    match ty {
        "url" | "uri" => open_with_system(target),
        "exe" if IS_LINUX && !target.to_lowercase().ends_with(".desktop") => spawn_detached(target, &args, cwd.as_deref()),
        "exe" if !target.to_lowercase().ends_with(".exe") => open_with_system(target), // .lnk, .url, .bat
        "exe" => spawn_detached(target, &args, cwd.as_deref()),
        other => anyhow::bail!("Unbekannter Starttyp: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn laufende_spiele() {
        let sep = MAIN_SEPARATOR;
        let games = vec![
            json!({ "id": "steam:1", "status": "installed", "installDir": format!("{sep}games{sep}hades"), "launch": {} }),
            json!({ "id": "steam:2", "status": "notInstalled", "installDir": format!("{sep}games{sep}x"), "launch": {} }),
        ];
        let procs = vec![
            Proc { pid: 7, exe: format!("{sep}games{sep}hades{sep}Hades.exe") },
            Proc { pid: 8, exe: format!("{sep}games{sep}x{sep}x.exe") },
        ];
        let m = detect(&games, &[], &procs);
        assert_eq!(m.get("steam:1"), Some(&7));
        assert!(!m.contains_key("steam:2"));
        assert!(!usable_dir("C:\\"));
        assert_eq!(base_name(r"C:\Program Files\Steam\steam.exe"), "steam");
    }
}
