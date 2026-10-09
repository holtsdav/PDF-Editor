import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFString, PDFStream, PDFRef } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { orphanForms } from './fixtures/orphan-forms.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;
function memory(seed: Uint8Array) {
  let bytes = seed.slice(), writes = 0; const backups: Uint8Array[] = [];
  return { store: { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); writes++; },
    backup: async (value: Uint8Array) => { backups.push(value.slice()); return 'original.pdf'; } }, bytes: () => bytes, writes: () => writes, backups };
}
function annotations(pdf: PDFDocument) {
  return pdf.getPages().flatMap(page => page.node.Annots()!.asArray().map(ref => ({ ref: ref.toString(), dict: pdf.context.lookup(ref, PDFDict) })));
}

test('absent, empty and partial form trees recover each orphan once without writing on open', async () => {
  for (const tree of ['absent', 'missing', 'empty', 'partial'] as const) {
    const seed = await orphanForms(tree), file = memory(seed), session = await TextSession.open(file.store, font);
    assert.equal(session.snapshot.fields.length, tree === 'partial' ? 10 : 9);
    assert.equal(session.snapshot.fields.filter(field => field.name === 'Inherited').length, 1);
    const inherited = session.snapshot.fields.find(field => field.name === 'Inherited')!;
    assert.equal(inherited.widgets.length, 2); assert.equal(inherited.multiline, true); assert.equal(inherited.fontSize, 15);
    assert.equal(inherited.maxLength, 80); assert.equal(inherited.alignment, 'center'); assert.equal(inherited.value, 'Inherited answer');
    const blank = session.snapshot.fields.find(field => field.name === 'Orphan blank')!;
    assert.equal(blank.readOnly, false); assert.deepEqual(blank.widgets[0]!.appearance, { borderWidth: 1, borderStyle: 'solid', borderColor: [0, 0, 0], backgroundColor: [1, 1, 1] });
    assert.equal(session.snapshot.fields.find(field => field.name === 'pdf-form-studio-orphan-collision')!.owned, false);
    assert.equal(session.pruneEmptyBoxes(), 0); await session.renderBytes(); await session.saveWhenIdle();
    assert.equal(file.writes(), 0); assert.equal(session.dirty, false); assert.deepEqual(file.bytes(), seed); assert.deepEqual(file.backups, []);
  }
});

test('orphan values edit, clear, undo, redo, autosave and reopen with the original widget identities and options', async () => {
  const seed = await orphanForms('partial', 90), file = memory(seed), session = await TextSession.open(file.store, font);
  const before = await PDFDocument.load(seed), originalAnnotations = annotations(before);
  const stable = originalAnnotations.map(({ ref, dict }) => ({ ref, rect: dict.get(PDFName.of('Rect'))?.toString(),
    parent: dict.get(PDFName.of('Parent'))?.toString(), flags: dict.get(PDFName.of('F'))?.toString(),
    mk: dict.get(PDFName.of('MK'))?.toString(), bs: dict.get(PDFName.of('BS'))?.toString() }));
  session.setValue('Orphan blank', 'Filled answer'); await session.saveWhenIdle();
  session.undoStroke(); await session.saveWhenIdle(); assert.equal((await readTextPdf(file.bytes())).fields.find(field => field.name === 'Orphan blank')!.value, '');
  session.redoStroke(); session.setValue('Orphan multiline', 'First row\nSecond row'); session.setValue('Inherited', 'Shared rows\nSecond row');
  session.setValue('Orphan prefilled', ''); session.setValue('pdf-form-studio-orphan-collision', 'Foreign prefix answer'); await session.saveWhenIdle();
  const output = await PDFDocument.load(file.bytes()), after = annotations(output);
  assert.deepEqual(after.map(({ ref, dict }) => ({ ref, rect: dict.get(PDFName.of('Rect'))?.toString(), parent: dict.get(PDFName.of('Parent'))?.toString(),
    flags: dict.get(PDFName.of('F'))?.toString(), mk: dict.get(PDFName.of('MK'))?.toString(), bs: dict.get(PDFName.of('BS'))?.toString() })), stable);
  assert.equal(output.getPages()[0]!.getRotation().angle, 90); assert.equal(output.getForm().getFields().length, 10);
  for (const [name, value] of [['Orphan blank', 'Filled answer'], ['Orphan prefilled', ''], ['Orphan multiline', 'First row\nSecond row'], ['Inherited', 'Shared rows\nSecond row']]) {
    const field = output.getForm().getTextField(name!); assert.equal(field.getText() ?? '', value);
    for (const widget of field.acroField.getWidgets()) assert(widget.getAppearances()?.normal instanceof PDFStream);
  }
  assert.equal(output.getForm().getTextField('Orphan prefilled').getAlignment(), 2); assert.equal(output.getForm().getTextField('Orphan prefilled').getMaxLength(), 40);
  for (const entry of originalAnnotations) if (!['Orphan blank', 'Orphan prefilled', 'Orphan multiline', 'pdf-form-studio-orphan-collision'].some(name => entry.dict.get(PDFName.of('T'))?.toString() === PDFString.of(name).toString()) && entry.dict.get(PDFName.of('Parent'))?.toString() !== output.getForm().getTextField('Inherited').ref.toString()) {
    assert.equal(after.find(item => item.ref === entry.ref)!.dict.toString(), entry.dict.toString(), 'untouched canonical, unsupported and foreign annotations');
  }
  const reopened = await TextSession.open(file.store, font); assert.equal(reopened.snapshot.fields.length, 10); assert.equal(reopened.pruneEmptyBoxes(), 0);
  assert.throws(() => reopened.delete('pdf-form-studio-orphan-collision', true), /Only editable/);
  for (const name of ['Readonly', 'Password', 'Hidden', 'Locked']) assert.throws(() => reopened.setValue(name, 'Changed'), /not editable/);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const widgets = await (await (await task.promise).getPage(1)).getAnnotations();
    assert.equal(widgets.filter(widget => widget.fieldName === 'Inherited').length, 2);
    assert(widgets.filter(widget => widget.fieldName === 'Inherited').every(widget => widget.fieldValue === 'Shared rows\nSecond row' && widget.hasAppearance));
    assert.equal(widgets.find(widget => widget.fieldName === 'Orphan blank')!.fieldValue, 'Filled answer');
  } finally { await task.destroy(); }
  assert.deepEqual(file.backups[0], seed);
});

test('an unrelated save preserves every orphan widget and foreign annotation dictionary exactly', async () => {
  const seed = await orphanForms(), file = memory(seed), session = await TextSession.open(file.store, font);
  const before = annotations(await PDFDocument.load(seed)).map(({ ref, dict }) => ({ ref, value: dict.toString() }));
  const added = session.add(1, [30, 10, 250, 40], 14, false); session.setValue(added.name, 'Unrelated added text'); await session.save();
  const saved = await PDFDocument.load(file.bytes()), after = annotations(saved);
  assert.deepEqual(after.slice(0, before.length).map(({ ref, dict }) => ({ ref, value: dict.toString() })), before);
  assert.equal(after.length, before.length + 1); assert.equal((await readTextPdf(file.bytes())).fields.length, 10);
  assert.deepEqual(file.backups[0], seed);
});

test('display copies remove recovered editable widgets only and retain unsupported original appearances', async () => {
  const seed = await orphanForms(), display = await PDFDocument.load(await renderTextPdf(seed));
  const kept = new Set(annotations(display).map(({ dict }) => dict));
  for (const field of display.getForm().getFields()) {
    const expected = ['Readonly', 'Password', 'Hidden', 'Locked'].includes(field.getName());
    for (const widget of field.acroField.getWidgets()) assert.equal(kept.has(widget.dict), expected, field.getName());
  }
  assert.equal(annotations(display).filter(({ dict }) => dict.get(PDFName.of('FT')) === PDFName.of('Btn')).length, 1);
  assert.equal(annotations(display).filter(({ dict }) => ['/Link', '/FreeText'].includes(dict.get(PDFName.of('Subtype'))?.toString() ?? '')).length, 2);
});

test('ambiguous canonical/orphan and orphan/orphan names reject before a store write', async () => {
  for (const canonical of [true, false]) {
    const pdf = await PDFDocument.load(await orphanForms(canonical ? 'partial' : 'absent'));
    const merged = annotations(pdf).find(({ dict }) => dict.get(PDFName.of('T'))?.toString() === '(Orphan blank)')!.dict;
    merged.set(PDFName.of('T'), PDFString.of(canonical ? 'Canonical' : 'Orphan prefilled'));
    const file = memory(await pdf.save({ updateFieldAppearances: false }));
    await assert.rejects(TextSession.open(file.store, font), /duplicate|ambiguous/i); assert.equal(file.writes(), 0);
  }
});

test('orphan parent, child and shared-child graphs reject malformed or excessive traversal safely', async () => {
  for (const kind of ['parent-cycle', 'child-cycle', 'bad-parent', 'dangling-parent', 'bad-kids', 'missing-child', 'shared-canonical', 'direct-child', 'mismatched-parent', 'incompatible-type', 'deep']) {
    const pdf = await PDFDocument.load(await orphanForms('partial'));
    const merged = annotations(pdf).find(({ dict }) => dict.get(PDFName.of('T'))?.toString() === '(Orphan blank)')!.dict;
    const ref = pdf.context.getObjectRef(merged)!;
    if (kind === 'parent-cycle') merged.set(PDFName.of('Parent'), ref);
    if (kind === 'child-cycle') merged.set(PDFName.of('Kids'), pdf.context.obj([ref]));
    if (kind === 'bad-parent') merged.set(PDFName.of('Parent'), PDFString.of('bad'));
    if (kind === 'dangling-parent') merged.set(PDFName.of('Parent'), PDFRef.of(9999));
    if (kind === 'bad-kids') merged.set(PDFName.of('Kids'), PDFString.of('bad'));
    if (kind === 'missing-child') merged.set(PDFName.of('Parent'), pdf.context.register(pdf.context.obj({ T: PDFString.of('Root'), FT: 'Tx', Kids: [] })));
    if (kind === 'shared-canonical') merged.set(PDFName.of('Parent'), pdf.getForm().getTextField('Canonical').ref);
    if (kind === 'direct-child') merged.set(PDFName.of('Kids'), pdf.context.obj([pdf.context.obj({ Subtype: 'Widget', Parent: ref })]));
    if (kind === 'mismatched-parent') merged.set(PDFName.of('Kids'), pdf.context.obj([pdf.context.register(pdf.context.obj({ Subtype: 'Widget' }))]));
    if (kind === 'incompatible-type') {
      const parent = pdf.context.register(pdf.context.obj({ T: PDFString.of('Button'), FT: 'Btn', Kids: [ref] }));
      merged.set(PDFName.of('Parent'), parent); merged.delete(PDFName.of('T'));
    }
    if (kind === 'deep') {
      let child = ref;
      for (let i = 0; i < 130; i++) { const parent = pdf.context.register(pdf.context.obj({ T: PDFString.of('Level'), Kids: [child] })); pdf.context.lookup(child, PDFDict).set(PDFName.of('Parent'), parent); child = parent; }
    }
    await assert.rejects(readTextPdf(await pdf.save({ updateFieldAppearances: false })), /Malformed PDF/, kind);
  }
});

test('nested recovered fields inherit names, types and flags while reachable canonical roots are never duplicated', async () => {
  const pdf = await PDFDocument.load(await orphanForms('partial'));
  const widget = annotations(pdf).find(({ dict }) => dict.get(PDFName.of('T'))?.toString() === '(Orphan blank)')!.dict;
  const widgetRef = pdf.context.getObjectRef(widget)!; widget.delete(PDFName.of('T')); widget.delete(PDFName.of('FT')); widget.delete(PDFName.of('Ff'));
  const field = pdf.context.obj({ T: PDFString.of('Answer'), Kids: [widgetRef] }), fieldRef = pdf.context.register(field);
  const root = pdf.context.obj({ T: PDFString.of('Section'), FT: 'Tx', Ff: 4096, Kids: [fieldRef] }), rootRef = pdf.context.register(root);
  field.set(PDFName.of('Parent'), rootRef); widget.set(PDFName.of('Parent'), fieldRef);
  const file = memory(await pdf.save({ updateFieldAppearances: false })), session = await TextSession.open(file.store, font);
  const recovered = session.snapshot.fields.find(item => item.name === 'Section.Answer')!;
  assert.equal(recovered.multiline, true); session.setValue(recovered.name, 'Nested answer'); await session.save();
  const saved = await PDFDocument.load(file.bytes()); assert.equal(saved.getForm().getTextField('Section.Answer').getText(), 'Nested answer');
  assert.equal(saved.getForm().getTextField('Section.Answer').ref.toString(), fieldRef.toString());
  assert.equal(saved.getForm().acroForm.getFields().length, 10);
  assert.equal((await readTextPdf(file.bytes())).fields.length, 10);
});

test('unnamed text widgets and malformed form root arrays fail closed', async () => {
  for (const kind of ['unnamed', 'bad-fields', 'dangling-fields']) {
    const pdf = await PDFDocument.load(await orphanForms('partial'));
    if (kind === 'unnamed') annotations(pdf).find(({ dict }) => dict.get(PDFName.of('T'))?.toString() === '(Orphan blank)')!.dict.delete(PDFName.of('T'));
    else pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('Fields'), kind === 'bad-fields' ? PDFString.of('bad') : PDFRef.of(9999));
    await assert.rejects(readTextPdf(await pdf.save({ updateFieldAppearances: false })), /unnamed|Malformed PDF/);
  }
});
