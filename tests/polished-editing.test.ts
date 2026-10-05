import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { PDFDocument, PDFDict, PDFName, PDFString } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextSession } from '../src/pdf/text-session.ts';
import type { PdfDraft } from '../src/pdf/text-session.ts';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { hitsStroke } from '../src/pdf/ink-geometry.ts';
import { migrateRecovery } from '../src/pdf/recovery-migration.ts';
import { BACKUP_ROOT, LEGACY_BACKUP_ROOT, loadBackups } from '../src/pdf/recovery.ts';
import type { BackupRecord } from '../src/pdf/recovery.ts';

const fonts = {
  sans: new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url))),
  serif: new Uint8Array(await readFile(new URL('../assets/fonts/NotoSerif-Regular.ttf', import.meta.url))),
  mono: new Uint8Array(await readFile(new URL('../assets/fonts/NotoSansMono-Regular.ttf', import.meta.url)))
};
async function fixture() {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([600, 800]);
  const field = pdf.getForm().createTextField('Answer'); field.setText('Original'); field.addToPage(page, { x: 50, y: 600, width: 300, height: 24 });
  let bytes = await pdf.save(), writes = 0; let draft: PdfDraft | null = null;
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { writes++; bytes = value.slice(); }, backup: async () => 'original.pdf',
    draft: { read: async () => draft && structuredClone(draft), write: async (value: PdfDraft) => { draft = structuredClone(value); }, clear: async () => { draft = null; } } },
    bytes: () => bytes, replace: (value: Uint8Array) => { bytes = value; }, writes: () => writes, draft: () => draft };
}

test('drawing mode checkpoints verified drafts without PDF writes, then resumes after a crash', async () => {
  const file = await fixture(), original = file.bytes().slice(); const session = await TextSession.open(file.store, fonts);
  const release = session.beginInteraction(); session.addStroke(1, 'marker', [[50, 650], [300, 650]], 14, [0, 0.4, 1]);
  await session.checkpoint(); const saving = session.saveWhenIdle(); await setImmediate();
  session.addStroke(1, 'scribble', [[50, 400], [100, 420]]); await session.checkpoint();
  assert.equal(file.writes(), 0); assert.equal(session.drafted, true); assert.deepEqual(file.bytes(), original); assert.equal((await readTextPdf(file.draft()!.bytes)).strokes.length, 2);
  const resumed = await TextSession.open(file.store, fonts); assert.equal(resumed.dirty, true); assert.equal(resumed.snapshot.strokes.length, 2);
  await resumed.save(); assert.equal(file.draft(), null); assert.equal((await readTextPdf(file.bytes())).strokes.length, 2);
  // The old in-memory session detects the external commit rather than overwriting it.
  release(); await assert.rejects(saving, /changed outside/);
});

test('stale recovery drafts preserve edits and block overwrite until explicit reload', async () => {
  const file = await fixture(), session = await TextSession.open(file.store, fonts);
  session.setValue('Answer', 'Pending answer'); await session.checkpoint();
  const external = await PDFDocument.load(file.bytes()); external.setTitle('External'); file.replace(await external.save());
  const newer = file.bytes().slice(), resumed = await TextSession.open(file.store, fonts);
  assert.equal(resumed.status, 'conflict'); assert.equal(resumed.snapshot.fields[0]!.value, 'Pending answer');
  await assert.rejects(resumed.save(), /recovered draft/); assert.deepEqual(file.bytes(), newer);
  await resumed.reload(); assert.equal(file.draft(), null); assert.equal(resumed.dirty, false); assert.equal(resumed.snapshot.fields[0]!.value, 'Original');
});

test('moving and erasing saved marks retain stable references and have gesture-level undo', async () => {
  const file = await fixture(), session = await TextSession.open(file.store, fonts);
  const stroke = session.addStroke(1, 'marker', [[50, 500], [200, 500]]); await session.save();
  const before = (await readTextPdf(file.bytes())).strokes[0]!, id = before.annotationId;
  session.beginInkAction(); session.moveStroke(stroke.id, [20, 10]); session.moveStroke(stroke.id, [5, 5]); session.finishInkAction(); await session.save();
  let saved = (await readTextPdf(file.bytes())).strokes[0]!;
  assert.equal(saved.annotationId, id); assert.deepEqual(saved.points, [[75, 515], [225, 515]]);
  session.undoStroke(); await session.save(); saved = (await readTextPdf(file.bytes())).strokes[0]!; assert.deepEqual(saved.points, before.points); assert.equal(saved.annotationId, id);
  const second = session.addStroke(1, 'scribble', [[100, 100], [200, 120]]); await session.save();
  session.beginInkAction(); session.deleteStroke(stroke.id); session.deleteStroke(second.id); session.finishInkAction(); await session.save(); assert.equal(session.snapshot.strokes.length, 0);
  session.undoStroke(); await session.save(); assert.equal((await readTextPdf(file.bytes())).strokes.length, 2);
  session.beginInkAction(); session.moveStroke(stroke.id, [-1000, -1000]); session.finishInkAction(true); assert.deepEqual(session.snapshot.strokes[0]!.points, before.points);
});

test('eraser hit testing covers crossings, tap dots and separated paths', () => {
  assert(hitsStroke([[10, 0], [10, 100]], [0, 50], [20, 50], 1));
  assert(hitsStroke([[10, 10]], [0, 10], [20, 10], 1));
  assert(hitsStroke([[10, 10], [20, 10]], [14, 11], [14, 11], 2));
  assert(!hitsStroke([[10, 10], [20, 10]], [0, 20], [30, 20], 2));
});

test('whole-field fonts, colors and sizes survive edits and produce actual appearance operators', async () => {
  const file = await fixture(), session = await TextSession.open(file.store, fonts);
  const box = session.add(1, [50, 350, 300, 410], 14, true); session.setValue(box.name, 'Serif answer ä');
  session.formatField(box.name, { fontFamily: 'serif', fontSize: 24, color: [0.1, 0.3, 0.8] });
  session.formatField('Answer', { fontFamily: 'mono', fontSize: 18, color: [0.7, 0.1, 0.1] }); await session.save();
  const reopened = await TextSession.open(file.store, fonts); reopened.setValue(box.name, 'Serif answer ö'); await reopened.save();
  const fields = (await readTextPdf(file.bytes())).fields;
  assert.equal(fields[0]!.fontFamily, 'mono'); assert.equal(fields[0]!.fontSize, 18); assert.deepEqual(fields[0]!.color, [0.7, 0.1, 0.1]);
  const saved = fields.find(field => field.name === box.name)!; assert.equal(saved.fontFamily, 'serif'); assert.equal(saved.fontSize, 24); assert.deepEqual(saved.color, [0.1, 0.3, 0.8]);
  const task = getDocument({ data: file.bytes().slice() });
  try {
    const operators = await (await (await task.promise).getPage(1)).getOperatorList();
    assert(operators.fnArray.includes(OPS.setFillRGBColor)); assert(operators.fnArray.includes(OPS.setFont));
  } finally { await task.destroy(); }
});

test('hidden recovery migration moves all copies and resumes after an interrupted index write', async () => {
  const targetFiles = new Map<string, string>([[`${LEGACY_BACKUP_ROOT}/one/original.pdf`, 'original'], [`${LEGACY_BACKUP_ROOT}/older.pdf`, 'older']]);
  const records: Record<string, BackupRecord> = loadBackups({ 'Answer.pdf': { original: `${LEGACY_BACKUP_ROOT}/one/original.pdf` } });
  const store = {
    exists: async (path: string) => targetFiles.has(path) || [...targetFiles.keys()].some(key => key.startsWith(path + '/')),
    read: async (path: string) => targetFiles.get(path)!, write: async (path: string, value: string) => { targetFiles.set(path, value); },
    remove: async (path: string) => { targetFiles.delete(path); },
    rename: async (from: string, to: string) => { for (const [key, value] of [...targetFiles]) if (key.startsWith(from + '/')) { targetFiles.set(to + key.slice(from.length), value); targetFiles.delete(key); } }
  };
  const persisted = structuredClone(records);
  await assert.rejects(migrateRecovery(store, BACKUP_ROOT, records, async () => { throw new Error('Crash before index write'); }), /Crash/);
  assert(!await store.exists(LEGACY_BACKUP_ROOT)); assert(await store.exists(`${BACKUP_ROOT}/migration.json`));
  await migrateRecovery(store, BACKUP_ROOT, persisted, async () => {});
  assert.equal(targetFiles.get(persisted['Answer.pdf']!.original), 'original'); assert.equal([...targetFiles.values()].filter(value => value === 'older').length, 1);
  assert(!await store.exists(`${BACKUP_ROOT}/migration.json`));
});


test('the display copy removes only owned ink while preserving foreign annotations and form content', async () => {
  const file = await fixture();
  const pdf = await PDFDocument.load(file.bytes());
  pdf.getPages()[0]!.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Ink', NM: PDFString.of('foreign'),
    Rect: [20, 20, 100, 80], InkList: [[20, 20, 100, 80]], BS: { W: 2 }, C: [0, 0, 1], F: 4 })));
  file.replace(await pdf.save()); const session = await TextSession.open(file.store, fonts);
  session.addStroke(1, 'marker', [[50, 500], [300, 500]]); await session.save();
  const original = file.bytes().slice(); const copy = await renderTextPdf(original);
  assert.equal((await readTextPdf(copy)).strokes.length, 0); assert.deepEqual(file.bytes(), original);
  const clean = await PDFDocument.load(copy);
  assert.equal(clean.getForm().getTextField('Answer').getText(), 'Original');
  assert(clean.getPages()[0]!.node.Annots()!.asArray().some(ref => clean.context.lookup(ref, PDFDict).get(PDFName.of('NM'))?.toString() === '(foreign)'));
});
