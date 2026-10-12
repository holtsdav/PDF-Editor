import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFDict, PDFName, PDFNumber, TextAlignment } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PdfFonts } from '../src/pdf/text-format.ts';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextSession } from '../src/pdf/text-session.ts';
import type { PdfDraft } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { spacedWidth, textGraphemes } from '../src/pdf/text-format.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));

test('interrupting an ink transaction to begin a pinch retains redo and does not add a history entry', async () => {
  const f = await fixture(), first = f.session.addStroke(1, 'scribble', [[20, 40], [80, 90]]);
  f.session.undoStroke(); const owner = {};
  assert(f.session.beginInkAction(owner)); f.session.addStroke(1, 'scribble', [[30, 50], [90, 100]], 2, undefined, owner);
  f.session.finishInkAction(true, owner); assert.equal(f.session.snapshot.strokes.length, 0); assert.equal(f.session.canRedoStroke, true);
  f.session.redoStroke(); assert.equal(f.session.snapshot.strokes[0]!.id, first.id);
});
/** Open an anonymous PDF with an authored right-aligned field and an in-memory session store. */
async function fixture(fonts: PdfFonts = font) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  const authored = pdf.getForm().createTextField('Authored'); authored.setText('Untouched'); authored.setAlignment(TextAlignment.Right); authored.addToPage(page, { x: 30, y: 40, width: 200, height: 20 });
  let bytes = await pdf.save();
  const store = { read: async () => bytes.slice(), write: async (value: Uint8Array) => { bytes = value.slice(); }, backup: async () => 'original.pdf' };
  return { session: await TextSession.open(store, fonts), store, bytes: () => bytes };
}

test('alignment preserves authored Q, uses the shared formatting history, and PDF.js sees aligned multiline appearances', async () => {
  const f = await fixture(), field = f.session.add(1, [50, 500, 350, 650], 20, true);
  assert.equal(f.session.snapshot.fields.find(item => item.name === 'Authored')!.alignment, 'right');
  f.session.setValue(field.name, 'AB\nCD');
  for (const alignment of ['left', 'center', 'right'] as const) {
    f.session.formatField(field.name, { alignment, letterSpacing: 2, lineSpacing: 1.8 }); await f.session.save();
    const task = getDocument({ data: f.bytes().slice(), standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname });
    try {
      const page = await (await task.promise).getPage(1), annotation = (await page.getAnnotations()).find(item => item.fieldName === field.name)!;
      const ops = await page.getOperatorList(); let own = false;
      const matrices: number[][] = [];
      ops.fnArray.forEach((op, index) => {
        if (op === OPS.beginAnnotation) own = ops.argsArray[index]![0] === annotation.id;
        if (op === OPS.setTextMatrix && own) matrices.push(ops.argsArray[index]![0] as number[]);
        if (op === OPS.endAnnotation) own = false;
      });
      assert.equal(matrices.length, 4);
      const x = matrices[0]![4]!; assert(alignment === 'left' ? x === 1 : alignment === 'center' ? x > 120 && x < 145 : x > 250 && x < 280);
      assert(Math.abs(matrices[0]![5]! - matrices[2]![5]! - 36) < 0.01);
      assert.equal((await readTextPdf(f.bytes())).fields.find(item => item.name === 'Authored')!.alignment, 'right');
    } finally { await task.destroy(); }
  }
  const copy = f.session.copyObjects([{ kind: 'text', id: field.name }]); assert.equal(copy[0]!.kind === 'text' && copy[0]!.alignment, 'right');
  const reopened = await TextSession.open(f.store, font); assert.equal(reopened.snapshot.fields.find(item => item.name === field.name)!.alignment, 'right');
  reopened.formatField('Authored', { alignment: 'center' }); reopened.undoStroke(); assert.equal(reopened.snapshot.fields.find(item => item.name === 'Authored')!.alignment, 'right');
  reopened.redoStroke(); await reopened.save(); assert.equal((await readTextPdf(f.bytes())).fields.find(item => item.name === 'Authored')!.alignment, 'center');
});

test('one-character resize floor uses each actual font, size, tracking and a grapheme instead of the entire string', async () => {
  const fonts = { sans: font, serif: new Uint8Array(await readFile(new URL('../assets/fonts/NotoSerif-Regular.ttf', import.meta.url))), mono: new Uint8Array(await readFile(new URL('../assets/fonts/NotoSansMono-Regular.ttf', import.meta.url))) };
  const f = await fixture(fonts), field = f.session.add(1, [50, 500, 350, 650], 20, true);
  for (const fontFamily of ['sans', 'serif', 'mono'] as const) for (const size of [10, 20, 48]) for (const character of ['i', 'W', 'e\u0301']) {
    f.session.setValue(field.name, character + 'WWWWWW'); f.session.formatField(field.name, { fontFamily, fontSize: size, letterSpacing: 1 });
    const actual = fontkit.create(fonts[fontFamily]);
    const width = actual.layout(character, { liga: false, clig: false, kern: false }).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * size / actual.unitsPerEm + 3;
    const minimum = f.session.minimumTextBoxSize(field.name); assert(Math.abs(minimum[0] - width) < 1e-8); assert.equal(minimum[1], size * 1.2 + 2);
  }
  f.session.setValue(field.name, 'i'); const minimum = f.session.minimumTextBoxSize(field.name);
  f.session.updateBox(field.name, [50, 500, 50 + minimum[0], 500 + minimum[1]]); await f.session.save();
  const reopened = await TextSession.open(f.store, fonts); assert.equal(reopened.snapshot.fields.find(item => item.name === field.name)!.value, 'i');
  assert.deepEqual(reopened.minimumTextBoxSize(field.name), minimum);
});

test('resizing around a narrow first glyph retains wider glyphs and refuses an appearance that would clip them', async () => {
  const f = await fixture(), field = f.session.add(1, [50, 500, 350, 650], 20, true), original = f.bytes().slice();
  f.session.setValue(field.name, 'iW'); const width = f.session.minimumTextBoxSize(field.name)[0];
  f.session.updateBox(field.name, [50, 500, 50 + width, 650]);
  await assert.rejects(f.session.save(), /character does not fit/); assert.deepEqual(f.bytes(), original); assert.equal(field.value, 'iW'); assert.equal(field.fontSize, 20);
  f.session.updateBox(field.name, [50, 500, 80, 650]); await f.session.save(); assert.equal((await readTextPdf(f.bytes())).fields.find(item => item.name === field.name)!.value, 'iW');
});

test('spacing persists through shared history, copy, repeated saves and reopen without changing authored fields', async () => {
  const f = await fixture(), field = f.session.add(1, [50, 500, 350, 650], 18, true);
  f.session.setValue(field.name, 'café e\u0301\nSecond line');
  f.session.formatField(field.name, { letterSpacing: 2, lineSpacing: 1.8 });
  const [copy] = f.session.pasteObjects(f.session.copyObjects([{ kind: 'text', id: field.name }]));
  assert.equal(f.session.snapshot.fields.find(field => field.name === copy!.id)!.letterSpacing, 2);
  f.session.undoStroke(); assert.equal(f.session.snapshot.fields.length, 2);
  f.session.undoStroke(); assert.equal(f.session.snapshot.fields.find(item => item.name === field.name)!.letterSpacing, undefined);
  f.session.redoStroke(); assert.equal(f.session.snapshot.fields.find(item => item.name === field.name)!.lineSpacing, 1.8);
  await f.session.save(); await f.session.save();
  const reopened = await TextSession.open(f.store, font), saved = reopened.snapshot.fields.find(item => item.name === field.name)!;
  assert.equal(saved.letterSpacing, 2); assert.equal(saved.lineSpacing, 1.8); assert.equal(saved.value, 'café e\u0301\nSecond line');
  assert.equal(reopened.snapshot.fields.find(item => item.name === 'Authored')!.value, 'Untouched');
  const pdf = await PDFDocument.load(f.bytes()), dict = pdf.getForm().getTextField(field.name).acroField.dict;
  assert.equal(dict.lookup(PDFName.of('PFSLetterSpacing'), PDFNumber).asNumber(), 2);
  assert(dict.lookup(PDFName.of('Kids')));
  assert(pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict));
});

test('PDF.js observes actual tracked glyph positions and custom leading in saved appearance streams', async () => {
  const f = await fixture(), field = f.session.add(1, [50, 500, 350, 650], 20, true);
  f.session.setValue(field.name, 'AB\nCD'); f.session.formatField(field.name, { letterSpacing: 3, lineSpacing: 2 }); await f.session.save();
  const task = getDocument({ data: f.bytes().slice(), standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname });
  try {
    const page = await (await task.promise).getPage(1), ops = await page.getOperatorList();
    const matrices = ops.fnArray.flatMap((op, i) => op === OPS.setTextMatrix ? [ops.argsArray[i]![0] as number[]] : []);
    // Appearance-local positions for the four individual graphemes.
    const tracked = matrices.filter(matrix => matrix[4]! >= 1 && matrix[4]! < 40 && matrix[5]! > 50);
    assert.equal(tracked.length, 4);
    assert(Math.abs(tracked[0]![5]! - tracked[2]![5]! - 40) < 0.01);
    const gap = tracked[1]![4]! - tracked[0]![4]!;
    assert(gap > 15 && gap < 17, `Expected A advance plus 3pt tracking, observed ${gap}`);
  } finally { await task.destroy(); }
});

test('spacing validation rejects malformed input and ruled blocks retain printed pitch', async () => {
  const f = await fixture(), field = f.session.add(1, [40, 458, 300, 500], 12, true, 0, { rows: 2, spacing: 24 });
  for (const spacing of [NaN, Infinity, -1, 21]) assert.throws(() => f.session.formatField(field.name, { letterSpacing: spacing }), /spacing|formatting/);
  assert.throws(() => f.session.formatField('Authored', { letterSpacing: 1 }), /only/);
  assert.throws(() => f.session.formatField(field.name, { lineSpacing: 2 }), /printed/);
  f.session.formatField(field.name, { letterSpacing: 1 }); f.session.setValue(field.name, 'First line\nSecond line'); await f.session.save();
  assert.equal((await readTextPdf(f.bytes())).fields.find(item => item.name === field.name)!.ruled!.spacing, 24);
  assert.deepEqual(textGraphemes('e\u0301A'), ['e\u0301', 'A']);
  assert.equal(spacedWidth('e\u0301A', () => 10, 2), 24);
  assert.equal(loadToolPreferences({ letterSpacing: NaN, lineSpacing: 0 }).lineSpacing, 1.2);
});

test('a verified recovery draft retains spacing while the source remains unchanged', async () => {
  const f = await fixture(), baseline = f.bytes().slice(); let draft: PdfDraft | null = null;
  const store = { ...f.store, draft: { read: async () => draft, write: async (value: NonNullable<typeof draft>) => { draft = structuredClone(value); }, clear: async () => { draft = null; } } };
  const session = await TextSession.open(store, font), field = session.add(1, [50, 500, 350, 650], 18, true);
  session.setValue(field.name, 'Recovery spacing'); session.formatField(field.name, { letterSpacing: 1.5, lineSpacing: 1.7 }); await session.checkpoint();
  assert.deepEqual(f.bytes(), baseline);
  const recovered = await TextSession.open(store, font), value = recovered.snapshot.fields.find(item => item.name === field.name)!;
  assert.equal(value.letterSpacing, 1.5); assert.equal(value.lineSpacing, 1.7); assert.equal(value.value, 'Recovery spacing');
});
