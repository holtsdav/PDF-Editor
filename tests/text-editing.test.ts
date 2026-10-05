import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { PDFDocument, PDFDict, PDFName, PDFString, degrees } from 'pdf-lib';
import { AnnotationMode, OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextSession } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import type { PdfStore } from '../src/pdf/text-session.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;

async function fixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Preserve this metadata');
  const first = pdf.addPage(); const second = pdf.addPage();
  first.drawText('Original page content', { x: 30, y: 750, size: 18 });
  first.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 30, 30],
    A: { S: 'URI', URI: PDFString.of('https://example.com') } })));
  const shared = pdf.getForm().createTextField('Name');
  shared.setText('Before');
  for (const page of [first, second]) shared.addToPage(page, { x: 30, y: 500, width: 240, height: 24 });
  const readonly = pdf.getForm().createTextField('Locked');
  readonly.setText('Keep'); readonly.addToPage(first); readonly.enableReadOnly();
  const checkbox = pdf.getForm().createCheckBox('Checkbox');
  checkbox.addToPage(first); checkbox.check();
  return pdf.save();
}
function memory(bytes: Uint8Array) {
  let current: Uint8Array = bytes.slice(); const backups: Uint8Array[] = []; let writes = 0;
  const store: PdfStore = {
    read: async () => current.slice(),
    write: async bytes => { current = bytes.slice(); writes++; },
    backup: async bytes => { backups.push(bytes.slice()); return 'backup.pdf'; }
  };
  return { store, backups, bytes: () => current, replace: (bytes: Uint8Array) => { current = bytes; }, writes: () => writes };
}

test('fills all shared widgets, preserves unrelated content, and persists Unicode appearances', async () => {
  const seed = await fixture(); const file = memory(seed); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'Grüße aus München – Ελληνικά'); await session.save();
  assert.equal(session.status, 'saved'); assert.equal(file.backups.length, 1); assert.deepEqual(file.backups[0], seed);
  const pdf = await PDFDocument.load(file.bytes());
  assert.equal(pdf.getTitle(), 'Preserve this metadata'); assert.equal(pdf.getPageCount(), 2);
  assert.equal(pdf.getForm().getTextField('Locked').getText(), 'Keep'); assert(pdf.getForm().getCheckBox('Checkbox').isChecked());
  const link = pdf.getPages()[0]!.node.Annots()!.asArray().map(ref => pdf.context.lookup(ref, PDFDict))
    .find(dict => dict.get(PDFName.of('Subtype'))?.toString() === '/Link');
  assert.equal(link?.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText(), 'https://example.com');
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const document = await task.promise;
    const text = await (await document.getPage(1)).getTextContent();
    assert(text.items.some(item => 'str' in item && item.str === 'Original page content'));
    for (const number of [1, 2]) {
      const widgets = await (await document.getPage(number)).getAnnotations({ intent: 'display' });
      const field = widgets.find(widget => widget.fieldName === 'Name');
      assert.equal(field?.fieldValue, 'Grüße aus München – Ελληνικά'); assert.equal(field?.hasAppearance, true);
    }
  } finally { await task.destroy(); }
});

test('new transparent text boxes keep stable IDs, stay editable, and do not accumulate on repeated saves', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const box = session.add(2, [50, 350, 300, 400], 14, true);
  session.setValue(box.name, 'First answer\nSecond line'); await session.save(); const size = file.bytes().length;
  session.setValue(box.name, 'Updated answer\nSecond line'); await session.save();
  const snapshot = await readTextPdf(file.bytes());
  const saved = snapshot.fields.filter(field => field.owned);
  assert.equal(saved.length, 1); assert.equal(saved[0]?.name, box.name); assert.equal(saved[0]?.multiline, true);
  assert.equal(saved[0]?.value, 'Updated answer\nSecond line'); assert(file.bytes().length < size + 3000);
  const pdf = await PDFDocument.load(file.bytes());
  assert.equal(pdf.getForm().getTextField(box.name).acroField.getWidgets()[0]?.getAppearanceCharacteristics()?.getBackgroundColor(), undefined);
  const reopened = await TextSession.open(file.store, font); reopened.setValue(box.name, 'After reopening'); await reopened.save();
  assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === box.name)?.value, 'After reopening');
  reopened.delete(box.name); await reopened.save(); assert(!(await readTextPdf(file.bytes())).fields.some(field => field.name === box.name));
});

test('moving, resizing and changing size persist the same widget and regenerate editable appearances', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const box = session.add(1, [50, 250, 250, 275], 14, false);
  session.setValue(box.name, 'A long answer with several words that wraps into a taller box.'); await session.save();
  const reopened = await TextSession.open(file.store, font);
  reopened.updateBox(box.name, [100, 200, 230, 360], { fontSize: 18, multiline: true }); await reopened.save();
  reopened.updateBox(box.name, [120, 180, 320, 340]); await reopened.save();
  const snapshot = await readTextPdf(file.bytes()); const owned = snapshot.fields.filter(field => field.owned);
  assert.equal(owned.length, 1); assert.equal(owned[0]!.name, box.name); assert.equal(owned[0]!.widgets.length, 1);
  assert.deepEqual(owned[0]!.widgets[0]!.rect, [120, 180, 320, 340]);
  assert.equal(owned[0]!.fontSize, 18); assert.equal(owned[0]!.multiline, true);
  assert.equal(snapshot.fields.find(field => field.name === 'Name')?.value, 'Before');
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const document = await task.promise; const page = await document.getPage(1);
    const widget = (await page.getAnnotations({ intent: 'display' })).find(widget => widget.fieldName === box.name);
    assert.deepEqual(widget?.rect, [120, 180, 320, 340]); assert.equal(widget?.hasAppearance, true);
    assert.equal(widget?.fieldValue, box.value);
  } finally { await task.destroy(); }
  reopened.delete(box.name); await reopened.save();
  assert(!(await readTextPdf(file.bytes())).fields.some(field => field.name === box.name));
});

test('box changes reject authored fields and invalid page geometry before mutating the model', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  assert.throws(() => session.updateBox('Name', [50, 50, 150, 100]), /Only added/);
  const box = session.add(1, [50, 250, 250, 275], 14, true); await session.save();
  assert.throws(() => session.updateBox(box.name, [-1, 50, 100, 100]), /inside its PDF page/);
  assert.throws(() => session.updateBox(box.name, [50, 50, 100, 100], { fontSize: NaN }), /inside its PDF page/);
  assert.equal(session.dirty, false); assert.deepEqual(box.widgets[0]!.rect, [50, 250, 250, 275]);
});

test('long unbroken answers wrap in saved PDF appearances instead of extending beyond the box', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const box = session.add(1, [50, 200, 150, 500], 14, true);
  const value = 'Supercalifragilisticexpialidocious'.repeat(3);
  session.setValue(box.name, value); await session.save();
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(1);
    const operators = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
    const baselines = operators.fnArray.flatMap((op, index) => op === OPS.setTextMatrix ? [Number(operators.argsArray[index][0][5])] : []).filter(y => y < 300);
    assert(baselines.length >= 6, `Expected wrapped lines, got ${baselines.length}`);
    assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === box.name)?.value, value);
  } finally { await task.destroy(); }
});

test('external edits prevent overwriting and keep pending text for recovery', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'My pending answer');
  const other = await PDFDocument.load(file.bytes()); other.setTitle('External modification'); file.replace(await other.save());
  const changed = file.bytes().slice(); await assert.rejects(session.save(), /changed outside/);
  assert.deepEqual(file.bytes(), changed); assert.equal(file.writes(), 0); assert.equal(session.status, 'conflict');
  assert.equal(session.snapshot.fields.find(field => field.name === 'Name')?.value, 'My pending answer');
  await session.reload(); assert.equal(session.status, 'saved'); assert.equal(session.dirty, false);
});

test('three multiline answers fit in the same space in the editor and saved appearance', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const box = session.add(1, [50, 350, 350, 410], 14, true);
  session.setValue(box.name, 'First line\nSecond line\nThird line'); await session.save();
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const operators = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
    const baselines = operators.fnArray.flatMap((op, index) => op === OPS.setTextMatrix ? [Number(operators.argsArray[index][0][5])] : []).slice(-3);
    assert.equal(baselines.length, 3);
    // Inspect the independently parsed drawing operations: all three baselines
    // lie inside the 60pt box, spaced at 1.2em rather than the font's full bbox.
    assert(baselines.every(y => y > 1 && y < 59), `Drawing baselines: ${JSON.stringify(baselines)}`);
    assert(Math.abs(baselines[0]! - baselines[1]! - 16.8) < 0.001);
    assert(Math.abs(baselines[1]! - baselines[2]! - 16.8) < 0.001);
    assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === box.name)?.value, 'First line\nSecond line\nThird line');
  } finally { await task.destroy(); }
});

test('changes during a write are queued and the final value wins without parallel writes', async () => {
  const file = memory(await fixture()); let concurrent = 0; let maximum = 0;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const store: PdfStore = { ...file.store, write: async bytes => {
    maximum = Math.max(maximum, ++concurrent);
    if (first) { first = false; entered(); await barrier; }
    await file.store.write(bytes); concurrent--;
  } };
  const session = await TextSession.open(store, font); session.setValue('Name', 'First'); const a = session.save();
  await started; session.setValue('Name', 'Final'); await session.checkExternal(); const b = session.save(); release();
  await Promise.all([a, b]); assert.equal(maximum, 1); assert.equal(session.status, 'saved');
  assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === 'Name')?.value, 'Final');
});

test('automatic saves wait through blank placement, typing, and focus moving to another box', async () => {
  const seed = await fixture(); const file = memory(seed); const session = await TextSession.open(file.store, font);
  const endPlacement = session.beginInteraction();
  const first = session.add(1, [50, 250, 290, 270], 14, false);
  const endFirstFocus = session.beginInteraction(); endPlacement();
  const saving = session.saveWhenIdle();
  await setImmediate(); assert.deepEqual(file.bytes(), seed); assert.equal(file.writes(), 0);
  session.setValue(first.name, 'First answer');
  // Blur and focus are consecutive synchronous browser events. A brief zero
  // count must not let the queued writer refresh the PDF between them.
  endFirstFocus(); const endNextPlacement = session.beginInteraction();
  const second = session.add(1, [50, 200, 290, 220], 14, false);
  const endSecondFocus = session.beginInteraction(); endNextPlacement();
  session.setValue(second.name, 'Second answer');
  await setImmediate(); assert.equal(file.writes(), 0);
  endSecondFocus(); endSecondFocus(); await saving;
  assert.equal(file.writes(), 1);
  const owned = (await readTextPdf(file.bytes())).fields.filter(field => field.owned);
  assert.deepEqual(owned.map(field => field.value), ['First answer', 'Second answer']);
  assert.equal(session.status, 'saved');
});

test('a tap during save preparation defers the write and saves the final answer once', async () => {
  const file = memory(await fixture());
  let prepared!: () => void; let continueBackup!: () => void;
  const preparation = new Promise<void>(resolve => { prepared = resolve; });
  const barrier = new Promise<void>(resolve => { continueBackup = resolve; });
  let first = true;
  const session = await TextSession.open({ ...file.store, backup: async bytes => {
    if (first) { first = false; prepared(); await barrier; }
    return file.store.backup(bytes);
  } }, font);
  session.setValue('Name', 'Before the next tap'); const saving = session.saveWhenIdle();
  await preparation;
  const endPlacement = session.beginInteraction();
  const box = session.add(2, [50, 350, 300, 375], 14, false);
  const endFocus = session.beginInteraction(); endPlacement();
  session.setValue(box.name, 'Typed while preparation was pending'); continueBackup();
  await setImmediate(); assert.equal(file.writes(), 0);
  endFocus(); await saving;
  assert.equal(file.writes(), 1); assert.equal(session.dirty, false);
  assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === box.name)?.value, 'Typed while preparation was pending');
});

test('a focused second view delays automatic saving but explicit Save flushes without deadlocking', { timeout: 5000 }, async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const endFocus = session.beginInteraction(); session.setValue('Name', 'Saved explicitly');
  const automatic = session.saveWhenIdle(); await setImmediate(); assert.equal(file.writes(), 0);
  await Promise.all([automatic, session.save()]);
  assert.equal(file.writes(), 1); assert.equal(session.status, 'saved'); endFocus();
  assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === 'Name')?.value, 'Saved explicitly');
});

test('a new interaction during the final vault read also defers automatic replacement', async () => {
  const file = memory(await fixture()); let reads = 0;
  let reading!: () => void; let continueRead!: () => void;
  const finalRead = new Promise<void>(resolve => { reading = resolve; });
  const barrier = new Promise<void>(resolve => { continueRead = resolve; });
  const session = await TextSession.open({ ...file.store, read: async () => {
    const bytes = await file.store.read();
    if (++reads === 3) { reading(); await barrier; }
    return bytes;
  } }, font);
  session.setValue('Name', 'Initial'); const saving = session.saveWhenIdle(); await finalRead;
  const endFocus = session.beginInteraction(); session.setValue('Name', 'Final after tap'); continueRead();
  await setImmediate(); assert.equal(file.writes(), 0); endFocus(); await saving;
  assert.equal(file.writes(), 1);
  assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === 'Name')?.value, 'Final after tap');
});

test('discard/reload cancels a waiting automatic save without writing the discarded text', { timeout: 5000 }, async () => {
  const seed = await fixture(); const file = memory(seed); const session = await TextSession.open(file.store, font);
  const endFocus = session.beginInteraction(); session.setValue('Name', 'Discard this');
  const automatic = session.saveWhenIdle(); await setImmediate();
  await session.reload(); await automatic; endFocus();
  assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), seed);
  assert.equal(session.snapshot.fields.find(field => field.name === 'Name')?.value, 'Before');
});

test('an external change while autosave waits is detected before the PDF is overwritten', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  const endFocus = session.beginInteraction(); session.setValue('Name', 'Pending answer');
  const automatic = session.saveWhenIdle();
  const other = await PDFDocument.load(file.bytes()); other.setTitle('Changed while focused');
  const external = await other.save(); file.replace(external); endFocus();
  await assert.rejects(automatic, /changed outside/);
  assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), external); assert.equal(session.status, 'conflict');
});

test('backup failure leaves the source byte-for-byte unchanged and supports retry', async () => {
  const seed = await fixture(); const file = memory(seed); let fail = true;
  const session = await TextSession.open({ ...file.store, backup: async bytes => {
    if (fail) throw new Error('Disk full'); return file.store.backup(bytes);
  } }, font);
  session.setValue('Name', 'Pending'); await assert.rejects(session.save(), /Disk full/);
  assert.deepEqual(file.bytes(), seed); assert.equal(file.writes(), 0); assert.equal(session.status, 'error');
  fail = false; await session.save(); assert.equal(session.status, 'saved');
});

test('restoring an original keeps a verified recovery copy of the edited PDF', async () => {
  const seed = await fixture(); const file = memory(seed); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'Saved answer'); await session.save(); const edited = file.bytes().slice();
  session.setValue('Name', 'Discard pending answer'); await session.restore(seed);
  assert.deepEqual(file.bytes(), seed); assert.deepEqual(file.backups[1], edited);
  assert.equal(session.dirty, false); assert.equal(session.status, 'saved');
  assert.equal(session.snapshot.fields.find(field => field.name === 'Name')?.value, 'Before');
  await session.restore(edited); assert.deepEqual(file.bytes(), edited);
});

test('unsupported glyphs do not silently save missing-letter appearances', async () => {
  const seed = await fixture(); const file = memory(seed); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'An emoji 😀'); await assert.rejects(session.save(), /cannot render U\+1F600/);
  assert.deepEqual(file.bytes(), seed); assert.equal(session.dirty, true);
});

test('a clean automatic save leaves Saved status intact even while a box is focused', { timeout: 5000 }, async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'Committed'); await session.save();
  const release = session.beginInteraction();
  try {
    await session.saveWhenIdle();
    assert.equal(session.status, 'saved'); assert.equal(session.dirty, false);
    assert.equal(file.writes(), 1);
  } finally { release(); }
});

test('cropped rotated pages retain widget geometry and editable orientation', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([612, 792]);
  page.setCropBox(20, 20, 540, 720); page.setRotation(degrees(90));
  const file = memory(await pdf.save()); const session = await TextSession.open(file.store, font);
  const box = session.add(1, [50, 200, 80, 440], 14, false, 90);
  session.setValue(box.name, 'Landscape answer'); await session.save();
  const snapshot = await readTextPdf(file.bytes());
  assert.deepEqual(snapshot.pages[0], [20, 20, 560, 740]);
  assert.deepEqual(snapshot.fields[0]?.widgets[0], { page: 1, rect: [50, 200, 80, 440], rotation: 90 });
  const output = await PDFDocument.load(file.bytes()); assert.equal(output.getPages()[0]?.getRotation().angle, 90);
});

test('rejects read-only fields and documents with XFA or signature dictionaries', async () => {
  const bytes = await fixture(); const file = memory(bytes); const session = await TextSession.open(file.store, font);
  assert.throws(() => session.setValue('Locked', 'No'), /not editable/);
  const xfa = await PDFDocument.load(bytes);
  xfa.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('XFA'), PDFString.of('data'));
  await assert.rejects(readTextPdf(await xfa.save()), /XFA/);
  const signed = await PDFDocument.load(bytes);
  signed.context.register(signed.context.obj({ FT: 'Sig', ByteRange: [0, 10, 20, 30] }));
  await assert.rejects(readTextPdf(await signed.save()), /signature/);
});
