import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { PDFDocument, PDFDict, PDFName, PDFStream, PDFString, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TextSession } from '../../src/pdf/text-session.ts';
import type { PdfDraft, PdfStore } from '../../src/pdf/text-session.ts';
import { readTextPdf } from '../../src/pdf/text-engine.ts';

const font = new Uint8Array(await readFile(new URL('../../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
const standardFontDataUrl = new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;
// Resolve from the repository, keeping anonymous output outside Git.
const output = new URL('../../tmp/production-audit/', import.meta.url);
let randomState = 0x504446;
function random(): number { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; }
function memory(seed: Uint8Array) {
  let bytes = seed, draft: PdfDraft | null = null, active = 0, maximum = 0, writes = 0;
  const store: PdfStore = { read: async () => { await setImmediate(); return bytes.slice(); },
    write: async value => { maximum = Math.max(maximum, ++active); await setImmediate(); bytes = value.slice(); writes++; active--; }, backup: async () => 'original.pdf',
    draft: { read: async () => draft && structuredClone(draft), write: async value => { await setImmediate(); draft = structuredClone(value); }, clear: async () => { draft = null; } } };
  return { store, bytes: () => bytes, writes: () => writes, maximum: () => maximum };
}
function comparable(snapshot: Awaited<ReturnType<typeof readTextPdf>>) {
  return { fields: snapshot.fields.map(field => ({ name: field.name, value: field.value, widgets: field.widgets, color: field.color, fontSize: field.fontSize })).sort((a, b) => a.name.localeCompare(b.name)),
    strokes: snapshot.strokes.map(stroke => ({ id: stroke.id, page: stroke.page, points: stroke.points.length === 1 ? [...stroke.points, ...stroke.points] : stroke.points, color: stroke.color, width: stroke.width })).sort((a, b) => a.id.localeCompare(b.id)) };
}
async function fixture(pages = 8) {
  const pdf = await PDFDocument.create(); pdf.setTitle('Anonymous stress fixture');
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([600, 800]); page.setRotation(degrees((i % 4) * 90));
    page.drawText(`Preserved page ${i + 1}`, { x: 40, y: 750, size: 18 });
    const field = pdf.getForm().createTextField(`Authored-${i}`); field.setText('Original'); field.addToPage(page, { x: 40, y: 680, width: 300, height: 30 });
    const check = pdf.getForm().createCheckBox(`Check-${i}`); check.addToPage(page, { x: 400, y: 680 }); check.check();
    page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 720, 200, 740], A: { S: 'URI', URI: PDFString.of('https://example.com') } })));
  }
  return pdf.save();
}

test('1,200 mixed edits with 240 concurrent save/checkpoint/check requests preserve final state', { timeout: 120000 }, async t => {
  const file = memory(await fixture()), session = await TextSession.open(file.store, font), start = performance.now();
  for (let batch = 0; batch < 40; batch++) {
    for (let action = 0; action < 30; action++) {
      const choice = Math.floor(random() * 8), page = 1 + Math.floor(random() * 8);
      const owned = session.snapshot.fields.filter(field => field.owned), strokes = session.snapshot.strokes;
      if (choice === 0 || !owned.length) { const box = session.add(page, [40, 100 + batch, 300, 180 + batch], 14, true); session.setValue(box.name, `Answer ${batch}-${action} Grüße`); }
      else if (choice === 1) session.setValue(owned[Math.floor(random() * owned.length)]!.name, `Revised ${batch}-${action}`);
      else if (choice === 2) session.delete(owned[Math.floor(random() * owned.length)]!.name);
      else if (choice === 3 || !strokes.length) session.addStroke(page, 'scribble', [[40 + batch, 300], [80, 340 + batch], [140, 320]], 2);
      else if (choice === 4) session.deleteStroke(strokes[Math.floor(random() * strokes.length)]!.id);
      else if (choice === 5) session.moveStroke(strokes[Math.floor(random() * strokes.length)]!.id, [2, 3]);
      else if (choice === 6) session.undoStroke(); else session.redoStroke();
    }
    const expected = comparable(structuredClone(session.snapshot));
    await Promise.all([session.checkpoint(), session.save(), session.save(), session.checkExternal(), session.checkpoint(), session.save()]);
    assert.deepEqual(comparable(await readTextPdf(file.bytes())), expected, `Batch ${batch}`);
    assert.equal(session.dirty, false);
  }
  assert.equal(file.maximum(), 1);
  const saved = await PDFDocument.load(file.bytes()); assert.equal(saved.getTitle(), 'Anonymous stress fixture');
  for (let i = 0; i < 8; i++) {
    assert(saved.getForm().getCheckBox(`Check-${i}`).isChecked());
    assert(saved.getPages()[i]!.node.Annots()!.asArray().some(ref => saved.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))?.toString() === '/Link'));
  }
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try { const doc = await task.promise; for (let i = 1; i <= 8; i++) { const page = await doc.getPage(i); await page.getOperatorList(); assert((await page.getTextContent()).items.some(item => 'str' in item && item.str === `Preserved page ${i}`)); } }
  finally { await task.destroy(); }
  await mkdir(output, { recursive: true }); await writeFile(new URL('mixed-edits.pdf', output), file.bytes());
  t.diagnostic(JSON.stringify({ workload: 'mixed', actions: 1200, queuedRequests: 240, writes: file.writes(), milliseconds: Math.round(performance.now() - start), bytes: file.bytes().length }));
});

test('120 pages and 1,200 long ink strokes save and reopen through independent PDF.js', { timeout: 120000 }, async t => {
  const file = memory(await fixture(120)), session = await TextSession.open(file.store, font), start = performance.now();
  // One grouped action avoids measuring 1,200 separate full undo snapshots.
  session.beginInkAction();
  for (let i = 0; i < 1200; i++) session.addStroke(1 + i % 120, i % 2 ? 'marker' : 'scribble', Array.from({ length: 128 }, (_, point) => [30 + point * 3, 200 + (i % 10) * 20 + Math.sin(point / 8) * 8]), i % 2 ? 14 : 2);
  session.finishInkAction(); await session.save();
  const reopened = await readTextPdf(file.bytes()); assert.equal(reopened.pages.length, 120); assert.equal(reopened.strokes.length, 1200); assert.equal(new Set(reopened.strokes.map(stroke => stroke.id)).size, 1200);
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try { const doc = await task.promise; assert.equal(doc.numPages, 120); for (const number of [1, 60, 120]) { const page = await doc.getPage(number); assert.equal((await page.getAnnotations()).filter(a => a.subtype === 'Ink').length, 10); await page.getOperatorList(); } }
  finally { await task.destroy(); }
  await mkdir(output, { recursive: true }); await writeFile(new URL('large-ink.pdf', output), file.bytes());
  t.diagnostic(JSON.stringify({ workload: 'large-ink', pages: 120, strokes: 1200, points: 153600, milliseconds: Math.round(performance.now() - start), bytes: file.bytes().length }));
});

test('50 close/reopen/edit/save cycles retain field identities and measure file growth', { timeout: 120000 }, async t => {
  const file = memory(await fixture(1)), start = performance.now(), sizes: number[] = [];
  for (let cycle = 0; cycle < 50; cycle++) {
    const session = await TextSession.open(file.store, font); session.setValue('Authored-0', `Revision ${String(cycle).padStart(3, '0')}`); await session.save();
    const snapshot = await readTextPdf(file.bytes()); assert.equal(snapshot.fields.length, 1); assert.equal(snapshot.fields[0]!.value, `Revision ${String(cycle).padStart(3, '0')}`); sizes.push(file.bytes().length);
  }
  assert(sizes.at(-1)! < sizes[0]! * 1.2, 'Replacing appearances must not accumulate dead fonts across sessions');
  t.diagnostic(JSON.stringify({ workload: 'reopen-growth', cycles: 50, milliseconds: Math.round(performance.now() - start), firstBytes: sizes[0], lastBytes: sizes.at(-1), growthRatio: Number((sizes.at(-1)! / sizes[0]!).toFixed(2)) }));
});

test('24 MiB of image data survives five full-file rewrites', { timeout: 120000 }, async t => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 8; i++) {
    const page = pdf.addPage([600, 800]), pixels = new Uint8Array(1024 * 1024 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = Math.floor(random() * 256);
    const image = pdf.context.register(pdf.context.flateStream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 1024, Height: 1024, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    page.node.setXObject(PDFName.of('TestImage'), image);
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream('q 500 0 0 500 50 200 cm /TestImage Do Q')));
    const field = pdf.getForm().createTextField(`Answer-${i}`); field.addToPage(page, { x: 50, y: 100, width: 400, height: 30 });
  }
  const seed = await pdf.save(), file = memory(seed), start = performance.now();
  let lastTick = performance.now(), maxEventLoopDelay = 0, saveMilliseconds = 0, savePeakRssMiB = 0;
  const timer = setInterval(() => { const now = performance.now(); maxEventLoopDelay = Math.max(maxEventLoopDelay, now - lastTick - 10); lastTick = now; }, 10);
  try {
    const session = await TextSession.open(file.store, font);
    for (let cycle = 0; cycle < 5; cycle++) { session.setValue('Answer-0', `Image workload ${cycle}`); await session.save(); }
    await setImmediate(); clearInterval(timer);
    saveMilliseconds = Math.round(performance.now() - start); savePeakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
    assert.equal((await readTextPdf(file.bytes())).fields[0]!.value, 'Image workload 4');
    const source = await PDFDocument.load(seed), saved = await PDFDocument.load(file.bytes());
    for (let i = 0; i < 8; i++) {
      const image = (doc: PDFDocument) => doc.getPages()[i]!.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('TestImage'), PDFStream);
      assert.deepEqual(image(source).getContents(), image(saved).getContents(), `Image ${i + 1} changed`);
    }
    await mkdir(output, { recursive: true }); await writeFile(new URL('image-heavy.pdf', output), file.bytes());
  } finally { clearInterval(timer); }
  t.diagnostic(JSON.stringify({ workload: 'image-heavy', pages: 8, writes: 5, sourceBytes: seed.length, outputBytes: file.bytes().length, saveMilliseconds, maxEventLoopDelayMs: Math.round(maxEventLoopDelay), savePeakRssMiB }));
});
