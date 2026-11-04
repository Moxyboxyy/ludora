const test = require('node:test');
const assert = require('node:assert');
const { normalize, similarity } = require('../electron/lib/covers');

test('Namen normalisieren', () => {
  assert.strictEqual(normalize("Assassin's Creed® Shadows™"), 'assassins creed shadows');
  assert.strictEqual(normalize('Diablo® IV'), 'diablo iv');
});

test('Ähnlichkeit für Cover-Treffer', () => {
  assert.strictEqual(similarity('Diablo IV', 'Diablo® IV'), 1);
  assert.ok(similarity('Grand Theft Auto V', 'Grand Theft Auto V Legacy') > 0.8);
  assert.ok(similarity('Diablo IV', 'Diablo II: Resurrected') < 0.8);
  assert.ok(similarity('VALORANT', 'Valorant Champions') < 0.8);
});
