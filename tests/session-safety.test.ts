import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { TextSession } from '../src/pdf/text-session.ts';
import type { PdfDraft, PdfStore } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
function barrier() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  const field = pdf.getForm().createTextField('Answer'); field.setText('Original'); field.addToPage(page);
  let bytes = await pdf.save(), draft: PdfDraft | null = null, writes = 0;
  const store: PdfStore = {
    read: async () => bytes.slice(), write: async value => { bytes = value.slice(); writes++; }, backup: async () => 'original.pdf',
    draft: { read: async () => draft && structuredClone(draft), write: async value => { draft = structuredClone(value); }, clear: async () => { draft = null; } }
  };
  return { store, bytes: () => bytes, draft: () => draft, writes: () => writes };
}

test('reload locks edits while disk I/O is pending instead of silently discarding new input', async () => {
  const file = await fixture(), entered = barrier(), release = barrier(); let block = false;
  const session = await TextSession.open({ ...file.store, read: async () => {
    const bytes = await file.store.read(); if (block) { entered.release(); await release.wait; } return bytes;
  } }, font);
  block = true; const loading = session.reload(); await entered.wait;
  try { assert.throws(() => session.setValue('Answer', 'Arrived during reload'), /reload|restor|replac/i); }
  finally { release.release(); await loading; }
});

test('restore locks edits while preparing the recovery copy', async () => {
  const file = await fixture(), entered = barrier(), release = barrier();
  const session = await TextSession.open({ ...file.store, backup: async () => { entered.release(); await release.wait; return 'restore.pdf'; } }, font);
  const restoring = session.restore(file.bytes()); await entered.wait;
  try { assert.throws(() => session.setValue('Answer', 'Arrived during restore'), /reload|restor|replac/i); }
  finally { release.release(); await restoring; }
});

test('an external check started before a save cannot mistake its stale read for a later external edit', async () => {
  const file = await fixture(), entered = barrier(), release = barrier(); let block = false;
  const session = await TextSession.open({ ...file.store, read: async () => {
    const bytes = await file.store.read(); if (block) { block = false; entered.release(); await release.wait; } return bytes;
  } }, font);
  block = true; const checking = session.checkExternal(); await entered.wait;
  session.setValue('Answer', 'Saved'); await session.save(); session.setValue('Answer', 'Pending next answer');
  release.release(); await checking;
  assert.equal(session.status, 'unsaved'); assert.equal(session.snapshot.fields[0]!.value, 'Pending next answer');
});

test('explicit save journals the complete candidate before a partial source write can fail', async () => {
  const file = await fixture();
  const session = await TextSession.open({ ...file.store, write: async value => { await file.store.write(value.slice(0, 20)); throw new Error('Simulated disk failure'); } }, font);
  session.setValue('Answer', 'Recover every answer');
  await assert.rejects(session.save(), /disk failure/);
  assert(file.draft(), 'A complete verified candidate must survive a damaged source write');
  assert.equal((await readTextPdf(file.draft()!.bytes)).fields[0]!.value, 'Recover every answer');
  assert.equal(session.dirty, true);
  const recovered = await TextSession.open(file.store, font);
  assert.equal(recovered.status, 'conflict');
  assert.equal(recovered.snapshot.fields[0]!.value, 'Recover every answer');
});

test('a crash after the source write but before draft removal reopens as saved', async () => {
  const file = await fixture(); let failClear = true;
  const store: PdfStore = { ...file.store, draft: { ...file.store.draft!, clear: async () => {
    if (failClear) throw new Error('Crash during draft cleanup'); await file.store.draft!.clear();
  } } };
  const session = await TextSession.open(store, font); session.setValue('Answer', 'Already committed'); await session.checkpoint();
  await assert.rejects(session.save(), /Crash/); failClear = false;
  const reopened = await TextSession.open(store, font);
  assert.equal(reopened.status, 'saved'); assert.equal(reopened.dirty, false);
  assert.equal(reopened.snapshot.fields[0]!.value, 'Already committed');
});

test('new text box arguments are validated before mutating the session', async () => {
  const file = await fixture(), session = await TextSession.open(file.store, font);
  for (const page of [0, -1, 1.5, 2, NaN]) assert.throws(() => session.add(page, [20, 20, 200, 60], 14, true));
  for (const size of [0, -1, 201, NaN]) assert.throws(() => session.add(1, [20, 20, 200, 60], size, true));
  assert.throws(() => session.add(1, [-1, 0, 200, 60], 14, true));
  assert.throws(() => session.add(1, [20, 20, 200, 60], 14, true, 45));
  assert.equal(session.dirty, false); assert.equal(session.snapshot.fields.length, 1);
});
