//! Minimaler Protobuf-Leser (ohne Schema) – für Battle.net product.db und Ubisoft-Caches.
//! Und ein kleiner Schreiber für Steam-Anfragen.

#[derive(Debug, Clone)]
pub struct Field<'a> {
    pub field: u64,
    pub wire: u8,
    pub int: u64,
    pub bytes: &'a [u8],
}

pub fn read_varint(buf: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf.get(pos)?;
        pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b < 0x80 {
            return Some((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Ganze Nachricht dekodieren; None, wenn die Bytes keine saubere Nachricht sind
pub fn decode(buf: &[u8]) -> Option<Vec<Field<'_>>> {
    decode_from(buf, 0)
}

pub fn decode_from(buf: &[u8], start: usize) -> Option<Vec<Field<'_>>> {
    let end = buf.len();
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        let (key, p) = read_varint(buf, pos)?;
        pos = p;
        let field = key >> 3;
        let wire = (key & 7) as u8;
        if field == 0 {
            return None;
        }
        let mut f = Field { field, wire, int: 0, bytes: &[] };
        match wire {
            0 => {
                let (v, p) = read_varint(buf, pos)?;
                f.int = v;
                pos = p;
            }
            2 => {
                let (len, p) = read_varint(buf, pos)?;
                let len = len as usize;
                if p + len > end {
                    return None;
                }
                f.bytes = &buf[p..p + len];
                pos = p + len;
            }
            1 => {
                f.bytes = buf.get(pos..pos + 8)?;
                pos += 8;
            }
            5 => {
                f.bytes = buf.get(pos..pos + 4)?;
                pos += 4;
            }
            _ => return None,
        }
        out.push(f);
    }
    if pos != end {
        return None;
    }
    Some(out)
}

/// Erste Zahl je Feldnummer
pub fn int(msg: &[Field], field: u64) -> Option<u64> {
    msg.iter().find(|f| f.wire == 0 && f.field == field).map(|f| f.int)
}

/// Erstes Längen-Feld
pub fn bytes<'a>(msg: &[Field<'a>], field: u64) -> Option<&'a [u8]> {
    msg.iter().find(|f| f.wire == 2 && f.field == field).map(|f| f.bytes)
}

pub fn string(msg: &[Field], field: u64) -> Option<String> {
    bytes(msg, field).map(|b| String::from_utf8_lossy(b).into_owned())
}

// ---------- Schreiben ----------

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    fn varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.buf.push(b);
                return;
            }
            self.buf.push(b | 0x80);
        }
    }
    pub fn uint(&mut self, field: u64, v: u64) -> &mut Self {
        self.varint(field << 3);
        self.varint(v);
        self
    }
    pub fn bytes(&mut self, field: u64, b: &[u8]) -> &mut Self {
        self.varint((field << 3) | 2);
        self.varint(b.len() as u64);
        self.buf.extend_from_slice(b);
        self
    }
    pub fn string(&mut self, field: u64, s: &str) -> &mut Self {
        self.bytes(field, s.as_bytes())
    }
    pub fn fixed64(&mut self, field: u64, v: u64) -> &mut Self {
        self.varint((field << 3) | 1);
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hin_und_zurueck() {
        let mut inner = Writer::default();
        inner.uint(1, 300).string(2, "fenris");
        let mut w = Writer::default();
        w.bytes(1, &inner.buf).uint(3, 7);
        let top = decode(&w.buf).unwrap();
        let m = decode(bytes(&top, 1).unwrap()).unwrap();
        assert_eq!(int(&m, 1), Some(300));
        assert_eq!(string(&m, 2).as_deref(), Some("fenris"));
        assert_eq!(int(&top, 3), Some(7));
        assert!(decode(&[0x0a, 0x05, 0x01]).is_none(), "Länge außerhalb");
    }
}
