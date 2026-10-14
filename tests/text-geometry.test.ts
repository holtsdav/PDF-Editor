import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { measureTextWords } from '../src/ui/text-geometry.ts';
import type { NativePage } from '../src/compat/native-pdf.ts';

// Use actual PDF.js transforms; mock only browser glyph layout, which jsdom does not implement.
test('word geometry stays in PDF space at every quarter turn and CSS-scaled zoom', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const task = getDocument({ data: await pdf.save() });
  try {
    const page = await (await task.promise).getPage(1);
    for (const rotation of [0, 90, 180, 270]) for (const scale of [0.35, 1, 3]) {
      const viewport = page.getViewport({ scale, rotation }), cssScale = 0.8;
      const dom = new JSDOM('<div id="page"><div id="text"><span>Alpha Beta</span></div></div>');
      const doc = dom.window.document, div = doc.querySelector<HTMLElement>('#page')!, layer = doc.querySelector<HTMLElement>('#text')!;
      const box = { left: 30, top: 45, width: viewport.width * cssScale, height: viewport.height * cssScale,
        right: 30 + viewport.width * cssScale, bottom: 45 + viewport.height * cssScale };
      div.getBoundingClientRect = () => box as DOMRect;
      doc.createRange = () => {
        let offset = 0;
        return { setStart: (_node: Node, start: number) => { offset = start; }, setEnd: () => {}, getBoundingClientRect: () => {
          const rect = viewport.convertToViewportRectangle(offset ? [110, 644, 150, 656] : [50, 644, 100, 656]);
          const left = Math.min(rect[0]!, rect[2]!) * cssScale + box.left, top = Math.min(rect[1]!, rect[3]!) * cssScale + box.top;
          const width = Math.abs(rect[2]! - rect[0]!) * cssScale, height = Math.abs(rect[3]! - rect[1]!) * cssScale;
          return { left, top, right: left + width, bottom: top + height, width, height };
        } } as unknown as Range;
      };
      const words = measureTextWords(layer, { div, viewport, number: 1, annotationElements: () => [] } as NativePage);
      assert.equal(words.length, 2);
      for (const [index, word] of words.entries()) {
        for (const [actual, expected] of [[word.start[0], index ? 110 : 50], [word.start[1], 650], [word.end[0], index ? 150 : 100], [word.end[1], 650], [word.height, 12]]) assert(Math.abs(actual! - expected!) < 0.00001, `${rotation}/${scale}: ${actual} != ${expected}`);
      }
      dom.window.close();
    }
  } finally { await task.destroy(); }
});

test('missing, skewed or broken glyph measurements fall back without preventing a marker gesture', () => {
  const dom = new JSDOM('<div><span style="transform: rotate(13deg)">Unknown</span></div>');
  const div = dom.window.document.querySelector('div')!;
  const page = { div, viewport: { width: 600, height: 800, scale: 1, rotation: 0, convertToPdfPoint: (x: number, y: number) => [x, 800 - y] }, number: 1, annotationElements: () => [] } as unknown as NativePage;
  div.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }) as DOMRect;
  assert.deepEqual(measureTextWords(div, page), []);
  div.querySelector('span')!.style.transform = '';
  assert.deepEqual(measureTextWords(div, page), []);
  dom.window.document.createRange = () => { throw new Error('Unavailable range'); };
  assert.deepEqual(measureTextWords(div, page), []);
  dom.window.close();
});
