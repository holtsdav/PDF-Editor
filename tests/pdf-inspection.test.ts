import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { asPdfLibrary, inspectDocument } from '../src/pdf/inspect.ts';

const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;

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
    const discovered = report.fields.find(field => field.name === 'Answer');
    assert.deepEqual(discovered?.pages, [1, 2]);
    assert.equal(discovered?.type, 'Tx');
    assert.equal(discovered?.inFieldTree, true);
    assert.equal(report.fields.find(field => field.name === 'Approved')?.readOnly, true);
  } finally { await task.destroy(); }
});

test('a printed answer line is not an interactive form field', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Write your answer:', { x: 30, y: 550, font });
  page.drawLine({ start: { x: 30, y: 500 }, end: { x: 400, y: 500 } });
  const task = getDocument({ data: await pdf.save(), isEvalSupported: false, standardFontDataUrl });
  try {
    const report = await inspectDocument(await task.promise);
    assert.equal(report.hasAcroForm, false);
    assert.equal(report.fields.length, 0);
    assert.equal(report.scannedPages, 1);
  } finally { await task.destroy(); }
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
    assert(report.warnings.some(warning => warning.includes('first 1 pages')));
  } finally { await task.destroy(); }
});

test('rejects an unavailable PDF.js API', () => {
  assert.throws(() => asPdfLibrary({}), /compatible PDF.js loader/);
});
