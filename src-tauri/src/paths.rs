//! Datenordner – bewusst dieselben wie bei der Electron-Version, damit Einstellungen,
//! Anmeldungen und Cover beim Umstieg erhalten bleiben:
//!   Windows: %APPDATA%\Ludora   macOS: ~/Library/Application Support/Ludora   Linux: ~/.config/Ludora

use std::path::PathBuf;

/// Gemeinsamer Datenordner (installierte App und Entwicklungsmodus teilen sich die Anmeldungen)
pub fn shared_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Ludora")
}

/// Datenordner dieser Instanz (Entwicklung: eigener Ordner "Ludora-dev")
pub fn data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Ludora-dev")
    } else {
        shared_dir()
    }
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}
