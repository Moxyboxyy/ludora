//! Programm-Symbole als PNG (letzte Reserve, wenn ein Spiel kein Cover hat; Launcher-Logos in der Seitenleiste).
//! Windows: Symbol der EXE über die Shell; macOS: .icns aus dem App-Paket über "sips".

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::util::*;

static GAME_ICONS: Lazy<Mutex<HashMap<String, Option<Vec<u8>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static LAUNCHER_ICONS: Lazy<Mutex<HashMap<String, Option<Vec<u8>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn clear_cache() {
    GAME_ICONS.lock().clear();
}

#[cfg(windows)]
fn file_icon_png(file: &Path) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};
    unsafe {
        let wide: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut info: SHFILEINFOW = std::mem::zeroed();
        if SHGetFileInfoW(wide.as_ptr(), 0, &mut info, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON) == 0 || info.hIcon.is_null() {
            return None;
        }
        let mut ii: ICONINFO = std::mem::zeroed();
        let ok = GetIconInfo(info.hIcon, &mut ii) != 0;
        let mut out = None;
        if ok && !ii.hbmColor.is_null() {
            let mut bm: BITMAP = std::mem::zeroed();
            GetObjectW(ii.hbmColor as _, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut _ as _);
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            if w > 0 && h > 0 {
                let mut bi: BITMAPINFO = std::mem::zeroed();
                bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                bi.bmiHeader.biWidth = w;
                bi.bmiHeader.biHeight = -h; // von oben nach unten
                bi.bmiHeader.biPlanes = 1;
                bi.bmiHeader.biBitCount = 32;
                bi.bmiHeader.biCompression = BI_RGB;
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let dc = GetDC(std::ptr::null_mut());
                let lines = GetDIBits(dc, ii.hbmColor, 0, h as u32, buf.as_mut_ptr() as _, &mut bi, DIB_RGB_COLORS);
                ReleaseDC(std::ptr::null_mut(), dc);
                if lines > 0 {
                    // BGRA -> RGBA; ganz ohne Alpha (alte Symbole): deckend machen
                    let no_alpha = buf.chunks(4).all(|p| p[3] == 0);
                    for p in buf.chunks_mut(4) {
                        p.swap(0, 2);
                        if no_alpha {
                            p[3] = 255;
                        }
                    }
                    out = encode_png(&buf, w as u32, h as u32);
                }
            }
        }
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor as _);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask as _);
        }
        DestroyIcon(info.hIcon);
        out
    }
}

#[cfg(target_os = "macos")]
fn file_icon_png(file: &Path) -> Option<Vec<u8>> {
    let s = file.to_string_lossy();
    let app = app_bundle(&s).or_else(|| if s.to_lowercase().ends_with(".app") { Some(s.to_string()) } else { None })?;
    let res = Path::new(&app).join("Contents/Resources");
    let plist = Path::new(&app).join("Contents/Info.plist");
    let mut icns: Option<PathBuf> = std::process::Command::new("plutil")
        .args(["-extract", "CFBundleIconFile", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .map(|n| res.join(if n.to_lowercase().ends_with(".icns") { n } else { format!("{n}.icns") }))
        .filter(|p| p.exists());
    if icns.is_none() {
        let files: Vec<String> = std::fs::read_dir(&res).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.to_lowercase().ends_with(".icns")).collect();
        let pick = files.iter().find(|n| Regex::new(r"(?i)^(appicon|icon)\.icns$").unwrap().is_match(n)).or(files.first())?;
        icns = Some(res.join(pick));
    }
    let icns = icns?;
    let dir = crate::paths::data_dir().join("icon-cache");
    let _ = std::fs::create_dir_all(&dir);
    use sha1::Digest;
    let mt = std::fs::metadata(&icns).and_then(|m| m.modified()).map(|t| format!("{t:?}")).unwrap_or_default();
    let key = hex::encode(sha1::Sha1::digest(format!("{}|{mt}", icns.display()).as_bytes()));
    let out = dir.join(format!("{key}.png"));
    if !out.exists() {
        std::process::Command::new("sips").args(["-s", "format", "png", "-Z", "256"]).arg(&icns).arg("--out").arg(&out).output().ok()?;
    }
    std::fs::read(out).ok()
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn file_icon_png(_file: &Path) -> Option<Vec<u8>> {
    None
}

#[allow(dead_code)]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(rgba).ok()?;
    }
    Some(out)
}

static SKIP_EXE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)unins|uninst|crash|report|redist|setup|install|helper|vc_?redist|dxsetup|dotnet|ue4prereq|easyanticheat|battleye|cleanup|touchup|activation|launcherpatcher").unwrap()
});

/// Haupt-EXE raten: größte passende .exe im Ordner (und eine Ebene tiefer in bin/binaries/win64/x64/game)
fn guess_game_exe(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<(PathBuf, u64)> = vec![];
    fn scan(d: &Path, depth: u8, found: &mut Vec<(PathBuf, u64)>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let sub = Regex::new(r"(?i)^(bin|binaries|win64|x64|game)$").unwrap();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_file() && name.to_lowercase().ends_with(".exe") && !SKIP_EXE.is_match(&name) {
                found.push((e.path(), e.metadata().map(|m| m.len()).unwrap_or(0)));
            } else if ft.is_dir() && depth < 1 && sub.is_match(&name) {
                scan(&e.path(), depth + 1, found);
            }
        }
    }
    scan(dir, 0, &mut found);
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.into_iter().next().map(|x| x.0)
}

/// Symbol eines Spiels (PNG)
pub async fn game_icon(id: &str) -> Option<Vec<u8>> {
    if let Some(v) = GAME_ICONS.lock().get(id) {
        return v.clone();
    }
    let g = crate::library::find_game(id).ok();
    let id2 = id.to_string();
    let png = tokio::task::spawn_blocking(move || {
        let g = g?;
        let target = g["launch"]["target"].as_str().unwrap_or("");
        let bad = Regex::new(r"(?i)battle\.net|galaxyclient|launcher\.exe|steam\.exe").unwrap();
        let mut file: Option<PathBuf> = None;
        if g["launch"]["type"] == "exe" && target.to_lowercase().ends_with(".exe") && g["provider"] != "riot" && !bad.is_match(target) {
            file = Some(PathBuf::from(target));
        }
        let dir = g["installDir"].as_str().map(PathBuf::from);
        if file.is_none() && IS_MAC {
            if let Some(d) = &dir {
                file = app_bundle(&d.to_string_lossy()).map(PathBuf::from).or_else(|| {
                    std::fs::read_dir(d).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().map_or(false, |x| x == "app"))
                });
            }
        }
        if file.is_none() && !IS_MAC {
            file = dir.as_deref().and_then(guess_game_exe);
        }
        file_icon_png(&file?)
    })
    .await
    .ok()
    .flatten();
    GAME_ICONS.lock().insert(id2, png.clone());
    png
}

/// Programm-Symbol eines Launchers (Seitenleiste)
pub async fn launcher_icon(id: &str) -> Option<Vec<u8>> {
    if let Some(v) = LAUNCHER_ICONS.lock().get(id) {
        return v.clone();
    }
    let p = crate::providers::by_id(id)?;
    let launch = p.client().await;
    let png = match launch {
        Some(l) if l["type"] == "exe" => {
            let f = PathBuf::from(l["target"].as_str().unwrap_or(""));
            if f.exists() {
                tokio::task::spawn_blocking(move || file_icon_png(&f)).await.ok().flatten()
            } else {
                None
            }
        }
        _ => None,
    };
    LAUNCHER_ICONS.lock().insert(id.to_string(), png.clone());
    png
}
