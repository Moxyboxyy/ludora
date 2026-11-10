//! Download-Geschwindigkeit messen (entspricht electron/lib/ioSampler.js + procio.js):
//! empfangene Bytes der Launcher-Programme, jede Sekunde. Läuft nur, solange jemand fragt
//! (stoppt 60 s nach der letzten Abfrage) – direkt über sysinfo statt über PowerShell.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const PROCESSES: [(&str, &[&str]); 9] = [
    ("steam", &["steam"]),
    ("epic", &["EpicGamesLauncher", "EpicOnlineServicesHost"]),
    ("gog", &["GalaxyClient", "GalaxyClientService", "GalaxyCommunication"]),
    ("riot", &["RiotClientServices"]),
    ("ea", &["EABackgroundService", "EADesktop"]),
    ("ubisoft", &["upc", "UbisoftConnect"]),
    ("battlenet", &["Agent"]),
    ("rockstar", &["RockstarService", "Launcher"]),
    ("amazon", &["Amazon Games"]),
];

struct State {
    running: bool,
    last_ask: Instant,
    history: HashMap<&'static str, Vec<(Instant, f64)>>,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(|| Mutex::new(State { running: false, last_ask: Instant::now(), history: HashMap::new() }));

/// Gelesene Bytes (insgesamt, seit Prozessstart) je Launcher
fn sample(sys: &mut sysinfo::System) -> HashMap<&'static str, f64> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_disk_usage());
    let mut by_name: HashMap<String, f64> = HashMap::new();
    for p in sys.processes().values() {
        let n = p.name().to_string_lossy().to_lowercase();
        let n = n.strip_suffix(".exe").unwrap_or(&n).to_string();
        *by_name.entry(n).or_default() += p.disk_usage().total_read_bytes as f64;
    }
    let mut out = HashMap::new();
    for (id, names) in PROCESSES {
        let mut sum = 0.0;
        let mut any = false;
        for n in names {
            if let Some(v) = by_name.get(&n.to_lowercase()) {
                sum += v;
                any = true;
            }
        }
        if any {
            out.insert(id, sum);
        }
    }
    out
}

/// Messung starten bzw. am Laufen halten
pub fn keep_alive() {
    let mut st = STATE.lock();
    st.last_ask = Instant::now();
    if st.running {
        return;
    }
    st.running = true;
    std::thread::spawn(|| {
        let mut sys = sysinfo::System::new();
        loop {
            let s = sample(&mut sys);
            let now = Instant::now();
            {
                let mut st = STATE.lock();
                if now.duration_since(st.last_ask) > Duration::from_secs(60) {
                    st.running = false;
                    st.history.clear();
                    return;
                }
                for (id, bytes) in s {
                    let list = st.history.entry(id).or_default();
                    if list.last().map_or(false, |(_, b)| bytes < *b) {
                        list.clear();
                    }
                    list.push((now, bytes));
                    list.retain(|(t, _)| now.duration_since(*t) <= Duration::from_secs(30));
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Aktuelle Rate (Bytes/s über ~4 s) und Gesamtstand; None, solange keine zwei Messpunkte da sind
pub fn rate(provider: &str) -> Option<(f64, f64)> {
    let st = STATE.lock();
    let list = st.history.get(provider)?;
    if list.len() < 2 {
        return None;
    }
    let (lt, lb) = *list.last()?;
    let (ft, fb) = *list.iter().find(|(t, _)| lt.duration_since(*t) <= Duration::from_secs(4))?;
    let dt = lt.duration_since(ft).as_secs_f64();
    if dt <= 0.0 {
        return None;
    }
    Some((((lb - fb) / dt).max(0.0), lb))
}

/// Einmalige Summe der gelesenen Bytes eines Launchers (für Epic ohne eigenen Fortschritt)
pub async fn read_io(names: &[String]) -> Option<f64> {
    let want: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    tokio::task::spawn_blocking(move || {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_disk_usage());
        let sum: f64 = sys
            .processes()
            .values()
            .filter(|p| {
                let n = p.name().to_string_lossy().to_lowercase();
                want.contains(&n.strip_suffix(".exe").unwrap_or(&n).to_string())
            })
            .map(|p| p.disk_usage().total_read_bytes as f64)
            .sum();
        if sum > 0.0 { Some(sum) } else { None }
    })
    .await
    .ok()
    .flatten()
}
