const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAppInfo } = require('../electron/lib/appinfo');

// Baut eine appinfo.vdf im Format v28 (Schlüssel als Text) oder v29 (Stringtabelle)
function build(version, apps) {
  const strings = [];
  const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const key = (k) => (version === 29 ? u32(idx(k)) : cstr(k));
  const kv = (obj) => Buffer.concat([
    ...Object.entries(obj).map(([k, v]) => typeof v === 'object'
      ? Buffer.concat([Buffer.from([0]), key(k), kv(v)])
      : typeof v === 'number'
        ? Buffer.concat([Buffer.from([2]), key(k), u32(v)])
        : Buffer.concat([Buffer.from([1]), key(k), cstr(v)])),
    Buffer.from([8])
  ]);
  const entries = apps.map(([id, data]) => {
    const body = Buffer.concat([Buffer.alloc(60), kv(data)]);
    return Buffer.concat([u32(id), u32(body.length), body]);
  });
  const magic = version === 29 ? 0x07564429 : 0x07564428;
  if (version === 29) {
    const head = Buffer.alloc(16); head.writeUInt32LE(magic, 0); head.writeUInt32LE(1, 4);
    const appsBuf = Buffer.concat([...entries, u32(0)]);
    head.writeBigUInt64LE(BigInt(16 + appsBuf.length), 8);
    const table = Buffer.concat([u32(strings.length), ...strings.map(cstr)]);
    return Buffer.concat([head, appsBuf, table]);
  }
  const head = Buffer.alloc(8); head.writeUInt32LE(magic, 0); head.writeUInt32LE(1, 4);
  return Buffer.concat([head, ...entries, u32(0)]);
}

const APPS = [
  [413150, { appinfo: { appid: 413150, common: { name: 'Stardew Valley', type: 'Game' }, extended: { x: 'y' } } }],
  [228980, { appinfo: { common: { name: 'Steamworks Common Redistributables', type: 'Tool' } } }],
  [1145360, { appinfo: { common: { name: 'Hades', type: 'game' } } }]
];

for (const v of [28, 29]) {
  test(`appinfo.vdf v${v}`, async () => {
    const f = path.join(os.tmpdir(), `appinfo_${v}_${process.pid}.vdf`);
    fs.writeFileSync(f, build(v, APPS));
    const r = await readAppInfo(f, new Set(['413150', '228980']));
    assert.deepStrictEqual(r.get('413150'), { name: 'Stardew Valley', type: 'game' });
    assert.strictEqual(r.get('228980').type, 'tool');
    assert.strictEqual(r.has('1145360'), false); // nicht angefragt
    const all = await readAppInfo(f, null);
    assert.strictEqual(all.get('1145360').name, 'Hades');
    fs.unlinkSync(f);
  });
}
