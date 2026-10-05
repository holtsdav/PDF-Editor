import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { PDFDocument, PDFDict, PDFName, PDFString, degrees } from 'pdf-lib';
import { AnnotationMode, getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextSession } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { simplifyStroke } from '../src/pdf/ink-geometry.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;
async function fixture(rotated = false) {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([600, 800]);
  page.drawText('Readable under the marker', { x: 50, y: 650, size: 18 });
  if (rotated) { page.setCropBox(20, 20, 540, 720); page.setRotation(degrees(90)); }
  const form = pdf.getForm().createTextField('Answer'); form.setText('Original'); form.addToPage(page, { x: 50, y: 500, width: 240, height: 24 });
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Ink', NM: PDFString.of('foreign-ink'),
    Rect: [30, 100, 100, 130], InkList: [[35, 105, 95, 125]], C: [0, 0, 1], BS: { W: 2 }, F: 4 })));
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Highlight', NM: PDFString.of('foreign-highlight'),
    Rect: [50, 620, 150, 640], QuadPoints: [50, 640, 150, 640, 50, 620, 150, 620], C: [0, 1, 0], CA: 0.4, F: 4 })));
  let bytes = await pdf.save(), writes = 0;
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); writes++; }, backup: async () => 'original.pdf' },
    bytes: () => bytes, writes: () => writes, replace: (value: Uint8Array) => { bytes = value; } };
}

test('marker and scribble persist standard ink, transparency, stable IDs and unrelated annotations', async () => {
  const file = await fixture(); const session = await TextSession.open(file.store, font);
  const marker = session.addStroke(1, 'marker', [[45, 655], [300, 655]], 14);
  const pen = session.addStroke(1, 'scribble', [[60, 400], [100, 440], [150, 390]], 2);
  session.setValue('Answer', 'Edited directly'); await session.save();
  session.setValue('Answer', 'Second save'); await session.save();
  const snapshot = await readTextPdf(file.bytes());
  assert.deepEqual(snapshot.strokes.map(stroke => stroke.id), [marker.id, pen.id]);
  assert.equal(snapshot.strokes[0]!.opacity, 0.4); assert.deepEqual(snapshot.strokes[0]!.color, [1, 0.84, 0]);
  assert.equal(snapshot.strokes[1]!.width, 2); assert.equal(snapshot.fields[0]!.value, 'Second save');
  assert(snapshot.strokes.every(stroke => stroke.annotationId));
  const pdf = await PDFDocument.load(file.bytes());
  const annotations = pdf.getPages()[0]!.node.Annots()!.asArray().map(ref => pdf.context.lookup(ref, PDFDict));
  assert(annotations.some(dict => dict.lookup(PDFName.of('NM'))?.toString() === '(foreign-ink)'));
  assert(annotations.some(dict => dict.lookup(PDFName.of('NM'))?.toString() === '(foreign-highlight)'));
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(1);
    const annotations = await page.getAnnotations({ intent: 'display' });
    const own = annotations.filter(annotation => annotation.contentsObj?.str === 'Marker' || annotation.contentsObj?.str === 'Scribble');
    assert.equal(own.length, 2); assert(own.every(annotation => annotation.hasAppearance && annotation.subtype === 'Ink'));
    const savedMarker = own.find(annotation => annotation.contentsObj?.str === 'Marker')!;
    assert.equal(savedMarker.opacity, 0.4); assert.deepEqual([...savedMarker.inkLists[0]], [45, 655, 300, 655]);
    const operators = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
    assert(operators.fnArray.includes(OPS.setGState));
    assert(operators.fnArray.some((op, i) => op === OPS.constructPath && operators.argsArray[i][0] === OPS.stroke));
    assert(operators.fnArray.some((op, i) => op === OPS.setGState
      && operators.argsArray[i][0].some((entry: unknown[]) => entry[0] === 'BM' && entry[1] === 'multiply')));
  } finally { await task.destroy(); }
});

test('marks remain removable after reopening; undo removes new saved strokes without flattening forms', async () => {
  const file = await fixture(); const session = await TextSession.open(file.store, font);
  const first = session.addStroke(1, 'scribble', [[50, 300], [200, 320]]); await session.save();
  session.addStroke(1, 'marker', [[50, 650], [300, 650]]); await session.save();
  session.undoStroke(); await session.save();
  assert.deepEqual((await readTextPdf(file.bytes())).strokes.map(stroke => stroke.id), [first.id]);
  const reopened = await TextSession.open(file.store, font); assert.equal(reopened.canUndoStroke, false);
  reopened.deleteStroke(first.id); await reopened.save();
  assert.equal((await readTextPdf(file.bytes())).strokes.length, 0);
  const pdf = await PDFDocument.load(file.bytes()); assert.equal(pdf.getForm().getTextField('Answer').getText(), 'Original');
  assert.equal(pdf.getPages()[0]!.node.Annots()!.size(), 3);
});

test('tap dots and rotated cropped-page points have visible verified appearances', async () => {
  const file = await fixture(true); const session = await TextSession.open(file.store, font);
  const dot = session.addStroke(1, 'scribble', [[40, 40]], 4); await session.save();
  const snapshot = await readTextPdf(file.bytes()); assert.equal(snapshot.strokes[0]!.id, dot.id);
  assert.deepEqual(snapshot.strokes[0]!.points, [[40, 40], [40, 40]]);
  assert.deepEqual(snapshot.strokes[0]!.rect, [35.5, 35.5, 44.5, 44.5]);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(1); assert.equal(page.rotate, 90);
    const operators = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
    assert(operators.fnArray.some((op, i) => op === OPS.constructPath && operators.argsArray[i][0] === OPS.fill));
  } finally { await task.destroy(); }
});

test('drawing interactions defer writes and external changes keep pending marks', async () => {
  const file = await fixture(); const session = await TextSession.open(file.store, font);
  const release = session.beginInteraction(); const stroke = session.addStroke(1, 'scribble', [[100, 200], [200, 300]]);
  const saving = session.saveWhenIdle(); await setImmediate(); assert.equal(file.writes(), 0);
  release(); await saving; assert.equal(file.writes(), 1);
  const nextRelease = session.beginInteraction(); session.addStroke(1, 'marker', [[50, 655], [300, 655]]);
  const next = session.saveWhenIdle(); await setImmediate();
  const external = await PDFDocument.load(file.bytes()); external.setTitle('External change'); const bytes = await external.save(); file.replace(bytes);
  nextRelease(); await assert.rejects(next, /changed outside/);
  assert.deepEqual(file.bytes(), bytes); assert.equal(session.snapshot.strokes.length, 2);
  assert.equal(session.snapshot.strokes[0]!.id, stroke.id); assert.equal(session.canUndoStroke, true);
  assert.throws(() => session.undoStroke(), /Reload/); assert.equal(session.canUndoStroke, true);
});

test('invalid or locked strokes are rejected without changing the session', async () => {
  const file = await fixture(); const session = await TextSession.open(file.store, font);
  assert.throws(() => session.addStroke(1, 'scribble', [[NaN, 50]]), /Invalid/);
  assert.throws(() => session.addStroke(1, 'marker', [[1000, 50]]), /Invalid/);
  assert.throws(() => session.addStroke(2, 'marker', [[50, 50]]), /does not exist/);
  assert.throws(() => session.addStroke(1, 'scribble', [[50, 50]], -1), /Invalid/);
  assert.equal(session.dirty, false);
  const stroke = session.addStroke(1, 'scribble', [[100, 100], [200, 200]]); await session.save();
  const pdf = await PDFDocument.load(file.bytes());
  const dict = pdf.getPages()[0]!.node.Annots()!.asArray().map(ref => pdf.context.lookup(ref, PDFDict)).find(dict => dict.has(PDFName.of('PFSKind')))!;
  dict.set(PDFName.of('F'), pdf.context.obj(4 | 64)); file.replace(await pdf.save());
  const locked = await TextSession.open(file.store, font); assert.throws(() => locked.deleteStroke(stroke.id), /cannot be removed/);
  assert.equal(locked.dirty, false);
});

test('stroke simplification preserves endpoints, corners and short tap paths', () => {
  assert.deepEqual(simplifyStroke([[0, 0], [1, 0.01], [2, 0], [3, 0]]), [[0, 0], [3, 0]]);
  assert.deepEqual(simplifyStroke([[0, 0], [1, 0], [1, 2], [2, 2]], 0.1), [[0, 0], [1, 0], [1, 2], [2, 2]]);
  assert.deepEqual(simplifyStroke([[5, 5]]), [[5, 5]]);
});
