//! HTTP-Clients: ein normaler (Steam, Epic, GOG, Supabase, Cover …) und einer für die lokalen
//! Schnittstellen der Launcher (Riot Client: selbst signiertes Zertifikat auf 127.0.0.1).

use once_cell::sync::Lazy;
use std::time::Duration;

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("Ludora/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .gzip(true)
        .build()
        .expect("HTTP-Client")
});

/// Nur für 127.0.0.1 (Riot Client, Battle.net-Agent): Zertifikat wird nicht geprüft
static LOCAL: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("lokaler HTTP-Client")
});

pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

pub fn local() -> &'static reqwest::Client {
    &LOCAL
}

/// URL-Kodierung einer Komponente (wie encodeURIComponent)
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Formular-Kodierung (application/x-www-form-urlencoded)
pub fn form(pairs: &[(&str, String)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v).replace("%20", "+"))).collect::<Vec<_>>().join("&")
}

#[cfg(test)]
mod tests {
    #[test]
    fn kodierung() {
        assert_eq!(super::enc("a b/ä"), "a%20b%2F%C3%A4");
        assert_eq!(super::form(&[("x", "1 2".into())]), "x=1+2");
    }
}
