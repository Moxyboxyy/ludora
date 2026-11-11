//! Kleine Helfer.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const IS_WIN: bool = cfg!(target_os = "windows");
pub const IS_MAC: bool = cfg!(target_os = "macos");
pub const IS_LINUX: bool = cfg!(target_os = "linux");

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// ~/Library/Application Support/... (macOS)
pub fn mac_support(parts: &[&str]) -> PathBuf {
    let mut p = home().join("Library").join("Application Support");
    for x in parts {
        p = p.join(x);
    }
    p
}

/// /Users/Shared/... (macOS)
pub fn mac_shared(parts: &[&str]) -> PathBuf {
    let mut p = PathBuf::from("/Users/Shared");
    for x in parts {
        p = p.join(x);
    }
    p
}

/// Pfad bis einschließlich ".app" (macOS-Programmpaket)
pub fn app_bundle(p: &str) -> Option<String> {
    let lower = p.to_lowercase();
    let i = lower.find(".app")?;
    let end = i + 4;
    if end == p.len() || p[end..].starts_with('/') {
        Some(p[..end].to_string())
    } else {
        None
    }
}

pub fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

pub async fn exists(p: impl AsRef<Path>) -> bool {
    tokio::fs::metadata(p).await.is_ok()
}

pub async fn read_text(p: impl AsRef<Path>) -> Option<String> {
    let bytes = tokio::fs::read(p).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub async fn read_json(p: impl AsRef<Path>) -> Option<Value> {
    let t = read_text(p).await?;
    serde_json::from_str(t.trim_start_matches('\u{feff}')).ok()
}

pub async fn list_dir(p: impl AsRef<Path>) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(p).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            out.push(e.file_name().to_string_lossy().into_owned());
        }
    }
    out
}

pub async fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    for p in paths {
        if !p.as_os_str().is_empty() && exists(p).await {
            return Some(p.clone());
        }
    }
    None
}

/// Kommandozeilen-Parameter wie --uid=fenris aus einem String
pub fn get_arg(s: &str, name: &str) -> Option<String> {
    let re = regex::Regex::new(&format!(r#"(?i)--?{}[=\s]+"?([^"\s]+)"?"#, regex::escape(name))).ok()?;
    re.captures(s).map(|c| c[1].to_string())
}

/// Entfernt Anführungszeichen und Icon-Index aus einem Pfad wie "C:\x.exe",0
pub fn clean_exe_path(s: &str) -> String {
    let mut s = s.trim().to_string();
    if let Some(rest) = s.strip_prefix('"') {
        s = rest.split('"').next().unwrap_or("").to_string();
    }
    let re = crate::re!(r",\s*-?\d+$");
    re.replace(&s, "").into_owned()
}

/// Start-Beschreibung für ein Programm (wie exeLaunch in util.js)
pub fn exe_launch(exe: Option<&Path>, args: &[&str]) -> Option<Value> {
    let exe = exe?;
    Some(json!({
        "type": "exe",
        "target": exe.to_string_lossy(),
        "args": args,
        "cwd": exe.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
    }))
}

pub fn uri(target: impl Into<String>) -> Value {
    json!({ "type": "uri", "target": target.into() })
}

/// Pfad im Format des Systems zusammensetzen (normalisiert "/" vs "\")
pub fn norm_path(p: &str) -> PathBuf {
    if IS_WIN {
        PathBuf::from(p.replace('/', "\\"))
    } else {
        PathBuf::from(p)
    }
}

/// Gesamtgröße eines Ordners (rekursiv, ohne Symlinks)
pub async fn dir_size(dir: PathBuf, limit: usize) -> u64 {
    tokio::task::spawn_blocking(move || {
        let mut total = 0u64;
        let mut files = 0usize;
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            if files >= limit {
                break;
            }
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(e.path());
                } else if ft.is_file() {
                    files += 1;
                    total += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        total
    })
    .await
    .unwrap_or(0)
}

// ---------- Namen ----------

/// "Assassin's Creed® Shadows™" -> "assassins creed shadows"
pub fn normalize(name: &str) -> String {
    let lower: String = name.to_lowercase().nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let s: String = lower.chars().filter(|c| !matches!(c, '™' | '®' | '©' | '’' | '\'' | '`')).collect();
    let mut words = Vec::new();
    for w in s.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())) {
        if w.is_empty() || matches!(w, "the" | "game" | "edition" | "standard" | "deluxe" | "pc" | "windows") {
            continue;
        }
        words.push(w);
    }
    words.join(" ")
}

/// Sortierschlüssel wie localeCompare(…, 'de', { sensitivity: 'base' }): ohne Groß/klein und Akzente
pub fn normalize_sort(name: &str) -> String {
    name.to_lowercase().nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect()
}

/// Ähnlichkeit 0..1 (Dice-Koeffizient über Zeichenpaare)
pub fn similarity(a: &str, b: &str) -> f64 {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let pairs = |s: &str| {
        let c: Vec<char> = s.chars().collect();
        let mut m = std::collections::HashMap::new();
        for w in c.windows(2) {
            *m.entry((w[0], w[1])).or_insert(0usize) += 1;
        }
        (m, c.len())
    };
    let (pa, la) = pairs(&a);
    let (pb, lb) = pairs(&b);
    let mut hits = 0usize;
    for (p, n) in &pa {
        hits += (*n).min(*pb.get(p).unwrap_or(&0));
    }
    let denom = (la.saturating_sub(1) + lb.saturating_sub(1)) as f64;
    if denom == 0.0 { 0.0 } else { 2.0 * hits as f64 / denom }
}

// ---------- Übersetzung (Deutsch ist die Ausgangssprache, Englisch kommt aus en.json) ----------

static EN: once_cell::sync::Lazy<Map<String, Value>> = once_cell::sync::Lazy::new(|| {
    serde_json::from_str(include_str!("../i18n/en.json")).unwrap_or_default()
});

pub fn lang() -> String {
    crate::settings::get_str("language", "en")
}

pub fn t(text: &str) -> String {
    t_args(text, &[])
}

pub fn t_args(text: &str, args: &[&str]) -> String {
    let mut s = if lang() == "de" {
        text.to_string()
    } else {
        EN.get(text).and_then(|v| v.as_str()).unwrap_or(text).to_string()
    };
    for (i, a) in args.iter().enumerate() {
        s = s.replace(&format!("{{{i}}}"), a);
    }
    s
}

/// Regulärer Ausdruck, der nur einmal kompiliert wird (statt bei jedem Aufruf) – spart CPU
#[macro_export]
macro_rules! re {
    ($p:expr) => {{
        static R: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new($p).unwrap());
        &*R
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namen_normalisieren() {
        assert_eq!(normalize("Assassin's Creed® Shadows™"), "assassins creed shadows");
        assert_eq!(normalize("The Witcher 3: Wild Hunt – Game of the Year Edition"), "witcher 3 wild hunt of year");
        assert_eq!(normalize("Pokémon"), "pokemon");
        assert!(similarity("Cyberpunk 2077", "Cyberpunk 2077®") > 0.99);
        assert!(similarity("Hades", "Hades II") < 1.0);
    }

    #[test]
    fn exe_pfade() {
        assert_eq!(clean_exe_path(r#""C:\Games\x.exe",0"#), r"C:\Games\x.exe");
        assert_eq!(clean_exe_path(r"C:\x.exe,-1"), r"C:\x.exe");
        assert_eq!(get_arg("launcher.exe --uid=fenris -x", "uid").as_deref(), Some("fenris"));
        assert_eq!(app_bundle("/Applications/Steam.app/Contents/MacOS/steam_osx").as_deref(), Some("/Applications/Steam.app"));
    }
}
