//! Protokoll: logs/main.log im Datenordner (max. ~1 MB, danach main.old.log) – wie in der Electron-Version.

use std::io::Write;

fn write(level: &str, text: &str) {
    let dir = crate::paths::logs_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join("main.log");
    if std::fs::metadata(&file).map(|m| m.len() > 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("main.old.log"));
    }
    let line = format!("[{}] {level} {text}\n", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = f.write_all(line.as_bytes());
    }
    eprint!("{line}");
}

pub fn info(text: &str) {
    write("LOG", text);
}

pub fn warn(text: &str) {
    write("WARN", text);
}

pub fn error(text: &str) {
    write("ERROR", text);
}
