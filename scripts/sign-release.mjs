// Release signieren: node scripts/sign-release.mjs <tag> <private-key.pem> [--digests datei.json]
//
// Holt die SHA-256-Prüfsummen der Installer des Releases von GitHub (oder aus --digests, falls
// offline) und signiert sie mit dem privaten Schlüssel (Ed25519). Ergebnis: signatures/<tag>.json.
// Diese Datei auf main hochladen – erst dann bieten installierte Ludoras das Update an.
// Der private Schlüssel bleibt auf deinem PC; ohne ihn kann niemand Updates verteilen.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'MaxiMagDich93/ludora';
const [tag, keyFile, flag, digestFile] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+/.test(tag || '') || !keyFile) {
  console.error('Aufruf: node scripts/sign-release.mjs v0.7.0 pfad/zu/private-key.pem [--digests datei.json]');
  process.exit(1);
}

let assets;
if (flag === '--digests') {
  assets = JSON.parse(fs.readFileSync(digestFile, 'utf8'));
} else {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: { 'user-agent': 'ludora-sign' } });
  if (!r.ok) throw new Error(`GitHub ${r.status} – gibt es das Release ${tag} schon?`);
  assets = (await r.json()).assets.map((a) => ({ name: a.name, digest: a.digest }));
}

const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
const files = {};
for (const a of assets) {
  if (/\.(blockmap|yml)$/i.test(a.name)) continue;
  const sha256 = String(a.digest || '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Keine Prüfsumme für ${a.name}`);
  const msg = Buffer.from(`ludora-update\n${tag}\n${a.name}\n${sha256}`);
  files[a.name] = { sha256, sig: crypto.sign(null, msg, key).toString('base64') };
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'signatures', `${tag}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ tag, files }, null, 2) + '\n');
console.log(`${Object.keys(files).length} Dateien signiert -> ${out}`);
