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
/** Track source writes and exact original copies to detect destructive loading or save regressions. */
function memory(seed: Uint8Array) {
  let bytes = seed.slice(), writes = 0; const backups: Uint8Array[] = [];
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); writes++; }, backup: async (value: Uint8Array) => { backups.push(value.slice()); return 'original.pdf'; } }, bytes: () => bytes, writes: () => writes, backups };
}

/** Require a stable annotation reference to resolve to its retained opaque stream. */
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

test('ordinary compressed PDFs and incremental classic or stream indexes retain the existing loading behavior', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  for (const useObjectStreams of [true, false]) {
    let bytes = await pdf.save({ useObjectStreams, updateFieldAppearances: false });
    assert.equal((await loadPdfDocument(bytes)).getPageCount(), 1);
    const text = new TextDecoder('latin1').decode(bytes), previous = Number(/startxref\s+(\d+)\s+%%EOF/.exec(text.slice(text.lastIndexOf('startxref')))![1]);
    if (useObjectStreams) {
      const offset = bytes.length + 1, prefix = new TextEncoder().encode(`\n1000 0 obj\n<< /Type /XRef /Size 1001 /Root ${pdf.context.trailerInfo.Root!.toString()} /Prev ${previous} /W [1 4 2] /Index [1000 1] /Length 7 >>\nstream\n`);
      const entry = new Uint8Array(7); entry[0] = 1; new DataView(entry.buffer).setUint32(1, offset);
      const suffix = new TextEncoder().encode(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`);
      const combined = new Uint8Array(bytes.length + prefix.length + entry.length + suffix.length);
      combined.set(bytes); combined.set(prefix, bytes.length); combined.set(entry, bytes.length + prefix.length); combined.set(suffix, bytes.length + prefix.length + entry.length); bytes = combined;
    } else {
      const extension = new TextEncoder().encode(`\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${pdf.context.trailerInfo.Root!.toString()} /Prev ${previous} >>\nstartxref\n${bytes.length + 1}\n%%EOF\n`);
      const combined = new Uint8Array(bytes.length + extension.length); combined.set(bytes); combined.set(extension, bytes.length); bytes = combined;
    }
    assert.equal((await loadPdfDocument(bytes)).getPageCount(), 1); assert.equal((await readTextPdf(bytes)).pages.length, 1);
    const task = getDocument({ data: bytes.slice() });
    try { assert.equal((await task.promise).numPages, 1); } finally { await task.destroy(); }
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

test('recognized invalid startxref offsets reject before editing while a missing footer retains repair loading', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]); pdf.addPage([600, 800]);
  page.drawText('Anonymous index fixture');
  const field = pdf.getForm().createTextField('Index form'); field.setText('Original answer');
  field.addToPage(page, { x: 30, y: 540, width: 180, height: 30 });
  const bytes = await pdf.save({ useObjectStreams: false }), source = new TextDecoder('latin1').decode(bytes);
  const footerStart = source.lastIndexOf('startxref'), actualOffset = Number(/startxref\s+(\d+)/.exec(source.slice(footerStart))![1]);
  const catalogOffset = source.indexOf('\n' + pdf.context.trailerInfo.Root!.toString().replace(' R', ' obj')) + 1;
  const contentOffset = source.indexOf('\n' + page.node.Contents()!.toString().match(/\d+ \d+ R/)![0].replace(' R', ' obj')) + 1;
  assert(catalogOffset > 0); assert(contentOffset > 0);
  /** Replace the final footer without shifting any indexed object bytes. */
  const withOffset = (value: string): Uint8Array => {
    const suffix = new TextEncoder().encode(`startxref\n${value}\n%%EOF\n`), result = new Uint8Array(footerStart + suffix.length);
    result.set(bytes.subarray(0, footerStart)); result.set(suffix, footerStart); return result;
  };
  assert.equal((await PDFDocument.load(withOffset('0'))).getPageCount(), 2, 'the pinned library ignores a malformed offset during its sequential scan');
  for (const offset of ['0', '-1', '1.5', 'invalid', String(bytes.length + 100), '9007199254740992', String(actualOffset + 1), String(catalogOffset), String(contentOffset)]) {
    const file = memory(withOffset(offset)); await assert.rejects(TextSession.open(file.store, font), /cross-reference offset/);
    assert.equal(file.writes(), 0); assert.deepEqual(file.backups, []);
  }
  const missing = bytes.slice(0, footerStart), file = memory(missing), session = await TextSession.open(file.store, font);
  assert.equal(session.snapshot.pages.length, 2); assert.equal(session.snapshot.fields[0]!.value, 'Original answer');
  await session.saveWhenIdle(); assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), missing);
  session.setValue('Index form', 'Updated answer'); await session.save(); assert.deepEqual(file.backups[0], missing);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const saved = await task.promise; assert.equal(saved.numPages, 2);
    assert((await (await saved.getPage(1)).getAnnotations()).some(item => item.fieldName === 'Index form' && item.fieldValue === 'Updated answer'));
  } finally { await task.destroy(); }
});

test('classic object headers accept PDF whitespace including NUL without shifting indexed offsets', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]); page.drawText('Anonymous whitespace fixture');
  const field = pdf.getForm().createTextField('Whitespace form'); field.setText('Original'); field.addToPage(page, { x: 50, y: 500, width: 200, height: 24 });
  const seed = await pdf.save({ useObjectStreams: false }), source = new TextDecoder('latin1').decode(seed);
  const headers = [...source.matchAll(/^(\d+) (\d+) obj\b/gm)]; assert(headers.length > 0);
  for (const whitespace of [0, 9, 10, 12, 13, 32]) {
    const bytes = seed.slice();
    for (const header of headers) {
      bytes[header.index! + header[1]!.length] = whitespace;
      bytes[header.index! + header[1]!.length + 1 + header[2]!.length] = whitespace;
    }
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1, 'the existing parser accepts the fixture');
    const file = memory(bytes), session = await TextSession.open(file.store, font);
    assert.equal(session.snapshot.fields[0]!.value, 'Original'); assert.equal(file.writes(), 0); assert.deepEqual(file.bytes(), bytes);
    session.setValue('Whitespace form', 'Saved after whitespace load'); await session.save(); assert.deepEqual(file.backups[0], bytes);
    const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
    try {
      const reopened = await (await task.promise).getPage(1), annotations = await reopened.getAnnotations();
      assert(annotations.some(a => a.subtype === 'Widget' && a.fieldValue === 'Saved after whitespace load' && a.hasAppearance));
      assert((await reopened.getTextContent()).items.some(item => 'str' in item && item.str === 'Anonymous whitespace fixture'));
    } finally { await task.destroy(); }
  }
  const invalid = seed.slice(), header = headers[0]!; invalid[header.index! + header[1]!.length] = 1;
  await assert.rejects(loadPdfDocument(invalid), /object index does not match/);
});
