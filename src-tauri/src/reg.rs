//! Windows-Registry (entspricht electron/lib/registry.js, aber direkt über die Windows-API statt "reg query").
//! Werte kommen als serde_json::Value: REG_SZ/EXPAND_SZ -> String, DWORD/QWORD -> Zahl.
//! Auf anderen Systemen liefern alle Funktionen leere Ergebnisse.

use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct SubKey {
    pub name: String,
    pub path: String,
    pub values: Map<String, Value>,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::*;
    use winreg::{RegKey, RegValue};

    fn open(key: &str) -> Option<RegKey> {
        let (hive, rest) = key.split_once('\\').unwrap_or((key, ""));
        let root = match hive.to_uppercase().as_str() {
            "HKLM" | "HKEY_LOCAL_MACHINE" => RegKey::predef(HKEY_LOCAL_MACHINE),
            "HKCU" | "HKEY_CURRENT_USER" => RegKey::predef(HKEY_CURRENT_USER),
            "HKCR" | "HKEY_CLASSES_ROOT" => RegKey::predef(HKEY_CLASSES_ROOT),
            "HKU" | "HKEY_USERS" => RegKey::predef(HKEY_USERS),
            _ => return None,
        };
        if rest.is_empty() {
            Some(root)
        } else {
            root.open_subkey_with_flags(rest, KEY_READ).ok()
        }
    }

    fn convert(v: &RegValue) -> Value {
        match v.vtype {
            REG_DWORD => {
                let b = &v.bytes;
                if b.len() >= 4 { Value::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])) } else { Value::Null }
            }
            REG_QWORD => {
                let b = &v.bytes;
                if b.len() >= 8 { Value::from(u64::from_le_bytes(b[..8].try_into().unwrap())) } else { Value::Null }
            }
            REG_SZ | REG_EXPAND_SZ | REG_MULTI_SZ => {
                let u: Vec<u16> = v.bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
                let s = String::from_utf16_lossy(&u);
                Value::String(s.trim_end_matches('\0').replace('\0', "\n"))
            }
            _ => Value::Null,
        }
    }

    fn values_of(k: &RegKey) -> Map<String, Value> {
        let mut m = Map::new();
        for (name, val) in k.enum_values().flatten() {
            let n = if name.is_empty() { "(Default)".to_string() } else { name };
            m.insert(n, convert(&val));
        }
        m
    }

    pub fn get_value(key: &str, name: &str) -> Option<Value> {
        let k = open(key)?;
        let n = if name == "(Default)" { "" } else { name };
        k.get_raw_value(n).ok().map(|v| convert(&v)).filter(|v| !v.is_null())
    }

    pub fn sub_keys(key: &str) -> Vec<SubKey> {
        let Some(k) = open(key) else { return vec![] };
        k.enum_keys()
            .flatten()
            .filter_map(|name| {
                let sk = k.open_subkey_with_flags(&name, KEY_READ).ok()?;
                Some(SubKey { path: format!("{key}\\{name}"), values: values_of(&sk), name })
            })
            .collect()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn get_value(_key: &str, _name: &str) -> Option<Value> {
        None
    }
    pub fn sub_keys(_key: &str) -> Vec<SubKey> {
        vec![]
    }
}

/// Einzelner Wert (None, wenn nicht vorhanden)
pub fn get_value(key: &str, name: &str) -> Option<Value> {
    imp::get_value(key, name)
}

pub fn get_string(key: &str, name: &str) -> Option<String> {
    get_value(key, name).and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty())
}

/// Erster gefundener, nicht leerer Text-Wert
pub fn get_first_string(candidates: &[(&str, &str)]) -> Option<String> {
    candidates.iter().find_map(|(k, n)| get_string(k, n))
}

/// Direkte Unterschlüssel mit ihren Werten
pub fn sub_keys(key: &str) -> Vec<SubKey> {
    imp::sub_keys(key)
}

const UNINSTALL_KEYS: [&str; 3] = [
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
];

static UNINSTALL: once_cell::sync::Lazy<parking_lot::Mutex<Option<Vec<SubKey>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));

/// Alle Einträge aus "Programme und Features" (zwischengespeichert bis clear_cache)
pub fn uninstall_entries() -> Vec<SubKey> {
    let mut c = UNINSTALL.lock();
    if c.is_none() {
        *c = Some(UNINSTALL_KEYS.iter().flat_map(|k| sub_keys(k)).collect());
    }
    c.clone().unwrap_or_default()
}

pub fn clear_cache() {
    *UNINSTALL.lock() = None;
}

/// Wert eines Eintrags als String
pub fn val_str(values: &Map<String, Value>, name: &str) -> Option<String> {
    values.get(name).and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}
