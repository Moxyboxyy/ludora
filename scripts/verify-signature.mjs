#!/usr/bin/env node
// Prüft signatures/<tag>.json mit dem öffentlichen Schlüssel, den auch die App nutzt
// (src-tauri/src/updater.rs, PUBLIC_KEY_B64). Aufruf: node scripts/verify-signature.mjs v0.8.0
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+([-.\w]*)$/.test(tag || '')) {
  console.error('Aufruf: node scripts/verify-signature.mjs vX.Y.Z');
  process.exit(2);
}
const rs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'updater.rs'), 'utf8');
const b64 = rs.match(/PUBLIC_KEY_B64: &str = "([^"]+)"/)?.[1];
if (!b64) throw new Error('PUBLIC_KEY_B64 nicht gefunden');
const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
const sigs = JSON.parse(fs.readFileSync(path.join(root, 'signatures', `${tag}.json`), 'utf8'));
let ok = sigs.tag === tag && Object.keys(sigs.files || {}).length > 0;
for (const [name, e] of Object.entries(sigs.files || {})) {
  const good = /^[0-9a-f]{64}$/.test(e.sha256 || '') &&
    crypto.verify(null, Buffer.from(`ludora-update\n${tag}\n${name}\n${e.sha256}`), key, Buffer.from(e.sig || '', 'base64'));
  console.log(`${good ? 'OK   ' : 'FALSCH'} ${name}`);
  ok &&= good;
}
process.exit(ok ? 0 : 1);
