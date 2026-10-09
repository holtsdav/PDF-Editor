import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftJournal } from '../src/pdf/draft-journal.ts';
import { hash, loadBackups } from '../src/pdf/recovery.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';

test('persisted colors require three finite numeric components and are copied', () => {
  const defaults = loadToolPreferences(null);
  for (const color of [null, 'red', [0, 1], [0, 1, 0, 1], ['0', 1, 0], [0, NaN, 0], [0, Infinity, 0], [0, -1, 0], [0, 2, 0]]) {
    assert.deepEqual(loadToolPreferences({ textColor: color, penColor: color, markerColor: color }), defaults);
  }
  const color = [0, 0.5, 1], loaded = loadToolPreferences({ textColor: color });
  color[0] = 1;
  assert.deepEqual(loaded.textColor, [0, 0.5, 1]);
});

test('recovery metadata validates unknown properties under the supplied configuration root', () => {
  const root = '.custom-config/plugins/pdf-editor/recovery', original = root + '/copy/original.pdf';
  const records = loadBackups({ 'Valid.pdf': { original, originalHash: 12, recovery: root + '/copy/../outside.pdf', recoveryHash: null },
    'Invalid.pdf': { original: 12 }, 'Default.pdf': { original: '.obsidian/plugins/pdf-editor/recovery/copy/original.pdf' } }, root);
  assert.deepEqual(records['Valid.pdf'], { original });
  assert.equal(records['Invalid.pdf'], undefined);
  assert.equal(records['Default.pdf'], undefined);
  assert.deepEqual(loadBackups([{ original }], root), {});
});

test('journal read failures become Error objects even when stores throw falsy values', async () => {
  for (const cause of ['Storage unavailable', null, 0, false]) {
    const journal = new DraftJournal({ exists: async () => true, read: async () => { throw cause; },
      write: async () => {}, remove: async () => {} });
    await assert.rejects(journal.read('draft'), error => error instanceof Error && error.cause === cause);
  }
});

test('a valid alternate journal survives a non-Error failure reading the other slot', async () => {
  const bytes = new Uint8Array([1, 2, 3]), baselineHash = await hash(new Uint8Array([4]));
  const saved = JSON.stringify({ baselineHash, pdf: btoa(String.fromCharCode(...bytes)), pdfHash: await hash(bytes), sequence: 1 });
  const journal = new DraftJournal({ exists: async () => true,
    read: async path => { if (path === 'draft') throw 'Unavailable'; return saved; },
    write: async () => {}, remove: async () => {} });
  assert.deepEqual(await journal.read('draft'), { baselineHash, bytes });
});
