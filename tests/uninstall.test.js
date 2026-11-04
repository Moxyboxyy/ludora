// Deinstallieren im Hintergrund
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const su = require('../electron/lib/silentUninstall');

test('Deinstallationsprogramme werden lautlos gemacht', () => {
  assert.strictEqual(su.silentCommand('"E:\\GOG Games\\Celeste\\unins000.exe"'), '"E:\\GOG Games\\Celeste\\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART');
  assert.strictEqual(su.silentCommand('MsiExec.exe /I{12345678-ABCD-1234-ABCD-1234567890AB}'), 'MsiExec.exe /X{12345678-ABCD-1234-ABCD-1234567890AB} /qn /norestart');
  assert.strictEqual(su.silentCommand('"C:\\Games\\X\\uninstall.exe"'), '"C:\\Games\\X\\uninstall.exe" /S');
  assert.strictEqual(su.silentCommand('"C:\\x\\upc.exe" uplay://uninstall/635'), null); // unbekannt -> nicht raten
  assert.strictEqual(su.silentCommand('egal', 'quiet.exe /s'), 'quiet.exe /s');           // QuietUninstallString hat Vorrang
});

test('Gelöscht wird nur innerhalb des erlaubten Ordners', () => {
  const lib = path.join(path.sep, 'spiele', 'steamapps', 'common');
  assert.strictEqual(su.insideSafe(path.join(lib, 'Skate'), lib), true);
  assert.strictEqual(su.insideSafe(lib, lib), false);
  assert.strictEqual(su.insideSafe(path.join(lib, '..', '..'), lib), false);
  assert.strictEqual(su.insideSafe(path.join(lib, '..', 'common2', 'x'), lib), false);
});

test('Steam: appmanifest + Spielordner werden entfernt, Rest bleibt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steamun-'));
  const apps = path.join(root, 'steamapps');
  const gameDir = path.join(apps, 'common', 'Skate');
  const other = path.join(apps, 'common', 'Anderes Spiel');
  fs.mkdirSync(path.join(gameDir, 'bin'), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'bin', 'skate.exe'), 'x');
  fs.writeFileSync(path.join(apps, 'appmanifest_123.acf'), '"AppState"\n{\n "appid" "123"\n "installdir" "Skate"\n}');
  fs.writeFileSync(path.join(apps, 'appmanifest_456.acf'), '"AppState" { "appid" "456" "installdir" "Anderes Spiel" }');
  const fakeSteam = {
    findSteamPath: async () => root,
    getLibraryFolders: async () => [apps],
    findSteamExe: async () => null
  };
  const r = await su.steamUninstall({ nativeId: '123', name: 'Skate' }, fakeSteam);
  assert.strictEqual(r.via, 'Steam');
  assert.ok(!fs.existsSync(gameDir));
  assert.ok(!fs.existsSync(path.join(apps, 'appmanifest_123.acf')));
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(path.join(apps, 'appmanifest_456.acf')));
});

test('Steam: gefährlicher installdir wird abgelehnt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steamun-'));
  const apps = path.join(root, 'steamapps');
  fs.mkdirSync(path.join(apps, 'common'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'appmanifest_9.acf'), '"AppState" { "appid" "9" "installdir" ".." }');
  const fakeSteam = { findSteamPath: async () => root, getLibraryFolders: async () => [apps], findSteamExe: async () => null };
  await assert.rejects(() => su.steamUninstall({ nativeId: '9' }, fakeSteam), /Unerwarteter Spielordner/);
  assert.ok(fs.existsSync(path.join(apps, 'appmanifest_9.acf')), 'nichts angefasst');
});
