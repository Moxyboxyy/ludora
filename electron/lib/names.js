// Spielnamen vergleichen (für Cover-Suche und doppelte Einträge)

/** "Assassin's Creed® Shadows™" -> "assassins creed shadows" */
function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|game|edition|standard|deluxe|pc|windows)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ähnlichkeit 0..1 (Dice-Koeffizient über Zeichenpaare) */
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const p = s.slice(i, i + 2);
      m.set(p, (m.get(p) || 0) + 1);
    }
    return m;
  };
  const pa = pairs(a), pb = pairs(b);
  let hits = 0;
  for (const [p, n] of pa) hits += Math.min(n, pb.get(p) || 0);
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

module.exports = { normalize, similarity };
