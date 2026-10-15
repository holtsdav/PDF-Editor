import { renamedPdfPath } from '../src/pdf/file-name.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFNumber, PDFString, PDFArray, PDFStream } from 'pdf-lib';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectDocument } from '../src/pdf/inspect.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);
test('display copies retain the original appearances of password, readonly, hidden and locked widgets', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  for (const name of ['Password', 'Readonly', 'Hidden', 'NoView', 'Locked', 'Editable']) {
    const field = pdf.getForm().createTextField(name);
    field.setText(name === 'Password' ? 'Private value' : name);
    field.addToPage(page);
    if (name === 'Password') {
      field.enablePassword();
    }
    if (name === 'Readonly') {
      field.enableReadOnly();
    }
    if (name === 'Hidden') {
      field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), PDFNumber.of(2));
    }
    if (name === 'NoView') {
      field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), PDFNumber.of(32));
    }
    if (name === 'Locked') {
      field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), PDFNumber.of(128));
    }
  }
  const bytes = await pdf.save();
  const snapshot = await readTextPdf(bytes);
  const output = await PDFDocument.load(await renderTextPdf(bytes));
  const annotations = output
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => output.context.lookup(ref));
  for (const name of ['Password', 'Readonly', 'Hidden', 'NoView', 'Locked']) {
    assert(
      snapshot.fields.find((field) => field.name === name)!.readOnly,
      `${name} must not become a plain editable overlay`,
    );
    assert(
      annotations.includes(output.getForm().getTextField(name).acroField.getWidgets()[0]!.dict),
      `${name} must keep its original appearance`,
    );
  }
  assert(
    !annotations.includes(
      output.getForm().getTextField('Editable').acroField.getWidgets()[0]!.dict,
    ),
  );
});

test('duplicate canonical field names reject editing rather than redirect a save to the wrong field', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const first = pdf.getForm().createTextField('First');
  const second = pdf.getForm().createTextField('Second');
  first.addToPage(page);
  second.addToPage(page);
  second.acroField.dict.set(PDFName.of('T'), PDFString.of('First'));
  await assert.rejects(readTextPdf(await pdf.save()), /duplicate|ambiguous/i);
});

test('inline signature dictionaries are rejected just like indirect signature objects', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.catalog.set(
    PDFName.of('Perms'),
    pdf.context.obj({ DocMDP: { Type: 'Sig', ByteRange: [0, 10, 20, 30] } }),
  );
  await assert.rejects(readTextPdf(await pdf.save()), /signature/);
});

test('a foreign annotation sharing an owned ink name is neither changed nor deleted', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  let bytes = await pdf.save();
  const store = {
    read: async () => bytes.slice(),
    write: async (value: Uint8Array) => {
      bytes = value;
    },
    backup: async () => 'original.pdf',
  };
  const first = await TextSession.open(store, font);
  const stroke = first.addStroke(1, 'scribble', [
    [20, 20],
    [50, 50],
  ]);
  await first.save();
  const foreign = await PDFDocument.load(bytes);
  foreign.getPages()[0]!.node.addAnnot(
    foreign.context.register(
      foreign.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        NM: PDFString.of(stroke.id),
        Rect: [1, 1, 5, 5],
        A: { S: 'URI', URI: PDFString.of('https://example.com') },
      }),
    ),
  );
  bytes = await foreign.save();
  const reopened = await TextSession.open(store, font);
  reopened.deleteStroke(stroke.id);
  await reopened.save();
  const output = await PDFDocument.load(bytes);
  const annotations = output
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => output.context.lookup(ref, PDFDict));
  assert.equal(
    annotations.filter((dict) => dict.get(PDFName.of('Subtype'))?.toString() === '/Link').length,
    1,
  );
});

test('cyclic page, form-child, form-parent and array trees fail before recursive library traversal', async () => {
  for (const kind of ['page', 'form-child', 'form-parent', 'array']) {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const field = pdf.getForm().createTextField('Answer');
    field.addToPage(pdf.getPages()[0]!);
    if (kind === 'page') {
      const pages = pdf.catalog.lookup(PDFName.of('Pages'), PDFDict);
      pages.set(PDFName.of('Kids'), pdf.context.obj([pdf.catalog.get(PDFName.of('Pages'))!]));
    } else if (kind === 'form-child') {
      field.acroField.dict.set(PDFName.of('Kids'), pdf.context.obj([field.ref]));
    } else if (kind === 'form-parent') {
      field.acroField.dict.set(PDFName.of('Parent'), field.ref);
    } else {
      const array = pdf.context.obj([]);
      const ref = pdf.context.register(array);
      array.push(ref);
      pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('Fields'), array);
    }
    const bytes = await pdf.save({ addDefaultPage: false, updateFieldAppearances: false });
    await assert.rejects(readTextPdf(bytes), /Malformed PDF/, kind);
  }
});

test('hidden owned ink stays hidden and read only without losing its saved annotation', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  let bytes = await pdf.save();
  const session = await TextSession.open(
    {
      read: async () => bytes,
      write: async (value) => {
        bytes = value;
      },
      backup: async () => 'original.pdf',
    },
    font,
  );
  const stroke = session.addStroke(1, 'marker', [
    [20, 20],
    [100, 20],
  ]);
  await session.save();
  const hidden = await PDFDocument.load(bytes);
  const annotation = hidden.getPages()[0]!.node.Annots()!.lookup(0, PDFDict);
  annotation.set(PDFName.of('F'), PDFNumber.of(2));
  bytes = await hidden.save();
  const snapshot = await readTextPdf(bytes);
  assert.equal(snapshot.strokes[0]!.hidden, true);
  assert(snapshot.strokes[0]!.readOnly);
  assert.equal((await readTextPdf(await renderTextPdf(bytes))).strokes[0]!.id, stroke.id);
});

test('non-PDF and truncated headers reject safely without creating a writeable session', async () => {
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode('not a PDF'),
    new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<'),
  ]) {
    let writes = 0;
    await assert.rejects(
      TextSession.open(
        {
          read: async () => bytes,
          write: async () => {
            writes++;
          },
          backup: async () => 'original.pdf',
        },
        font,
      ),
    );
    assert.equal(writes, 0);
  }
});

test('duplicate page entries fail closed', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  pdf.catalog
    .lookup(PDFName.of('Pages'), PDFDict)
    .lookup(PDFName.of('Kids'), PDFArray)
    .push(page.ref);
  await assert.rejects(
    readTextPdf(await pdf.save({ addDefaultPage: false, updateFieldAppearances: false })),
    /Malformed PDF/,
  );
});

test('reclaiming replaced appearances preserves resources shared by untouched widgets', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const first = pdf.getForm().createTextField('First');
  const second = pdf.getForm().createTextField('Second');
  first.setText('Original');
  first.addToPage(page);
  second.setText('Untouched');
  second.addToPage(page);
  second.enableReadOnly();
  second.acroField
    .getWidgets()[0]!
    .dict.set(PDFName.of('AP'), first.acroField.getWidgets()[0]!.dict.get(PDFName.of('AP'))!);
  let bytes = await pdf.save({ updateFieldAppearances: false });
  const before = await PDFDocument.load(bytes);
  const appearance = (doc: PDFDocument) =>
    doc.getForm().getTextField('Second').acroField.getWidgets()[0]!.getAppearances()!
      .normal as PDFStream;
  const original = appearance(before).getContents().slice();
  for (let i = 0; i < 10; i++) {
    const session = await TextSession.open(
      {
        read: async () => bytes,
        write: async (value) => {
          bytes = value;
        },
        backup: async () => 'original.pdf',
      },
      font,
    );
    session.setValue('First', `Changed ${i}`);
    await session.save();
  }
  const saved = await PDFDocument.load(bytes);
  assert.equal(saved.getForm().getTextField('Second').getText(), 'Untouched');
  assert.deepEqual(appearance(saved).getContents(), original);
  assert(
    appearance(saved)
      .dict.lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('Font'), PDFDict)
      .values()
      .every((ref) => saved.context.lookup(ref) instanceof PDFDict),
  );
});

const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
  .pathname;

// Actual in-memory PDF files are parsed by upstream PDF.js. No vault or user PDF is touched.
test('discovers shared form fields on multiple pages and read-only fields', async () => {
  const pdf = await PDFDocument.create();
  const page1 = pdf.addPage();
  const page2 = pdf.addPage();
  const form = pdf.getForm();
  const answer = form.createTextField('Answer');
  answer.setText('A value');
  answer.addToPage(page1, { x: 30, y: 500, width: 200, height: 24 });
  answer.addToPage(page2, { x: 30, y: 500, width: 200, height: 24 });
  const checkbox = form.createCheckBox('Approved');
  checkbox.addToPage(page1, { x: 30, y: 450, width: 20, height: 20 });
  checkbox.enableReadOnly();
  const task = getDocument({ data: await pdf.save(), isEvalSupported: false, standardFontDataUrl });
  try {
    const report = await inspectDocument(await task.promise);
    assert.equal(report.hasAcroForm, true);
    assert.equal(report.fields.length, 2);
    const discovered = report.fields.find((field) => field.name === 'Answer');
    assert.deepEqual(discovered?.pages, [1, 2]);
    assert.equal(discovered?.type, 'Tx');
    assert.equal(discovered?.inFieldTree, true);
    assert.equal(report.fields.find((field) => field.name === 'Approved')?.readOnly, true);
  } finally {
    await task.destroy();
  }
});

test('a limited scan keeps canonical fields but marks the page coverage as incomplete', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const page2 = pdf.addPage();
  const answer = pdf.getForm().createTextField('Page two answer');
  answer.addToPage(page2, { x: 30, y: 500, width: 200, height: 24 });
  const task = getDocument({ data: await pdf.save(), isEvalSupported: false, standardFontDataUrl });
  try {
    const report = await inspectDocument(await task.promise, 1);
    assert.equal(report.scannedPages, 1);
    assert.equal(report.pages, 2);
    assert.equal(report.fields.length, 1);
    assert.deepEqual(report.fields[0]?.pages, []);
    assert(report.warnings.some((warning) => warning.includes('first 1 pages')));
  } finally {
    await task.destroy();
  }
});

test('header rename stays in the folder and validates names, extension and path traversal', () => {
  assert.equal(renamedPdfPath('School/Old.pdf', ' Algebra '), 'School/Algebra.pdf');
  assert.equal(renamedPdfPath('School/Old.pdf', 'Algebra.PDF'), 'School/Algebra.pdf');
  for (const name of ['', '.pdf', '..', '../Other', 'a/b', 'a\\b', 'name:', 'trailing.']) {
    assert.throws(() => renamedPdfPath('School/Old.pdf', name));
  }
});
