//! Selbst-Update aus den GitHub-Releases – nur mit gültiger Ed25519-Signatur (signatures/vX.json,
//! gleicher Schlüssel und gleiches Format wie die Electron-Version).

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tauri::AppHandle;

use crate::friends::{merge, now};
use crate::util::{t, t_args};

const REPO: &str = "Moxyboxyy/ludora";
/// Öffentlicher Schlüssel (Ed25519, roh) – derselbe wie im PEM der Electron-Version
const PUBLIC_KEY_B64: &str = "MCowBQYDK2VwAyEAbG63MKjZGta8GbK8BHMBjubqWbEa9O1ommvKAL5gwiA=";
const CHECK_EVERY: i64 = 15 * 60 * 1000;
pub const MIN_GAP: i64 = 3 * 60 * 1000;

static APP: OnceCell<AppHandle> = OnceCell::new();
static STATE: Lazy<Mutex<Value>> = Lazy::new(|| Mutex::new(json!({ "status": "idle", "current": null, "latest": null, "progress": 0, "error": null, "notes": null, "page": null })));
static RELEASE: Lazy<Mutex<Option<Value>>> = Lazy::new(|| Mutex::new(None));
static SIGNATURES: Lazy<Mutex<Option<Value>>> = Lazy::new(|| Mutex::new(None));
static CHECKING: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));
static LAST_CHECK: AtomicI64 = AtomicI64::new(0);
static ANNOUNCED: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub fn get_state() -> Value {
    STATE.lock().clone()
}

fn status() -> String {
    STATE.lock()["status"].as_str().unwrap_or("").to_string()
}

fn set(patch: Value) {
    let snap = {
        let mut s = STATE.lock();
        merge(&mut s, patch);
        s.clone()
    };
    let Some(app) = APP.get() else { return };
    crate::broadcast(app, "update:state", snap.clone());
    // Neues Update, während Ludora offen ist -> einmal pro Version Bescheid geben
    if snap["status"] == "available" {
        if let Some(latest) = snap["latest"].as_str() {
            let mut a = ANNOUNCED.lock();
            if a.as_deref() != Some(latest) {
                *a = Some(latest.to_string());
                crate::notify(app, &t("Update verfügbar"), &t_args("Ludora {0} ist da – oben rechts klicken zum Aktualisieren.", &[latest]));
            }
        }
    }
}

fn public_key() -> Option<ed25519_dalek::VerifyingKey> {
    use base64::Engine;
    let der = base64::engine::general_purpose::STANDARD.decode(PUBLIC_KEY_B64).ok()?;
    let raw: [u8; 32] = der.get(der.len().checked_sub(32)?..)?.try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&raw).ok()
}

/// Geprüfte Prüfsumme einer Datei aus signatures/<tag>.json (None = nicht/falsch signiert)
pub fn verified_sha(sigs: &Value, tag: &str, name: &str) -> Option<String> {
    use base64::Engine;
    if sigs["tag"].as_str() != Some(tag) {
        return None;
    }
    let e = &sigs["files"][name];
    let sha = e["sha256"].as_str()?;
    if sha.len() != 64 || !sha.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return None;
    }
    let sig = base64::engine::general_purpose::STANDARD.decode(e["sig"].as_str()?).ok()?;
    let sig = ed25519_dalek::Signature::from_slice(&sig).ok()?;
    let msg = format!("ludora-update\n{tag}\n{name}\n{sha}");
    public_key()?.verify_strict(msg.as_bytes(), &sig).ok()?;
    Some(sha.to_string())
}

/// Ist Version a neuer als b? (1.2.3 > 1.2.3-beta)
pub fn newer(a: &str, b: &str) -> bool {
    let p = |v: &str| {
        let v = v.trim_start_matches('v');
        let (m, pre) = v.split_once('-').map(|(m, p)| (m.to_string(), Some(p.to_string()))).unwrap_or((v.to_string(), None));
        (m.split('.').map(|x| x.parse::<i64>().unwrap_or(0)).collect::<Vec<_>>(), pre)
    };
    let (na, pa) = p(a);
    let (nb, pb) = p(b);
    for i in 0..3 {
        let (x, y) = (na.get(i).copied().unwrap_or(0), nb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    pa.is_none() && pb.is_some()
}

fn linux_kind() -> &'static str {
    if std::env::var("APPIMAGE").is_ok() {
        return "appimage";
    }
    if Path::new("/usr/bin/dpkg").exists() {
        "deb"
    } else {
        "appimage"
    }
}

fn platform() -> &'static str {
    crate::ipc::platform()
}

/// Passende Datei im Release (gleiche Regeln wie die Electron-Version)
pub fn pick_asset(assets: &[Value], platform: &str, arch: &str, kind: &str) -> Option<Value> {
    let files: Vec<&Value> = assets.iter().filter(|a| a["name"].as_str().map_or(false, |n| !n.ends_with(".blockmap") && !n.ends_with(".yml") && !n.ends_with(".sig"))).collect();
    let find = |re: &str| {
        let r = regex::Regex::new(re).unwrap();
        files.iter().find(|a| r.is_match(a["name"].as_str().unwrap_or(""))).map(|a| (*a).clone())
    };
    match platform {
        "win32" => find(r"(?i)setup.*\.exe$").or_else(|| find(r"(?i)\.exe$")),
        "darwin" => {
            let a = if arch == "arm64" { "arm64" } else { "x64" };
            find(&format!(r"(?i){a}[^/]*\.zip$")).or_else(|| find(&format!(r"(?i){}[^/]*\.zip$", if a == "arm64" { "AppleSilicon" } else { "Intel" })))
        }
        "linux" => {
            if kind == "deb" {
                find(r"(?i)amd64\.deb$")
            } else {
                find(r"(?i)x86_64\.AppImage$")
            }
        }
        _ => None,
    }
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn version() -> String {
    APP.get().map(|a| a.package_info().version.to_string()).unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

pub fn poke(min_gap: i64) {
    let st = status();
    if APP.get().is_none() || st == "downloading" || st == "installing" {
        return;
    }
    if now() - LAST_CHECK.load(Ordering::SeqCst) < min_gap {
        return;
    }
    tauri::async_runtime::spawn(async {
        check().await;
    });
}

pub async fn check() -> Value {
    let _g = CHECKING.lock().await;
    LAST_CHECK.store(now(), Ordering::SeqCst);
    let st = status();
    let keep = ["downloading", "installing", "available"].contains(&st.as_str());
    let ver = version();
    if !keep {
        set(json!({ "status": "checking", "current": ver, "error": null }));
    }
    let res: anyhow::Result<()> = async {
        let r = crate::net::client()
            .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
            .header("accept", "application/vnd.github+json")
            .header("user-agent", format!("Ludora/{ver}"))
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if !r.status().is_success() {
            anyhow::bail!("GitHub {}", r.status().as_u16());
        }
        let j: Value = r.json().await?;
        let tag = j["tag_name"].as_str().unwrap_or("").to_string();
        let latest = tag.trim_start_matches('v').to_string();
        let mut signed = false;
        if !latest.is_empty() && newer(&latest, &ver) {
            let asset = pick_asset(j["assets"].as_array().map(|a| a.as_slice()).unwrap_or(&[]), platform(), arch(), linux_kind());
            let sigs = async {
                let r = crate::net::client()
                    .get(format!("https://raw.githubusercontent.com/{REPO}/main/signatures/{}.json", crate::net::enc(&tag)))
                    .header("user-agent", format!("Ludora/{ver}"))
                    .header("cache-control", "no-cache")
                    .timeout(Duration::from_secs(20))
                    .send()
                    .await
                    .ok()?;
                if !r.status().is_success() {
                    return None;
                }
                r.json::<Value>().await.ok()
            }
            .await;
            signed = match (&asset, &sigs) {
                (Some(a), Some(s)) => verified_sha(s, &tag, a["name"].as_str().unwrap_or("")).is_some(),
                _ => false,
            };
            *SIGNATURES.lock() = sigs;
        }
        let busy = { let s = status(); s == "downloading" || s == "installing" };
        if signed {
            *RELEASE.lock() = Some(j.clone());
            set(json!({ "status": if busy { status() } else { "available".into() }, "latest": latest, "notes": j["body"], "page": j["html_url"], "error": null }));
        } else if !busy {
            *RELEASE.lock() = None;
            set(json!({ "status": "none", "latest": if latest.is_empty() { Value::Null } else { json!(latest) }, "page": j["html_url"] }));
        }
        Ok(())
    }
    .await;
    if let Err(e) = res {
        if status() == "checking" {
            set(json!({ "status": "idle", "error": e.to_string() }));
        }
    }
    get_state()
}

async fn download(asset: &Value, file: &Path) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let url = asset["browser_download_url"].as_str().unwrap_or("");
    let mut r = crate::net::client().get(url).header("user-agent", "Ludora").send().await?;
    if !r.status().is_success() {
        anyhow::bail!("Download {}", r.status().as_u16());
    }
    let total = r.content_length().or(asset["size"].as_u64()).unwrap_or(0);
    let mut out = tokio::fs::File::create(file).await?;
    let mut done = 0u64;
    let mut last = 0i64;
    while let Some(chunk) = r.chunk().await? {
        out.write_all(&chunk).await?;
        done += chunk.len() as u64;
        if total > 0 && now() - last > 250 {
            last = now();
            set(json!({ "progress": done as f64 / total as f64 }));
        }
    }
    out.flush().await?;
    drop(out);
    if let Some(size) = asset["size"].as_u64() {
        if std::fs::metadata(file)?.len() != size {
            anyhow::bail!("Download unvollständig");
        }
    }
    set(json!({ "progress": 1 }));
    Ok(())
}

fn q(x: &str) -> String {
    format!("\"{}\"", x.replace('"', ""))
}

/// Skript, das wartet, bis Ludora beendet ist, dann installiert und neu startet
pub fn restart_script(platform: &str, pid: u32, install: &[String], start: &str) -> String {
    if platform == "win32" {
        let mut l: Vec<String> = vec![
            "@echo off".into(),
            "setlocal".into(),
            "set /a n=0".into(),
            ":wait".into(),
            format!("tasklist /FI \"PID eq {pid}\" /NH 2>NUL | find \" {pid} \" >NUL"),
            "if errorlevel 1 goto go".into(),
            "set /a n+=1".into(),
            format!("if %n% GEQ 60 (taskkill /F /PID {pid} >NUL 2>&1 & ping -n 3 127.0.0.1 >NUL & goto go)"),
            "ping -n 2 127.0.0.1 >NUL".into(),
            "goto wait".into(),
            ":go".into(),
            "ping -n 2 127.0.0.1 >NUL".into(),
        ];
        l.extend(install.iter().cloned());
        l.push(start.into());
        l.push(String::new());
        return l.join("\r\n");
    }
    let mut l: Vec<String> = vec![
        "#!/bin/sh".into(),
        "n=0".into(),
        format!("while kill -0 {pid} 2>/dev/null; do"),
        "  n=$((n+1))".into(),
        format!("  if [ $n -ge 120 ]; then kill -9 {pid} 2>/dev/null; sleep 1; break; fi"),
        "  sleep 0.5".into(),
        "done".into(),
        "sleep 1".into(),
    ];
    l.extend(install.iter().cloned());
    l.push(start.into());
    l.push(String::new());
    l.join("\n")
}

fn run_restart(dir: &Path, platform: &str, install: &[String], start: &str) -> anyhow::Result<()> {
    let win = platform == "win32";
    let script = dir.join(if win { "update.cmd" } else { "update.sh" });
    std::fs::write(&script, restart_script(platform, std::process::id(), install, start))?;
    if win {
        crate::running::spawn_detached("cmd.exe", &["/d".into(), "/c".into(), script.to_string_lossy().to_string()], None)?;
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
        }
        crate::running::spawn_detached("/bin/sh", &[script.to_string_lossy().to_string()], None)?;
    }
    Ok(())
}

fn leave() {
    let Some(app) = APP.get().cloned() else { return };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        crate::quit(&app);
    });
}

fn open_page(url: &str) {
    if let Some(app) = APP.get() {
        crate::ipc::open_url(app, url);
    }
}

pub async fn install() -> Value {
    if status() != "available" {
        return json!({ "ok": false });
    }
    if RELEASE.lock().is_none() {
        check().await;
    }
    let Some(rel) = RELEASE.lock().clone() else { return json!({ "ok": false, "error": "none" }) };
    let page = rel["html_url"].as_str().unwrap_or("").to_string();
    if cfg!(debug_assertions) {
        open_page(&page);
        return json!({ "ok": true, "page": true });
    }
    let kind = linux_kind();
    let Some(asset) = pick_asset(rel["assets"].as_array().map(|a| a.as_slice()).unwrap_or(&[]), platform(), arch(), kind) else {
        open_page(&page);
        return json!({ "ok": true, "page": true });
    };
    let name = asset["name"].as_str().unwrap_or("update").to_string();
    let dir = std::env::temp_dir().join(format!("ludora-update-{}", hex::encode(rand::random::<[u8; 6]>())));
    let file = dir.join(&name);
    let res: anyhow::Result<Value> = async {
        std::fs::create_dir_all(&dir)?;
        set(json!({ "status": "downloading", "progress": 0, "error": null }));
        let tag = rel["tag_name"].as_str().unwrap_or("");
        let expected = SIGNATURES.lock().as_ref().and_then(|s| verified_sha(s, tag, &name)).ok_or_else(|| anyhow::anyhow!("Update ist nicht signiert – aus Sicherheitsgründen nicht installiert"))?;
        download(&asset, &file).await?;
        let actual = {
            use sha2::Digest;
            let f = file.clone();
            tokio::task::spawn_blocking(move || std::fs::read(f).map(|b| hex::encode(sha2::Sha256::digest(&b)))).await??
        };
        if actual != expected {
            let _ = std::fs::remove_dir_all(&dir);
            anyhow::bail!("Prüfsumme stimmt nicht – Download verworfen");
        }
        set(json!({ "status": "installing" }));
        let exe = std::env::current_exe()?;
        let exe_s = exe.to_string_lossy().to_string();
        match platform() {
            "win32" => {
                run_restart(&dir, "win32", &[format!("start \"\" /wait {} /S --updated", q(&file.to_string_lossy()))], &format!("start \"\" {} --after-update", q(&exe_s)))?;
                leave();
                Ok(json!({ "ok": true }))
            }
            "darwin" => {
                let unpack = dir.join("app");
                std::fs::create_dir_all(&unpack)?;
                let ok = std::process::Command::new("/usr/bin/ditto").arg("-xk").arg(&file).arg(&unpack).status().map(|s| s.success()).unwrap_or(false);
                if !ok {
                    anyhow::bail!("Entpacken fehlgeschlagen");
                }
                let new_app = std::fs::read_dir(&unpack)?.flatten().map(|e| e.path()).find(|p| p.extension().map_or(false, |x| x == "app"));
                // …/Ludora.app/Contents/MacOS/Ludora
                let current: Option<PathBuf> = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).map(|p| p.to_path_buf()).filter(|p| p.extension().map_or(false, |x| x == "app"));
                let (Some(new_app), Some(current)) = (new_app, current) else { anyhow::bail!("App-Paket nicht gefunden") };
                let cur = current.to_string_lossy().to_string();
                run_restart(
                    &dir,
                    "darwin",
                    &[format!("rm -rf {}", q(&cur)), format!("mv {} {}", q(&new_app.to_string_lossy()), q(&cur)), format!("xattr -dr com.apple.quarantine {} 2>/dev/null", q(&cur))],
                    &format!("open -n {} --args --after-update", q(&cur)),
                )?;
                leave();
                Ok(json!({ "ok": true }))
            }
            "linux" if kind == "appimage" && std::env::var("APPIMAGE").is_ok() => {
                let target = std::env::var("APPIMAGE")?;
                let next = format!("{target}.new");
                std::fs::copy(&file, &next)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755))?;
                }
                std::fs::rename(&next, &target)?;
                run_restart(&dir, "linux", &[], &format!("{} --after-update >/dev/null 2>&1 &", q(&target)))?;
                leave();
                Ok(json!({ "ok": true }))
            }
            "linux" => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644));
                }
                let ok = Path::new("/usr/bin/pkexec").exists()
                    && tokio::process::Command::new("/usr/bin/pkexec").args(["/usr/bin/apt-get", "install", "-y"]).arg(&file).status().await.map(|s| s.success()).unwrap_or(false);
                if ok {
                    run_restart(&dir, "linux", &[], &format!("{} --after-update >/dev/null 2>&1 &", q(&exe_s)))?;
                    leave();
                    return Ok(json!({ "ok": true }));
                }
                if let Some(app) = APP.get() {
                    crate::ipc::open_path(app, &file.to_string_lossy());
                }
                set(json!({ "status": "available" }));
                Ok(json!({ "ok": true, "manual": true }))
            }
            _ => {
                open_page(&page);
                Ok(json!({ "ok": true, "page": true }))
            }
        }
    }
    .await;
    match res {
        Ok(v) => v,
        Err(e) => {
            set(json!({ "status": "available", "error": e.to_string() }));
            json!({ "ok": false, "error": e.to_string() })
        }
    }
}

pub fn init(app: AppHandle) {
    let ver = app.package_info().version.to_string();
    let _ = APP.set(app);
    set(json!({ "current": ver }));
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_secs(8)).await;
        check().await;
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            poke(CHECK_EVERY - 30_000);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(newer("0.8.0", "0.7.10"));
        assert!(!newer("0.7.10", "0.7.10"));
        assert!(newer("0.7.10", "0.7.10-beta"));
        assert!(!newer("0.7.9", "0.7.10"));
    }
    #[test]
    fn assets() {
        let a = vec![json!({ "name": "Ludora_0.8.0_x64-setup.exe" }), json!({ "name": "Ludora-0.8.0-arm64.zip" }), json!({ "name": "Ludora-0.8.0-x86_64.AppImage" }), json!({ "name": "ludora_0.8.0_amd64.deb" })];
        assert_eq!(pick_asset(&a, "win32", "x64", "").unwrap()["name"], "Ludora_0.8.0_x64-setup.exe");
        assert_eq!(pick_asset(&a, "darwin", "arm64", "").unwrap()["name"], "Ludora-0.8.0-arm64.zip");
        assert_eq!(pick_asset(&a, "linux", "x64", "deb").unwrap()["name"], "ludora_0.8.0_amd64.deb");
        assert_eq!(pick_asset(&a, "linux", "x64", "appimage").unwrap()["name"], "Ludora-0.8.0-x86_64.AppImage");
    }
    #[test]
    fn real_signature_verifies() {
        // Echte Signatur aus dem Repo (v0.7.10) muss mit dem eingebauten Schlüssel passen
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../signatures/v0.7.10.json")).unwrap();
        let s: Value = serde_json::from_str(&text).unwrap();
        let name = s["files"].as_object().unwrap().keys().next().unwrap().clone();
        assert!(verified_sha(&s, "v0.7.10", &name).is_some());
        assert!(verified_sha(&s, "v0.7.9", &name).is_none());
    }
}
