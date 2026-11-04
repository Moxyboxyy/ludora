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
