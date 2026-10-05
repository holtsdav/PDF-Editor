import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFString, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
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

test('external edits prevent overwriting and keep pending text for recovery', async () => {
  const file = memory(await fixture()); const session = await TextSession.open(file.store, font);
  session.setValue('Name', 'My pending answer');
  const other = await PDFDocument.load(file.bytes()); other.setTitle('External modification'); file.replace(await other.save());
  const changed = file.bytes().slice(); await assert.rejects(session.save(), /changed outside/);
  assert.deepEqual(file.bytes(), changed); assert.equal(file.writes(), 0); assert.equal(session.status, 'conflict');
  assert.equal(session.snapshot.fields.find(field => field.name === 'Name')?.value, 'My pending answer');
  await session.reload(); assert.equal(session.status, 'saved'); assert.equal(session.dirty, false);
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
