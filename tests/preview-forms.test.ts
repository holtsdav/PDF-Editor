import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { loadPdfDocument } from '../src/pdf/pdf-load.ts';
import { previewForms, ownedName } from './fixtures/preview-forms.ts';
import { createCanvas } from '@napi-rs/canvas';
import { TextSession } from '../src/pdf/text-session.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;

/** Independently rasterize only the untouched Preview annotation regions. */
async function appearancePixels(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(1), canvas = createCanvas(600, 800), context = canvas.getContext('2d');
    await page.render({ canvasContext: context as never, viewport: page.getViewport({ scale: 1 }) }).promise;
    return [context.getImageData(240, 160, 160, 50).data, context.getImageData(240, 225, 110, 50).data];
  } finally { await task.destroy(); }
}
function memory(seed: Uint8Array) {
  let bytes = seed.slice(), writes = 0; const backups: Uint8Array[] = [];
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); writes++; }, backup: async (value: Uint8Array) => { backups.push(value.slice()); return 'original.pdf'; } }, bytes: () => bytes, writes: () => writes, backups };
}

function stream(pdf: PDFDocument, ref: PDFRef): PDFStream {
  const object = pdf.context.lookup(ref); assert(object instanceof PDFStream); return object;
}

test('Preview-style rewrites use the active object index and retain every page, field and foreign annotation on display', async () => {
  const sample = await previewForms(), file = memory(sample.bytes), session = await TextSession.open(file.store, font);
  const stale = await PDFDocument.load(sample.bytes); assert.equal(stale.getPageCount(), 1, 'the pinned library reproduces the stale compressed-object bug');
  const source = await loadPdfDocument(sample.bytes), originalAnnotations = sample.foreign.map(ref => source.context.lookup(ref, PDFDict).toString());
  assert.equal(session.snapshot.pages.length, 2);
  assert.equal(session.snapshot.fields.length, 2); assert.equal(session.snapshot.fields.find(field => field.name === 'Existing form')!.alignment, 'center');
  assert.equal(session.snapshot.fields.find(field => field.name === ownedName)!.owned, true);
  const rendered = await session.renderBytes(), display = await loadPdfDocument(rendered);
  assert.equal(display.getForm().getFields().length, 2);
  assert.deepEqual(sample.foreign.map(ref => display.context.lookup(ref, PDFDict).toString()), originalAnnotations);
  assert.deepEqual(stream(display, sample.stray).getContents(), stream(source, sample.stray).getContents());
  assert.deepEqual(await appearancePixels(rendered), await appearancePixels(sample.bytes));
  await session.saveWhenIdle(); assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), sample.bytes); assert.deepEqual(file.backups, []);
  const task = getDocument({ data: rendered.slice(), standardFontDataUrl });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1), annotations = await page.getAnnotations();
    assert.equal(pdf.numPages, 2); assert(annotations.some(item => item.subtype === 'Square' && item.hasAppearance));
    assert(annotations.some(item => item.subtype === 'FreeText' && item.hasAppearance));
    assert((await page.getOperatorList()).fnArray.length > 0);
  } finally { await task.destroy(); }
});

test('save, recovery, undo and reopen keep opaque appearances and resources across edits to both original fields', async () => {
  const sample = await previewForms(), file = memory(sample.bytes), source = await loadPdfDocument(sample.bytes);
  const originalAnnotations = sample.foreign.map(ref => source.context.lookup(ref, PDFDict).toString());
  const originalStream = stream(source, sample.stray), originalFont = source.context.lookup(sample.courier, PDFDict).toString();
  let session = await TextSession.open(file.store, font);
  session.setValue(ownedName, 'Changed box'); await session.save();
  session.undoStroke(); await session.save(); session.redoStroke(); await session.save();
  for (let cycle = 0; cycle < 3; cycle++) {
    session = await TextSession.open(file.store, font); session.setValue('Existing form', 'Changed form ' + cycle); await session.save();
    const saved = await loadPdfDocument(file.bytes()), acro = saved.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    assert.equal(acro.lookup(PDFName.of('Fields'), PDFArray).size(), 2); assert.equal(saved.getForm().getFields().length, 2);
    assert.equal(saved.getPageCount(), 2); assert.deepEqual(stream(saved, sample.obsolete).getContents(), stream(source, sample.obsolete).getContents());
    assert.deepEqual(stream(saved, sample.stray).getContents(), originalStream.getContents());
    assert.equal(stream(saved, sample.stray).dict.toString(), originalStream.dict.toString());
    assert.equal(saved.context.lookup(sample.courier, PDFDict).toString(), originalFont);
    assert.deepEqual(sample.foreign.map(ref => saved.context.lookup(ref, PDFDict).toString()), originalAnnotations);
    assert.equal(saved.getForm().getTextField(ownedName).getText(), 'Changed box');
  }
  const added = session.add(2, [30, 540, 240, 575], 14, true); session.setValue(added.name, 'New box café');
  session.addStroke(2, 'marker', [[30, 500], [200, 500]], 10, [1, 1, 0]); await session.save();
  const reopened = await TextSession.open(file.store, font); assert.equal(reopened.snapshot.fields.length, 3); assert.equal(reopened.snapshot.strokes.length, 1);
  assert.deepEqual(file.backups[0], sample.bytes);
  assert.deepEqual(await appearancePixels(file.bytes()), await appearancePixels(sample.bytes));
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const pdf = await task.promise, first = await (await pdf.getPage(1)).getAnnotations(), second = await (await pdf.getPage(2)).getAnnotations();
    assert(first.some(item => item.fieldName === 'Existing form' && item.fieldValue === 'Changed form 2'));
    assert(first.some(item => item.fieldName === ownedName && item.fieldValue === 'Changed box'));
    assert(first.some(item => item.subtype === 'FreeText' && item.hasAppearance)); assert(first.some(item => item.subtype === 'Square' && item.hasAppearance));
    assert(second.some(item => item.fieldName === added.name && item.fieldValue === 'New box café')); assert(second.some(item => item.subtype === 'Ink'));
  } finally { await task.destroy(); }
});

test('genuinely malformed active field entries still reject editing despite obsolete payloads', async () => {
  for (const kind of ['stream', 'nested', 'cycle', 'duplicate']) {
    const sample = await previewForms(), pdf = await loadPdfDocument(sample.bytes), acro = pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict), fields = acro.lookup(PDFName.of('Fields'), PDFArray);
    if (kind === 'stream') fields.push(sample.stray);
    if (kind === 'nested') pdf.getForm().getTextField(ownedName).acroField.dict.lookup(PDFName.of('Kids'), PDFArray).push(sample.stray);
    if (kind === 'cycle') pdf.getForm().getTextField(ownedName).acroField.dict.set(PDFName.of('Kids'), pdf.context.obj([fields.get(1)]));
    if (kind === 'duplicate') fields.push(fields.get(1));
    const bytes = await pdf.save({ updateFieldAppearances: false, useObjectStreams: false }), file = memory(bytes);
    await assert.rejects(TextSession.open(file.store, font), /Malformed PDF/); assert.equal(file.writes(), 0);
  }
});

test('Preview-style external replacements retain conflicts and clear history on explicit reload', async () => {
  const sample = await previewForms(), file = memory(sample.bytes), session = await TextSession.open(file.store, font);
  session.setValue(ownedName, 'Pending local edit');
  const external = memory(sample.bytes), writer = await TextSession.open(external.store, font);
  writer.setValue('Existing form', 'External form edit'); await writer.save();
  await file.store.write(external.bytes()); await session.checkExternal();
  assert.equal(session.status, 'conflict'); assert.equal(session.snapshot.fields.find(field => field.name === ownedName)!.value, 'Pending local edit');
  await assert.rejects(session.save(), /changed outside/); assert.equal(file.writes(), 1);
  assert.deepEqual(file.bytes(), external.bytes()); assert.deepEqual(file.backups, []);
  await session.reload(); assert.equal(session.status, 'saved'); assert.equal(session.snapshot.pages.length, 2);
  assert.equal(session.snapshot.fields.find(field => field.name === 'Existing form')!.value, 'External form edit');
  assert.equal(session.snapshot.fields.find(field => field.name === ownedName)!.value, 'Existing box');
  assert.equal(session.canUndoStroke, false); assert.equal(session.canRedoStroke, false);
  session.undoStroke(); assert.deepEqual(file.bytes(), external.bytes());
});

test('active object indexes reject wrong headers and free catalogs without resurrecting obsolete objects', async () => {
  const sample = await previewForms(), original = await loadPdfDocument(sample.bytes), root = original.context.trailerInfo.Root as PDFRef;
  const source = new TextDecoder('latin1').decode(sample.bytes), marker = `${root.objectNumber} ${root.generationNumber} obj`;
  const position = source.indexOf('\n' + marker) + 1; assert(position > 0);
  const broken = sample.bytes.slice(); broken[position] = broken[position]! === 50 ? 51 : 50;
  const file = memory(broken); await assert.rejects(TextSession.open(file.store, font), /object index does not match/); assert.equal(file.writes(), 0);
  const footer = /startxref\s+(\d+)\s+%%EOF/.exec(source.slice(source.lastIndexOf('startxref')))!;
  const offset = Number(footer[1]), section = source.slice(offset), lines = section.split('\n');
  assert.equal(lines[0], 'xref'); assert.equal(Number(lines[1]!.split(' ')[0]), 0);
  const row = root.objectNumber + 2; assert(lines[row]!.endsWith(' n ')); lines[row] = lines[row]!.replace(' n ', ' f ');
  const replacement = new TextEncoder().encode(lines.join('\n')), freed = new Uint8Array(offset + replacement.length);
  freed.set(sample.bytes.subarray(0, offset)); freed.set(replacement, offset);
  const deleted = memory(freed); await assert.rejects(TextSession.open(deleted.store, font), /active PDF catalog/); assert.equal(deleted.writes(), 0);
});

test('ordinary compressed PDFs and incremental classic indexes retain the existing loading behavior', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  for (const useObjectStreams of [true, false]) {
    let bytes = await pdf.save({ useObjectStreams, updateFieldAppearances: false });
    if (!useObjectStreams) {
      const text = new TextDecoder('latin1').decode(bytes), previous = Number(/startxref\s+(\d+)\s+%%EOF/.exec(text.slice(text.lastIndexOf('startxref')))![1]);
      const extension = new TextEncoder().encode(`\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${pdf.context.trailerInfo.Root!.toString()} /Prev ${previous} >>\nstartxref\n${bytes.length + 1}\n%%EOF\n`);
      const combined = new Uint8Array(bytes.length + extension.length); combined.set(bytes); combined.set(extension, bytes.length); bytes = combined;
    }
    assert.equal((await loadPdfDocument(bytes)).getPageCount(), 1); assert.equal((await readTextPdf(bytes)).pages.length, 1);
  }
});

test('missing classic trailer Size retains repair loading, while explicit invalid sizes reject before writing', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]); pdf.addPage([600, 800]);
  const field = pdf.getForm().createTextField('Repairable form'); field.setText('Original answer');
  field.addToPage(page, { x: 30, y: 540, width: 180, height: 30 });
  const bytes = await pdf.save({ useObjectStreams: false });
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const offset = Number(/startxref\s+(\d+)\s+%%EOF/.exec(tail)![1]);
  const section = new TextDecoder('latin1').decode(bytes.subarray(offset)); assert(/\/Size \d+/.test(section));
  /** Change only the ASCII trailer, preserving binary object bytes and their indexed offsets. */
  const withSize = (value?: string): Uint8Array => {
    const suffix = new TextEncoder().encode(section.replace(/\/Size \d+/, value === undefined ? '' : '/Size ' + value));
    const result = new Uint8Array(offset + suffix.length); result.set(bytes.subarray(0, offset)); result.set(suffix, offset); return result;
  };
  const missing = withSize(); assert.equal((await PDFDocument.load(missing)).getPageCount(), 2);
  const file = memory(missing), session = await TextSession.open(file.store, font);
  assert.equal(session.snapshot.pages.length, 2); assert.equal(session.snapshot.fields[0]!.value, 'Original answer');
  await session.saveWhenIdle(); assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), missing);
  session.setValue('Repairable form', 'Updated answer'); await session.save(); assert.deepEqual(file.backups[0], missing);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const saved = await task.promise; assert.equal(saved.numPages, 2);
    assert((await (await saved.getPage(1)).getAnnotations()).some(item => item.fieldName === 'Repairable form' && item.fieldValue === 'Updated answer'));
  } finally { await task.destroy(); }
  for (const size of ['null', '0', '-1', '1.5', '1000001', '1', '(invalid)']) {
    const invalid = memory(withSize(size)); await assert.rejects(TextSession.open(invalid.store, font));
    assert.equal(invalid.writes(), 0); assert.deepEqual(invalid.backups, []);
  }
});
