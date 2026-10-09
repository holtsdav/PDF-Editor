import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFStream, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, writeTextPdf } from '../src/pdf/text-engine.ts';
import type { TextChanges } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import type { PdfDraft } from '../src/pdf/text-session.ts';
import { authoredForms, legacyBlank, prefixBlank, prefixValue, uuidCollision } from './fixtures/authored-forms.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;
function memory(seed: Uint8Array) {
  let bytes = seed.slice(), writes = 0, draft: PdfDraft | null = null; const backups: Uint8Array[] = [];
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); writes++; },
    backup: async (value: Uint8Array) => { backups.push(value.slice()); return 'original.pdf'; },
    draft: { read: async () => draft && structuredClone(draft), write: async (value: PdfDraft) => { draft = structuredClone(value); }, clear: async () => { draft = null; } } },
    bytes: () => bytes, writes: () => writes, backups };
}
function structure(pdf: PDFDocument) {
  return pdf.getForm().getFields().map(field => ({ name: field.getName(), ref: field.ref.toString(), flags: field.acroField.getFlags(),
    widgets: field.acroField.getWidgets().map(widget => ({ ref: pdf.context.getObjectRef(widget.dict)?.toString(), rect: widget.getRectangle(),
      flags: widget.getFlags(), mk: widget.dict.get(PDFName.of('MK'))?.toString(), bs: widget.dict.get(PDFName.of('BS'))?.toString() })) }));
}

test('opening, rendering, pruning and a clean autosave leave every existing blank and widget untouched', async () => {
  const seed = await authoredForms(), file = memory(seed), session = await TextSession.open(file.store, font);
  assert.equal(session.pruneEmptyBoxes(), 0); await session.renderBytes(); await session.saveWhenIdle();
  assert.equal(session.dirty, false); assert.equal(session.canUndoStroke, false); assert.equal(file.writes(), 0);
  assert.deepEqual(file.bytes(), seed); assert.deepEqual(file.backups, []);
  const snapshot = session.snapshot;
  for (const name of [prefixBlank, prefixValue, uuidCollision]) assert.equal(snapshot.fields.find(field => field.name === name)?.owned, false);
  assert.equal(snapshot.fields.find(field => field.name === legacyBlank)?.owned, true);
  const blank = snapshot.fields.find(field => field.name === 'Blank')!;
  assert.equal(blank.alignment, 'left'); assert.equal(blank.fontFamily, 'serif');
  assert.deepEqual(blank.widgets[0]!.appearance, { borderWidth: 2, borderStyle: 'solid', borderColor: [0.2, 0.3, 0.6], backgroundColor: [0.9, 0.95, 1] });
  assert.equal(snapshot.fields.find(field => field.name === 'Prefilled')?.alignment, 'right');
  assert.equal(snapshot.fields.find(field => field.name === 'Multiline')?.multiline, true);
  assert.equal(snapshot.fields.find(field => field.name === 'Readonly')?.readOnly, true);
});

test('existing form edits autosave, undo, redo and reopen with stable identities, options, styles and foreign content', async () => {
  const seed = await authoredForms(90), file = memory(seed), session = await TextSession.open(file.store, font);
  const original = await PDFDocument.load(seed), expectedStructure = structure(original);
  const readonlyAppearance = original.getForm().getTextField('Readonly').acroField.getWidgets()[0]!.getAppearances()!.normal as PDFStream;
  session.setValue('Blank', 'Filled blank'); await session.saveWhenIdle();
  session.undoStroke(); await session.saveWhenIdle(); assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === 'Blank')!.value, '');
  assert.equal(session.pruneEmptyBoxes(), 0);
  session.redoStroke(); await session.saveWhenIdle();
  session.setValue(prefixBlank, 'Prefix answer'); session.setValue(uuidCollision, 'UUID collision answer');
  session.setValue('Prefilled', 'Updated answer'); session.setValue('Multiline', 'Changed first row\nChanged second row');
  await session.checkpoint(); const recovered = await TextSession.open(file.store, font); assert.equal(recovered.dirty, true);
  await recovered.saveWhenIdle();
  const output = await PDFDocument.load(file.bytes()); assert.deepEqual(structure(output), expectedStructure);
  const readonlySaved = output.getForm().getTextField('Readonly').acroField.getWidgets()[0]!.getAppearances()!.normal as PDFStream;
  assert.deepEqual(readonlySaved.getContents(), readonlyAppearance.getContents());
  assert.equal(output.getPages()[0]!.getRotation().angle, 90);
  assert.equal(output.getForm().getTextField('Prefilled').getAlignment(), 2);
  assert.equal(output.getForm().getTextField('Prefilled').getMaxLength(), 40);
  assert.equal(output.getForm().getTextField('Prefilled').isRequired(), true);
  assert.equal(output.getForm().getTextField('Prefilled').isScrollable(), false);
  assert.equal(output.getForm().getCheckBox('Check').isChecked(), true);
  assert(output.getPages()[0]!.node.Annots()!.asArray().some(ref => output.context.lookup(ref, PDFDict).get(PDFName.of('NM'))?.toString() === '(foreign-note)'));
  const reopened = await TextSession.open(file.store, font);
  assert.equal(reopened.pruneEmptyBoxes(), 0); assert.equal(reopened.snapshot.fields.length, 8);
  assert.equal(reopened.snapshot.fields.find(field => field.name === uuidCollision)!.owned, false);
  assert.throws(() => reopened.delete(uuidCollision, true), /Only editable/);
  assert.throws(() => reopened.updateBox(prefixBlank, [1, 1, 50, 50]), /Only added/);
  assert.throws(() => reopened.setValue('Readonly', 'Changed'), /not editable/);
  reopened.setValue('Prefilled', 'x'.repeat(41)); await assert.rejects(reopened.save(), /at most 40/);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(1), widgets = await page.getAnnotations();
    for (const [name, value] of [['Blank', 'Filled blank'], [prefixBlank, 'Prefix answer'], [uuidCollision, 'UUID collision answer'], ['Prefilled', 'Updated answer'], ['Multiline', 'Changed first row\nChanged second row']]) {
      const widget = widgets.find(item => item.fieldName === name); assert.equal(widget?.fieldValue, value); assert.equal(widget?.hasAppearance, true);
    }
  } finally { await task.destroy(); }
  assert.deepEqual(file.backups[0], seed);
});

test('already saved plugin blanks and cleared existing boxes require explicit deletion; unsaved abandoned placeholders still prune', async () => {
  const file = memory(await authoredForms()), session = await TextSession.open(file.store, font);
  const saved = session.add(1, [30, 20, 200, 45], 14, true); await session.save();
  assert.equal(session.pruneEmptyBoxes(), 0);
  const temporary = session.add(1, [30, 70, 200, 95], 14, true); assert.equal(session.pruneEmptyBoxes(), 1);
  assert(!session.snapshot.fields.some(field => field.name === temporary.name));
  session.setValue(legacyBlank, 'Written'); await session.save(); session.setValue(legacyBlank, '');
  assert.equal(session.pruneEmptyBoxes(), 0); await session.save();
  const reopened = await TextSession.open(file.store, font); assert.equal(reopened.pruneEmptyBoxes(), 0);
  assert(reopened.snapshot.fields.some(field => field.name === saved.name));
  reopened.delete(saved.name, true); await reopened.save(); reopened.undoStroke(); await reopened.save();
  assert((await readTextPdf(file.bytes())).fields.some(field => field.name === saved.name));
  reopened.redoStroke(); await reopened.save(); assert(!(await readTextPdf(file.bytes())).fields.some(field => field.name === saved.name));
});

test('per-widget defaults, auto-size, inherited appearance and original standard fonts survive value changes', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), form = pdf.getForm();
  const times = await pdf.embedFont(StandardFonts.TimesRoman), field = form.createTextField('Shared');
  field.addToPage(page, { x: 20, y: 400, width: 200, height: 30, font: times });
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 30, font: times }); field.setFontSize(0);
  field.updateAppearances(times); field.setFontSize(0);
  const da = field.acroField.getDefaultAppearance()!; form.acroForm.dict.set(PDFName.of('DA'), PDFString.of(da)); field.acroField.dict.delete(PDFName.of('DA'));
  field.acroField.getWidgets()[0]!.setDefaultAppearance('/' + times.name + ' 0 Tf 0.4 g');
  field.acroField.getWidgets()[1]!.setDefaultAppearance('/' + times.name + ' 10 Tf 0 1 0 0 k');
  const file = memory(await pdf.save({ updateFieldAppearances: false })), session = await TextSession.open(file.store, font);
  assert.deepEqual(session.snapshot.fields[0]!.widgets.map(widget => widget.color), [[0.4, 0.4, 0.4], [1, 0, 1]]);
  session.setValue('Shared', 'Style preserved'); await session.save();
  const saved = (await PDFDocument.load(file.bytes())).getForm().getTextField('Shared');
  assert.match(saved.acroField.getDefaultAppearance()!, / 0 Tf/);
  assert.match(saved.acroField.getWidgets()[0]!.getDefaultAppearance()!, / 0 Tf/);
  assert.match(saved.acroField.getWidgets()[1]!.getDefaultAppearance()!, / 10 Tf/);
  for (const widget of saved.acroField.getWidgets()) {
    const appearance = widget.getAppearances()!.normal as PDFStream;
    const fonts = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    assert(fonts.values().some(ref => fonts.context.lookup(ref, PDFDict).get(PDFName.of('BaseFont'))?.toString() === '/Times-Roman'));
  }
});

test('the writer refuses destructive prefix collisions and locked owned fields before touching the store', async () => {
  const seed = await authoredForms(), changes: TextChanges = { values: new Map(), added: new Map(), boxes: new Map(), deleted: new Set([prefixBlank]), strokes: new Map(), deletedStrokes: new Set(), formats: new Map() };
  await assert.rejects(writeTextPdf(seed, changes, font), /Only editable/);
  const pdf = await PDFDocument.load(seed), field = pdf.getForm().getTextField(legacyBlank); field.enableReadOnly();
  field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), PDFNumber.of(128)); changes.deleted = new Set([legacyBlank]);
  await assert.rejects(writeTextPdf(await pdf.save(), changes, font), /Only editable/);
});

test('formatting an auto-sized authored field preserves zero Tf until an explicit size is selected, including undo/redo', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), field = pdf.getForm().createTextField('Auto');
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 30 }); field.setFontSize(0);
  const file = memory(await pdf.save({ updateFieldAppearances: false })), session = await TextSession.open(file.store, font);
  const size = async () => Number(/([\d.]+)\s+Tf/.exec((await PDFDocument.load(file.bytes())).getForm().getTextField('Auto').acroField.getDefaultAppearance()!)?.[1]);
  assert.equal(session.snapshot.fields[0]!.autoSize, true);
  session.setValue('Auto', 'Automatic sizing'); session.formatField('Auto', { color: [1, 0, 0] }); await session.save(); assert.equal(await size(), 0);
  session.formatField('Auto', { fontFamily: 'mono' }); await session.save(); assert.equal(await size(), 0);
  const reopened = await TextSession.open(file.store, font); assert.equal(reopened.snapshot.fields[0]!.autoSize, true);
  reopened.formatField('Auto', { fontSize: 14 }); await reopened.save(); assert.equal(await size(), 14);
  reopened.undoStroke(); await reopened.save(); assert.equal(await size(), 0);
  reopened.redoStroke(); await reopened.save(); assert.equal(await size(), 14);
});

test('color and family changes retain individual widget sizes, and an explicit size remains explicit across later formatting', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), field = pdf.getForm().createTextField('Shared');
  for (const y of [300, 400]) field.addToPage(page, { x: 20, y, width: 200, height: 30 });
  field.setFontSize(16);
  field.acroField.getWidgets()[0]!.setDefaultAppearance('/Helvetica 8 Tf 0 g');
  field.acroField.getWidgets()[1]!.setDefaultAppearance('/Helvetica 0 Tf 0 g');
  const file = memory(await pdf.save({ updateFieldAppearances: false })), session = await TextSession.open(file.store, font);
  const sizes = async () => (await PDFDocument.load(file.bytes())).getForm().getTextField('Shared').acroField.getWidgets().map(widget => Number(/([\d.]+)\s+Tf/.exec(widget.getDefaultAppearance()!)?.[1]));
  session.setValue('Shared', 'Widget styles'); session.formatField('Shared', { color: [1, 0, 0] }); await session.save(); assert.deepEqual(await sizes(), [8, 0]);
  session.formatField('Shared', { fontFamily: 'mono' }); await session.save(); assert.deepEqual(await sizes(), [8, 0]);
  session.formatField('Shared', { fontSize: 18 }); await session.save(); assert.deepEqual(await sizes(), [18, 18]);
  session.formatField('Shared', { color: [0, 0, 1] }); await session.save(); assert.deepEqual(await sizes(), [18, 18]);
});
