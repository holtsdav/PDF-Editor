import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { TextSession } from '../src/pdf/text-session.ts';
import type { PdfObject } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  const authored = pdf.getForm().createTextField('Authored'); authored.setText('Keep me'); authored.addToPage(page, { x: 30, y: 700, width: 100, height: 30 });
  let bytes = await pdf.save();
  const session = await TextSession.open({ read: async () => bytes, write: async value => { bytes = value; }, backup: async () => 'original.pdf' }, font);
  const text = session.add(1, [80, 580, 180, 610], 14, true); session.setValue(text.name, 'Mixed group');
  const ink = session.addStroke(1, 'scribble', [[230, 580], [260, 620], [290, 580]], 2);
  const objects: PdfObject[] = [{ kind: 'text', id: text.name }, { kind: 'ink', id: ink.id }];
  return { session, text, ink, objects, bytes: () => bytes };
}
test('group page-edge clamping preserves spacing, IDs and appearances through repeated saves and undo', async () => {
  const f = await fixture(), before = structuredClone(f.session.snapshot);
  const delta = f.session.objectDelta(f.objects, [10000, -10000]); f.session.moveObjects(f.objects, [10000, -10000]);
  const text = f.session.snapshot.fields.find(field => field.name === f.text.name)!;
  assert.deepEqual(text.widgets[0]!.rect, f.text === text ? [80 + delta[0], 580 + delta[1], 180 + delta[0], 610 + delta[1]] : []);
  assert.deepEqual(f.session.snapshot.strokes[0]!.points, f.ink.points.map(([x, y]) => [x + delta[0], y + delta[1]]));
  await f.session.save(); f.session.undoStroke();
  assert.deepEqual(f.session.snapshot.fields, before.fields); assert.deepEqual(f.session.snapshot.strokes[0]!.points, before.strokes[0]!.points);
  f.session.redoStroke(); await f.session.save();
  f.session.moveObjects(f.objects, [-5, 5]); await f.session.save();
  const reopened = await readTextPdf(f.bytes());
  assert.equal(reopened.fields.length, 2); assert.equal(reopened.strokes.length, 1);
  assert.equal(reopened.fields.find(field => field.name === 'Authored')!.value, 'Keep me');
  assert.equal(reopened.fields.find(field => field.name === f.text.name)!.value, 'Mixed group'); assert.equal(reopened.strokes[0]!.id, f.ink.id);
  f.session.deleteObjects(f.objects); await f.session.save(); assert.equal((await readTextPdf(f.bytes())).fields.length, 1); assert.equal((await readTextPdf(f.bytes())).strokes.length, 0);
  f.session.undoStroke(); await f.session.save(); assert.equal((await readTextPdf(f.bytes())).fields.length, 2); assert.equal((await readTextPdf(f.bytes())).strokes.length, 1);
});
test('invalid, authored and locked group members reject the whole operation before any mutation', async () => {
  const f = await fixture(), before = structuredClone(f.session.snapshot);
  for (const extra of [{ kind: 'text', id: 'Authored' }, { kind: 'ink', id: 'missing' }] as PdfObject[]) {
    assert.throws(() => f.session.moveObjects([...f.objects, extra], [10, 10])); assert.throws(() => f.session.deleteObjects([...f.objects, extra]));
    assert.deepEqual(f.session.snapshot, before);
  }
  assert.throws(() => f.session.moveObjects(f.objects, [NaN, 0])); assert.deepEqual(f.session.snapshot, before);
  f.ink.readOnly = true; assert.throws(() => f.session.moveObjects(f.objects, [10, 10])); assert.throws(() => f.session.deleteObjects(f.objects));
  f.ink.readOnly = false; assert(f.session.beginInkAction()); assert.throws(() => f.session.moveObjects(f.objects, [10, 10])); f.session.finishInkAction(true);
});
test('duplicate selection members move once and one undo restores a large mixed group', async () => {
  const f = await fixture(); const objects = [...f.objects];
  for (let i = 0; i < 200; i++) {
    const x = 20 + i % 10 * 45, y = 50 + Math.floor(i / 10) * 20;
    const text = f.session.add(1, [x, y, x + 35, y + 15], 8, true); f.session.setValue(text.name, String(i));
    const ink = f.session.addStroke(1, 'scribble', [[x, y], [x + 10, y + 10]], 1);
    objects.push({ kind: 'text', id: text.name }, { kind: 'ink', id: ink.id });
  }
  const before = structuredClone(f.session.snapshot); let notifications = 0; const unsubscribe = f.session.subscribe(() => { notifications++; });
  f.session.moveObjects([...objects, ...objects], [5, 7]); assert.equal(notifications, 1);
  f.session.undoStroke(); assert.deepEqual(f.session.snapshot, before); unsubscribe();
});
test('copy and paste create independent text and ink with one undo step', async () => {
  const f = await fixture();
  const copied = f.session.copyObjects(f.objects);
  const created = f.session.pasteObjects(copied);
  assert.equal(created.length, 2);
  assert.notEqual(created[0]!.id, f.text.name); assert.notEqual(created[1]!.id, f.ink.id);
  assert.equal(f.session.snapshot.fields.find(field => field.name === created[0]!.id)?.value, f.text.value);
  assert.deepEqual(f.session.snapshot.fields.find(field => field.name === created[0]!.id)?.widgets[0]?.rect, [92, 568, 192, 598]);
  assert.deepEqual(f.session.snapshot.strokes.find(stroke => stroke.id === created[1]!.id)?.points, f.ink.points.map(([x, y]) => [x + 12, y - 12]));
  await f.session.save();
  const saved = await readTextPdf(f.bytes());
  assert.equal(saved.fields.length, 3); assert.equal(saved.strokes.length, 2);
  f.session.undoStroke();
  assert.equal(f.session.snapshot.fields.length, 2); assert.equal(f.session.snapshot.strokes.length, 1);
  f.session.redoStroke();
  assert.equal(f.session.snapshot.fields.length, 3); assert.equal(f.session.snapshot.strokes.length, 2);
});
