//! Launcher-Fenster im Hintergrund halten (entspricht electron/lib/hide.js).
//! Windows: direkt über user32 (EnumWindows/ShowWindowAsync) statt eines PowerShell-Skripts.
//! macOS: AppleScript über System Events.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

static RUNNING: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Für `seconds` Sekunden alle sichtbaren Fenster dieser Programme ausblenden (mode "hide")
/// bzw. minimieren (mode "minimize"); "off" macht nichts.
pub fn keep_in_background(provider_id: &str, names: Option<Vec<String>>, seconds: u64, mode: &str) {
    let Some(names) = names.filter(|n| !n.is_empty()) else { return };
    if mode == "off" {
        return;
    }
    stop(provider_id);
    let stop_flag = Arc::new(AtomicBool::new(false));
    RUNNING.lock().insert(provider_id.to_string(), stop_flag.clone());
    let hide = mode == "hide";
    let pid = provider_id.to_string();
    std::thread::spawn(move || {
        imp::run(&names, seconds, hide, &stop_flag);
        let mut r = RUNNING.lock();
        if r.get(&pid).map_or(false, |f| Arc::ptr_eq(f, &stop_flag)) {
            r.remove(&pid);
        }
    });
}

/// Beobachtung abbrechen (z. B. wenn der Launcher bewusst geöffnet wird)
pub fn stop(provider_id: &str) {
    if let Some(f) = RUNNING.lock().remove(provider_id) {
        f.store(true, Ordering::Relaxed);
    }
}

pub fn stop_all() {
    for (_, f) in RUNNING.lock().drain() {
        f.store(true, Ordering::Relaxed);
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, ShowWindowAsync, SW_HIDE, SW_MINIMIZE};

    struct Ctx {
        pids: HashSet<u32>,
        hide: bool,
    }

    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        let ctx = &*(l as *const Ctx);
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if ctx.pids.contains(&pid) && IsWindowVisible(h) != 0 && GetWindowTextLengthW(h) > 0 && (ctx.hide || IsIconic(h) == 0) {
            ShowWindowAsync(h, if ctx.hide { SW_HIDE } else { SW_MINIMIZE });
        }
        1
    }

    pub fn run(names: &[String], seconds: u64, hide: bool, stop: &AtomicBool) {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let want: Vec<String> = names.iter().map(|n| format!("{}.exe", n.to_lowercase())).collect();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
        let mut sys = System::new();
        while std::time::Instant::now() < end && !stop.load(Ordering::Relaxed) {
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());
            let pids: HashSet<u32> = sys
                .processes()
                .iter()
                .filter(|(_, p)| want.contains(&p.name().to_string_lossy().to_lowercase()))
                .map(|(pid, _)| pid.as_u32())
                .collect();
            if !pids.is_empty() {
                let ctx = Ctx { pids, hide };
                unsafe {
                    EnumWindows(Some(each), &ctx as *const Ctx as LPARAM);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    pub fn run(names: &[String], seconds: u64, _hide: bool, stop: &AtomicBool) {
        let list = names.iter().map(|n| format!("\"{}\"", n.replace('"', ""))).collect::<Vec<_>>().join(", ");
        let script = format!(
            "tell application \"System Events\"\nrepeat with p in (every application process whose name is in {{{list}}})\nif visible of p then set visible of p to false\nend repeat\nend tell"
        );
        let end = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
        while std::time::Instant::now() < end && !stop.load(Ordering::Relaxed) {
            let _ = std::process::Command::new("osascript").args(["-e", &script]).output();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(all(not(windows), not(target_os = "macos")))]
mod imp {
    use super::*;
    pub fn run(_names: &[String], _seconds: u64, _hide: bool, _stop: &AtomicBool) {}
}
