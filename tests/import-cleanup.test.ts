import test from 'node:test';
import assert from 'node:assert/strict';
import { trashVerifiedImport } from '../src/pdf/import-cleanup.ts';
import type { ImportSource, ImportCleanupStore } from '../src/pdf/import-cleanup.ts';

const original: ImportSource = { path: '/anonymous/fixture.pdf', identity: 'inode/version', bytes: new Uint8Array([37, 80, 68, 70]) };
function fixture() {
  let trashed = 0;
  const store: ImportCleanupStore = { active: () => true, source: async () => structuredClone(original), attachment: async () => original.bytes.slice(), trash: async () => { trashed++; } };
  return { store, trashed: () => trashed };
}
test('only a verified exact native import reaches the system trash operation once', async () => {
  const f = fixture(); assert.equal(await trashVerifiedImport(original, original.bytes, f.store), true); assert.equal(f.trashed(), 1);
});
test('disabled, failed, changed, replaced and ambiguous imports keep the original', async () => {
  for (const override of [
    { active: () => false }, { attachment: async () => null }, { attachment: async () => new Uint8Array([0]) },
    { source: async () => null }, { source: async () => ({ ...original, identity: 'replacement' }) },
    { source: async () => ({ ...original, bytes: new Uint8Array([0]) }) }, { source: async () => ({ ...original, path: '/other.pdf' }) }
  ]) {
    const f = fixture(); Object.assign(f.store, override); assert.equal(await trashVerifiedImport(original, original.bytes, f.store), false); assert.equal(f.trashed(), 0);
  }
  const f = fixture(); assert.equal(await trashVerifiedImport(original, new Uint8Array([0]), f.store), false); assert.equal(f.trashed(), 0);
});
test('unload or disable during either asynchronous verification prevents cleanup', async () => {
  for (const phase of ['attachment', 'source'] as const) {
    const f = fixture(); let active = true; f.store.active = () => active;
    const read = f.store[phase];
    if (phase === 'source') f.store.source = async path => { active = false; return (read as ImportCleanupStore['source'])(path); };
    else f.store.attachment = async () => { active = false; return (read as ImportCleanupStore['attachment'])(); };
    assert.equal(await trashVerifiedImport(original, original.bytes, f.store), false); assert.equal(f.trashed(), 0);
  }
});
test('trash failure is reported and never falls back to permanent deletion', async () => {
  const f = fixture(); f.store.trash = async () => { throw new Error('Trash unavailable'); };
  await assert.rejects(trashVerifiedImport(original, original.bytes, f.store), /Trash unavailable/); assert.equal(f.trashed(), 0);
});
