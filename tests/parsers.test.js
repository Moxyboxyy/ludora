const test = require('node:test');
const assert = require('node:assert');
const { parseVdf, getCI } = require('../electron/lib/vdf');
const { parseRegOutput } = require('../electron/lib/registry');
const { getArg, cleanExePath } = require('../electron/lib/util');

test('VDF: libraryfolders (neues Format)', () => {
  const t = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps" { "228980" "1" }
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`;
  const r = parseVdf(t);
  assert.strictEqual(getCI(r, 'LibraryFolders')['1'].path, 'D:\\SteamLibrary');
});

test('VDF: appmanifest', () => {
  const t = `"AppState"\n{\n\t"appid"\t\t"413150"\n\t"name"\t\t"Stardew Valley"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Stardew Valley"\n}`;
  const s = parseVdf(t).AppState;
  assert.strictEqual(s.name, 'Stardew Valley');
  assert.strictEqual(s.StateFlags, '4');
});

test('reg query Ausgabe', () => {
  const out = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924',
    '    gameName    REG_SZ    The Witcher 3',
    '    path    REG_SZ    C:\\GOG Games\\The Witcher 3',
    '    dependsOn    REG_SZ    ',
    '    size    REG_DWORD    0x1f',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\x',
    '    (Standard)    REG_SZ    hallo',
    ''
  ].join('\r\n');
  const r = parseRegOutput(out);
  const g = r['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924'];
  assert.strictEqual(g.gameName, 'The Witcher 3');
  assert.strictEqual(g.dependsOn, '');
  assert.strictEqual(g.size, 31);
  assert.strictEqual(r['HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\x']['(Default)'], 'hallo');
});

test('Argumente aus Uninstall-Strings', () => {
  assert.strictEqual(getArg('"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=enUS --uid=fenris --displayname="Diablo IV"', 'uid'), 'fenris');
  assert.strictEqual(getArg('"C:\\x\\Amazon Game Remover.exe" -m Game -p amzn1.adg.product.abc', 'p'), 'amzn1.adg.product.abc');
  const riot = '"C:\\Riot Games\\Riot Client\\RiotClientServices.exe" --uninstall-product=valorant --uninstall-patchline=live';
  assert.strictEqual(getArg(riot, 'uninstall-product'), 'valorant');
  assert.strictEqual(cleanExePath(riot), 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe');
  assert.strictEqual(cleanExePath('"C:\\Games\\x.exe",0'), 'C:\\Games\\x.exe');
});
