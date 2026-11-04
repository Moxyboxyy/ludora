const test = require('node:test');
const assert = require('node:assert');
const { _newer, _pickAsset } = require('../electron/lib/updater');

test('Versionen vergleichen', () => {
  assert.ok(_newer('0.5.0', '0.4.1'));
  assert.ok(_newer('v0.10.0', '0.9.9'));
  assert.ok(!_newer('0.5.0', '0.5.0'));
  assert.ok(!_newer('0.4.9', '0.5.0'));
  assert.ok(_newer('0.5.0', '0.5.0-beta'));
});

test('Passende Installer-Datei je System', () => {
  const assets = ['Ludora-Setup-0.5.0.exe', 'Ludora-Setup-0.5.0.exe.blockmap', 'Ludora-0.5.0-arm64.dmg', 'Ludora-0.5.0-arm64.zip',
    'Ludora-0.5.0-x64.zip', 'Ludora-0.5.0-x86_64.AppImage', 'Ludora-0.5.0-amd64.deb'].map((name) => ({ name }));
  assert.strictEqual(_pickAsset(assets, 'win32', 'x64').name, 'Ludora-Setup-0.5.0.exe');
  assert.strictEqual(_pickAsset(assets, 'darwin', 'arm64').name, 'Ludora-0.5.0-arm64.zip');
  assert.strictEqual(_pickAsset(assets, 'darwin', 'x64').name, 'Ludora-0.5.0-x64.zip');
  assert.strictEqual(_pickAsset(assets, 'linux', 'x64', 'appimage').name, 'Ludora-0.5.0-x86_64.AppImage');
  assert.strictEqual(_pickAsset(assets, 'linux', 'x64', 'deb').name, 'Ludora-0.5.0-amd64.deb');
});

test('Updates nur mit gültiger Signatur', () => {
  const crypto = require('crypto');
  const { _verifiedSha } = require('../electron/lib/updater');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const sha = 'a'.repeat(64);
  const sign = (tag, name, s) => crypto.sign(null, Buffer.from(`ludora-update\n${tag}\n${name}\n${s}`), privateKey).toString('base64');
  const sigs = { tag: 'v0.7.0', files: { 'Ludora-Setup-0.7.0.exe': { sha256: sha, sig: sign('v0.7.0', 'Ludora-Setup-0.7.0.exe', sha) } } };
  assert.strictEqual(_verifiedSha(sigs, 'v0.7.0', 'Ludora-Setup-0.7.0.exe', pub), sha);
  // andere Datei, anderes Release, manipulierte Prüfsumme, fremder Schlüssel -> abgelehnt
  assert.strictEqual(_verifiedSha(sigs, 'v0.7.0', 'Ludora-0.7.0-x86_64.AppImage', pub), null);
  assert.strictEqual(_verifiedSha({ ...sigs, tag: 'v0.7.1' }, 'v0.7.1', 'Ludora-Setup-0.7.0.exe', pub), null);
  const forged = { tag: 'v0.7.0', files: { 'Ludora-Setup-0.7.0.exe': { ...sigs.files['Ludora-Setup-0.7.0.exe'], sha256: 'b'.repeat(64) } } };
  assert.strictEqual(_verifiedSha(forged, 'v0.7.0', 'Ludora-Setup-0.7.0.exe', pub), null);
  assert.strictEqual(_verifiedSha(sigs, 'v0.7.0', 'Ludora-Setup-0.7.0.exe'), null); // echter Ludora-Schlüssel
  assert.strictEqual(_verifiedSha(null, 'v0.7.0', 'x'), null);
});
