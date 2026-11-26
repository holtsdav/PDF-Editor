import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, renderTextPdf, writeTextPdf } from '../src/pdf/text-engine.ts';
import type { TextChanges } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

async function choiceForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 340, width: 14, height: 14 });
  const both = form.createCheckBox('newsletter');
  both.addToPage(page, { x: 20, y: 310, width: 14, height: 14 });
  both.check();
  const radio = form.createRadioGroup('size');
  radio.addOptionToPage('small', page, { x: 20, y: 270, width: 12, height: 12 });
  radio.addOptionToPage('large', page, { x: 60, y: 270, width: 12, height: 12 });
  const dropdown = form.createDropdown('country');
  dropdown.addOptions(['Germany', 'Österreich', 'Schweiz']);
  dropdown.addToPage(page, { x: 20, y: 220, width: 150, height: 20, font: helvetica });
  const list = form.createOptionList('fruit');
  list.addOptions(['Apple', 'Pear']);
  list.addToPage(page, { x: 20, y: 150, width: 150, height: 40, font: helvetica });
  const locked = form.createCheckBox('locked');
  locked.addToPage(page, { x: 20, y: 100, width: 14, height: 14 });
  locked.enableReadOnly();
  form.createTextField('name').addToPage(page, { x: 200, y: 340, width: 150, height: 20 });
  return pdf.save();
}

function changes(choices: Record<string, string>): TextChanges {
  return {
    values: new Map(),
    added: new Map(),
    boxes: new Map(),
    deleted: new Set(),
    strokes: new Map(),
    deletedStrokes: new Set(),
    formats: new Map(),
    choices: new Map(Object.entries(choices)),
  };
}

test('reads checkboxes, radio groups, dropdowns and list boxes', async () => {
  const snapshot = await readTextPdf(await choiceForm());
  const byName = new Map(snapshot.choices!.map((field) => [field.name, field]));
  assert.deepEqual([...byName.keys()].sort(), [
    'agree',
    'country',
    'fruit',
    'locked',
    'newsletter',
    'size',
  ]);
  assert.equal(byName.get('agree')!.kind, 'checkbox');
  assert.equal(byName.get('agree')!.value, '');
  assert.equal(byName.get('newsletter')!.value, 'Yes');
  assert.equal(byName.get('agree')!.widgets[0]!.onValue, 'Yes');
  assert.equal(byName.get('size')!.kind, 'radio');
  assert.deepEqual(
    byName.get('size')!.widgets.map((widget) => widget.label),
    ['small', 'large'],
  );
  assert.equal(byName.get('country')!.kind, 'dropdown');
  assert.deepEqual(
    byName.get('country')!.options.map((option) => option.label),
    ['Germany', 'Österreich', 'Schweiz'],
  );
  assert.equal(byName.get('fruit')!.kind, 'list');
  assert.equal(byName.get('locked')!.readOnly, true);
  assert.equal(byName.get('agree')!.readOnly, false);
  // Text fields are still read separately.
  assert.deepEqual(
    snapshot.fields.map((field) => field.name),
    ['name'],
  );
});

test('writes choice values that pdf-lib and PDF.js both read back', async () => {
  const seed = await choiceForm();
  const snapshot = await readTextPdf(seed);
  const radioOn = snapshot.choices!.find((field) => field.name === 'size')!.widgets[1]!.onValue!;
  const output = await writeTextPdf(
    seed,
    changes({ agree: 'Yes', newsletter: '', size: radioOn, country: 'Österreich', fruit: 'Pear' }),
    font,
  );
  const reread = await readTextPdf(output);
  const values = Object.fromEntries(reread.choices!.map((field) => [field.name, field.value]));
  assert.equal(values.agree, 'Yes');
  assert.equal(values.newsletter, '');
  assert.equal(values.size, radioOn);
  assert.equal(values.country, 'Österreich');
  assert.equal(values.fruit, 'Pear');

  const form = (await PDFDocument.load(output)).getForm();
  assert.equal(form.getCheckBox('agree').isChecked(), true);
  assert.equal(form.getCheckBox('newsletter').isChecked(), false);
  assert.deepEqual(form.getDropdown('country').getSelected(), ['Österreich']);
  const widgets = form.getRadioGroup('size').acroField.getWidgets();
  assert.deepEqual(
    widgets.map((widget) => widget.getAppearanceState()?.decodeText()),
    ['Off', radioOn],
  );

  // Independent reader: PDF.js sees the same field values.
  const document = await getDocument({ data: output.slice() }).promise;
  const objects = (await document.getFieldObjects())!;
  // pdf-lib stores fields as a parent plus widget kids; PDF.js reports values on the widgets.
  const value = (name: string) =>
    (objects[name] as { type?: string; value?: unknown }[])
      .filter((entry) => entry.type)
      .map((entry) => entry.value);
  assert.deepEqual(value('agree'), ['Yes']);
  assert.deepEqual(value('newsletter'), ['Off']);
  assert.deepEqual(value('country'), ['Österreich']);
  assert.deepEqual(value('fruit'), ['Pear']);
  assert.ok(value('size').includes(radioOn));
  await document.destroy();
});

test('rejects invalid values and read-only choice fields', async () => {
  const seed = await choiceForm();
  await assert.rejects(writeTextPdf(seed, changes({ country: 'Mars' }), font), /not an option/);
  await assert.rejects(writeTextPdf(seed, changes({ agree: 'Maybe' }), font), /not an option/);
  await assert.rejects(writeTextPdf(seed, changes({ locked: 'Yes' }), font), /read only/);
});

test('session edits choices with undo, redo, autosave and a backup of the original', async () => {
  const seed = await choiceForm();
  let bytes = seed.slice();
  const backups: Uint8Array[] = [];
  const session = await TextSession.open(
    {
      read: async () => bytes.slice(),
      write: async (value) => {
        bytes = value.slice();
      },
      backup: async (value) => {
        backups.push(value.slice());
        return 'backup.pdf';
      },
    },
    font,
  );
  session.setChoice('agree', 'Yes');
  session.setChoice('country', 'Schweiz');
  assert.equal(session.dirty, true);
  session.undoStroke();
  assert.equal(session.snapshot.choices!.find((field) => field.name === 'country')!.value, '');
  session.redoStroke();
  assert.equal(
    session.snapshot.choices!.find((field) => field.name === 'country')!.value,
    'Schweiz',
  );
  assert.throws(() => session.setChoice('locked', 'Yes'), /not editable/);
  assert.throws(() => session.setChoice('country', 'Mars'), /not an option/);
  await session.save();
  assert.equal(session.status, 'saved');
  assert.equal(backups.length, 1);
  const form = (await PDFDocument.load(bytes)).getForm();
  assert.equal(form.getCheckBox('agree').isChecked(), true);
  assert.deepEqual(form.getDropdown('country').getSelected(), ['Schweiz']);
});

test('display copy omits editable choice widgets but keeps read-only ones', async () => {
  const seed = await choiceForm();
  const rendered = await PDFDocument.load(await renderTextPdf(seed));
  const annotations = rendered.getPages()[0]!.node.Annots()!;
  // Widgets are kids of named parent fields.
  const names = annotations
    .asArray()
    .map((ref) => rendered.context.lookup(ref, PDFDict))
    .map((dict) =>
      dict.lookup(PDFName.of('Parent'), PDFDict).lookup(PDFName.of('T'), PDFHexString).decodeText(),
    );
  assert.deepEqual(names, ['locked']);
});
