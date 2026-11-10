//! Valves KeyValues/VDF – Text (libraryfolders.vdf, appmanifest_*.acf) und Binär (appinfo.vdf).
//! Ergebnis als serde_json::Value (Objekte mit Strings), wie in der JS-Version.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Text-VDF parsen
pub fn parse(text: &str) -> Value {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    Value::Object(read_object(&chars, &mut i))
}

fn skip_ws(c: &[char], i: &mut usize) {
    while *i < c.len() {
        match c[*i] {
            ' ' | '\t' | '\r' | '\n' => *i += 1,
            '/' if c.get(*i + 1) == Some(&'/') => {
                while *i < c.len() && c[*i] != '\n' {
                    *i += 1;
                }
            }
            _ => break,
        }
    }
}

fn read_string(c: &[char], i: &mut usize) -> String {
    let mut out = String::new();
    if c.get(*i) == Some(&'"') {
        *i += 1;
        while *i < c.len() && c[*i] != '"' {
            if c[*i] == '\\' && *i + 1 < c.len() {
                let n = c[*i + 1];
                out.push(match n {
                    'n' => '\n',
                    't' => '\t',
                    x => x,
                });
                *i += 2;
                continue;
            }
            out.push(c[*i]);
            *i += 1;
        }
        *i += 1;
        return out;
    }
    while *i < c.len() && !c[*i].is_whitespace() && !matches!(c[*i], '{' | '}' | '"') {
        out.push(c[*i]);
        *i += 1;
    }
    out
}

fn read_object(c: &[char], i: &mut usize) -> Map<String, Value> {
    let mut obj = Map::new();
    loop {
        skip_ws(c, i);
        if *i >= c.len() {
            return obj;
        }
        if c[*i] == '}' {
            *i += 1;
            return obj;
        }
        let key = read_string(c, i);
        skip_ws(c, i);
        // Bedingungen wie [$WIN32] überspringen
        if c.get(*i) == Some(&'[') {
            while *i < c.len() && c[*i] != ']' {
                *i += 1;
            }
            *i += 1;
            skip_ws(c, i);
        }
        if c.get(*i) == Some(&'{') {
            *i += 1;
            let o = read_object(c, i);
            obj.insert(key, Value::Object(o));
        } else {
            let s = read_string(c, i);
            obj.insert(key, Value::String(s));
        }
    }
}

/// Wert unabhängig von Groß-/Kleinschreibung des Schlüssels
pub fn get_ci<'a>(obj: &'a Value, key: &str) -> Option<&'a Value> {
    let o = obj.as_object()?;
    if let Some(v) = o.get(key) {
        return Some(v);
    }
    let lower = key.to_lowercase();
    o.iter().find(|(k, _)| k.to_lowercase() == lower).map(|(_, v)| v)
}

/// get_ci als String
pub fn get_str(obj: &Value, key: &str) -> Option<String> {
    get_ci(obj, key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// Mehrere Ebenen: path(&v, &["a", "b"])
pub fn path<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut cur = obj;
    for k in keys {
        cur = get_ci(cur, k)?;
    }
    Some(cur)
}

// ---------- appinfo.vdf (binär) ----------

const MAGIC_27: u32 = 0x07564427;
const MAGIC_28: u32 = 0x07564428;
const MAGIC_29: u32 = 0x07564429;

struct Buf<'a> {
    b: &'a [u8],
}

impl<'a> Buf<'a> {
    fn u32(&self, p: usize) -> Option<u32> {
        self.b.get(p..p + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
    }
    fn u64(&self, p: usize) -> Option<u64> {
        self.b.get(p..p + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()))
    }
    fn cstr(&self, p: usize) -> (String, usize) {
        let mut e = p;
        while e < self.b.len() && self.b[e] != 0 {
            e += 1;
        }
        (String::from_utf8_lossy(&self.b[p.min(e)..e]).into_owned(), e + 1)
    }
}

/// Binäre KeyValues ab pos lesen -> (Objekt, neue Position)
fn read_kv(buf: &Buf, mut pos: usize, strings: Option<&[String]>, end: usize) -> Option<(Map<String, Value>, usize)> {
    let mut obj = Map::new();
    while pos < end {
        let ty = *buf.b.get(pos)?;
        pos += 1;
        if ty == 0x08 {
            return Some((obj, pos));
        }
        let key = if let Some(st) = strings {
            let k = st.get(buf.u32(pos)? as usize)?.clone();
            pos += 4;
            k
        } else {
            let (k, p) = buf.cstr(pos);
            pos = p;
            k
        };
        match ty {
            0x00 => {
                let (o, p) = read_kv(buf, pos, strings, end)?;
                obj.insert(key, Value::Object(o));
                pos = p;
            }
            0x01 => {
                let (s, p) = buf.cstr(pos);
                obj.insert(key, Value::String(s));
                pos = p;
            }
            0x02 | 0x04 | 0x06 => {
                obj.insert(key, Value::from(buf.u32(pos)? as i32));
                pos += 4;
            }
            0x03 => {
                obj.insert(key, Value::from(f32::from_le_bytes(buf.b.get(pos..pos + 4)?.try_into().ok()?) as f64));
                pos += 4;
            }
            0x07 | 0x0a => {
                obj.insert(key, Value::String(buf.u64(pos)?.to_string()));
                pos += 8;
            }
            0x05 => {
                let mut e = pos;
                while e + 1 < end && (buf.b[e] != 0 || buf.b[e + 1] != 0) {
                    e += 2;
                }
                let u: Vec<u16> = buf.b[pos..e].chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
                obj.insert(key, Value::String(String::from_utf16_lossy(&u)));
                pos = e + 2;
            }
            _ => return None,
        }
    }
    Some((obj, pos))
}

#[derive(Debug, Clone)]
pub struct AppInfo {
    pub name: String,
    pub kind: String,
}

/// appid -> Name/Typ für die gewünschten IDs (None = alle)
pub fn read_app_info(bytes: &[u8], wanted: Option<&HashSet<String>>) -> Result<HashMap<String, AppInfo>, String> {
    let buf = Buf { b: bytes };
    let magic = buf.u32(0).ok_or("leer")?;
    if ![MAGIC_27, MAGIC_28, MAGIC_29].contains(&magic) {
        return Err(format!("Unbekanntes appinfo.vdf-Format ({magic:x})"));
    }
    let mut pos = 8usize;
    let mut strings: Option<Vec<String>> = None;
    let mut data_end = bytes.len();
    if magic == MAGIC_29 {
        let table = buf.u64(8).ok_or("kaputt")? as usize;
        pos = 16;
        data_end = table;
        let count = buf.u32(table).ok_or("kaputt")? as usize;
        let mut v = Vec::with_capacity(count);
        let mut p = table + 4;
        for _ in 0..count {
            let (s, np) = buf.cstr(p);
            v.push(s);
            p = np;
        }
        strings = Some(v);
    }
    let header_len = if magic == MAGIC_27 { 40 } else { 60 };
    let mut out = HashMap::new();
    while pos + 8 <= data_end {
        let appid = buf.u32(pos).unwrap_or(0);
        if appid == 0 {
            break;
        }
        let size = buf.u32(pos + 4).unwrap_or(0) as usize;
        let entry_start = pos + 8;
        let entry_end = (entry_start + size).min(data_end);
        pos = entry_start + size;
        let id = appid.to_string();
        if let Some(w) = wanted {
            if !w.contains(&id) {
                continue;
            }
        }
        if let Some((kv, _)) = read_kv(&buf, entry_start + header_len, strings.as_deref(), entry_end) {
            let kv = Value::Object(kv);
            if let Some(common) = path(&kv, &["appinfo", "common"]) {
                out.insert(id, AppInfo {
                    name: get_str(common, "name").unwrap_or_default(),
                    kind: get_str(common, "type").unwrap_or_default().to_lowercase(),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_vdf() {
        let v = parse(r#""libraryfolders"
{
    // Kommentar
    "0" { "path" "C:\\Program Files (x86)\\Steam" "apps" { "228980" "123" } }
    "1"	{ "path"	"E:\\Spiele" }
    "x" "1" [$WIN32]
}"#);
        let root = get_ci(&v, "LibraryFolders").unwrap();
        assert_eq!(get_str(get_ci(root, "1").unwrap(), "path").unwrap(), r"E:\Spiele");
        assert_eq!(path(&v, &["libraryfolders", "0", "apps", "228980"]).unwrap(), "123");
    }

    #[test]
    fn binaer_vdf_v29() {
        // appinfo.vdf im Format 29 mit einer App (Name "Spiel", Typ "Game") nachbauen
        let strings = ["appinfo", "common", "name", "type"];
        let mut kv = vec![];
        kv.push(0x00); kv.extend(0u32.to_le_bytes()); // appinfo {
        kv.push(0x00); kv.extend(1u32.to_le_bytes()); // common {
        kv.push(0x01); kv.extend(2u32.to_le_bytes()); kv.extend(b"Spiel\0");
        kv.push(0x01); kv.extend(3u32.to_le_bytes()); kv.extend(b"Game\0");
        kv.push(0x08); kv.push(0x08); kv.push(0x08);
        let mut entry = vec![0u8; 60];
        entry.extend(&kv);
        let mut f = vec![];
        f.extend(MAGIC_29.to_le_bytes());
        f.extend(1u32.to_le_bytes());
        let table_pos_index = f.len();
        f.extend(0u64.to_le_bytes());
        f.extend(440u32.to_le_bytes());
        f.extend((entry.len() as u32).to_le_bytes());
        f.extend(&entry);
        f.extend(0u32.to_le_bytes());
        let table = f.len() as u64;
        f[table_pos_index..table_pos_index + 8].copy_from_slice(&table.to_le_bytes());
        f.extend((strings.len() as u32).to_le_bytes());
        for s in strings { f.extend(s.as_bytes()); f.push(0); }
        let m = read_app_info(&f, None).unwrap();
        assert_eq!(m["440"].name, "Spiel");
        assert_eq!(m["440"].kind, "game");
    }
}
