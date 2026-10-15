import test from 'node:test';
import assert from 'node:assert/strict';
import { growBox, rotatedHandle, transformBox } from '../src/pdf/box-geometry.ts';
import { wrapText } from '../src/pdf/wrap-text.ts';
import { snapTextBands } from '../src/pdf/marker-text.ts';
import type { TextWord } from '../src/pdf/marker-text.ts';
import { resizeInkFrame, resizeInkPoints } from '../src/pdf/ink-geometry.ts';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { measureTextWords } from '../src/ui/text-geometry.ts';
import type { NativePage } from '../src/compat/native-pdf.ts';

test('move and resize keep boxes inside the page while preserving the opposite edge', () => {
  const bounds: [number, number, number, number] = [0, 0, 600, 800];
  const rect: [number, number, number, number] = [100, 200, 300, 250];
  assert.deepEqual(transformBox(rect, bounds, [1000, -1000]), [400, 0, 600, 50]);
  assert.deepEqual(transformBox(rect, bounds, [-1000, -1000], 'nw'), [0, 0, 300, 250]);
  assert.deepEqual(transformBox(rect, bounds, [-1000, -1000], 'se'), [100, 200, 140, 220]);
  assert.deepEqual(transformBox(rect, bounds, [1000, 1000], 'se'), [100, 200, 600, 800]);
});

test('quarter-turn handles and text growth follow local text orientation', () => {
  assert.equal(rotatedHandle('e', 90), 's');
  assert.equal(rotatedHandle('nw', 90), 'ne');
  assert.equal(rotatedHandle('s', 180), 'n');
  assert.equal(rotatedHandle('s', 270), 'e');
  const rect: [number, number, number, number] = [100, 100, 200, 150];
  const bounds: [number, number, number, number] = [0, 0, 600, 800];
  assert.deepEqual(growBox(rect, bounds, 120, 0), [100, 100, 200, 220]);
  assert.deepEqual(growBox(rect, bounds, 120, 90), [80, 100, 200, 150]);
  assert.deepEqual(growBox(rect, bounds, 120, 180), [100, 30, 200, 150]);
  assert.deepEqual(growBox(rect, bounds, 120, 270), [100, 100, 220, 150]);
  assert.deepEqual(growBox(rect, bounds, 1000, 0), [100, 100, 200, 800]);
});

test('wrapping keeps explicit lines and splits long words without splitting combining characters', () => {
  const measure = (text: string) =>
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].length;
  assert.deepEqual(wrapText('First answer\n\nThird line', 12, measure), [
    'First answer',
    '',
    'Third line',
  ]);
  assert.deepEqual(wrapText('A longer answer', 8, measure), ['A', 'longer', 'answer']);
  assert.deepEqual(wrapText('áb́ćd́é', 2, measure), ['áb́', 'ćd́', 'é']);
});

test('text snapping merges adjacent crossed words, separates rows and leaves uncrossed text alone', () => {
  const words: TextWord[] = [
    { start: [20, 100], end: [50, 100], height: 12, order: 0 },
    { start: [55, 100], end: [90, 100], height: 12, order: 1 },
    { start: [20, 75], end: [90, 75], height: 12, order: 2 },
    { start: [150, 75], end: [190, 75], height: 12, order: 3 },
  ];
  const bands = snapTextBands(
    [
      [25, 100],
      [85, 100],
      [85, 75],
      [25, 75],
    ],
    words,
  );
  assert.deepEqual(bands, [
    {
      points: [
        [20, 100],
        [90, 100],
      ],
      width: 12,
    },
    {
      points: [
        [20, 75],
        [90, 75],
      ],
      width: 12,
    },
  ]);
  assert.deepEqual(
    snapTextBands(
      [
        [1, 1],
        [10, 1],
      ],
      words,
    ),
    [],
  );
  assert.deepEqual(snapTextBands([[25, 100]], []), []);
});
test('vertical text uses its PDF-space direction without connecting columns', () => {
  const words: TextWord[] = [
    { start: [100, 20], end: [100, 60], height: 14, order: 0 },
    { start: [125, 20], end: [125, 60], height: 14, order: 1 },
  ];
  assert.equal(
    snapTextBands(
      [
        [100, 30],
        [100, 50],
      ],
      words,
    ).length,
    1,
  );
});
test('ink resizing preserves the opposite anchor and proportional shape at page boundaries', () => {
  const frame = resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [500, 500], 'se', 4, true);
  assert.deepEqual(frame, [100, 100, 300, 200]);
  const points = resizeInkPoints(
    [
      [102, 102],
      [198, 148],
    ],
    [100, 100, 200, 150],
    frame,
  );
  assert.deepEqual(points, [
    [102, 102],
    [298, 198],
  ]);
  const collapsed = resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [-500, -500], 'se', 4);
  assert(collapsed[2] > collapsed[0] && collapsed[3] > collapsed[1]);
});

test('proportional corner resizing can shrink with a single-axis gesture', () => {
  assert.deepEqual(
    resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [-20, 0], 'se', 4, true),
    [100, 100, 180, 140],
  );
});

// Use actual PDF.js transforms; mock only browser glyph layout, which jsdom does not implement.
test('word geometry stays in PDF space at every quarter turn and CSS-scaled zoom', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const task = getDocument({ data: await pdf.save() });
  try {
    const page = await (await task.promise).getPage(1);
    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.35, 1, 3]) {
        const viewport = page.getViewport({ scale, rotation });
        const cssScale = 0.8;
        const dom = new JSDOM('<div id="page"><div id="text"><span>Alpha Beta</span></div></div>');
        const doc = dom.window.document;
        const div = doc.querySelector<HTMLElement>('#page')!;
        const layer = doc.querySelector<HTMLElement>('#text')!;
        const box = {
          left: 30,
          top: 45,
          width: viewport.width * cssScale,
          height: viewport.height * cssScale,
          right: 30 + viewport.width * cssScale,
          bottom: 45 + viewport.height * cssScale,
        };
        div.getBoundingClientRect = () => box as DOMRect;
        doc.createRange = () => {
          let offset = 0;
          return {
            setStart: (_node: Node, start: number) => {
              offset = start;
            },
            setEnd: () => {},
            getBoundingClientRect: () => {
              const rect = viewport.convertToViewportRectangle(
                offset ? [110, 644, 150, 656] : [50, 644, 100, 656],
              );
              const left = Math.min(rect[0]!, rect[2]!) * cssScale + box.left;
              const top = Math.min(rect[1]!, rect[3]!) * cssScale + box.top;
              const width = Math.abs(rect[2]! - rect[0]!) * cssScale;
              const height = Math.abs(rect[3]! - rect[1]!) * cssScale;
              return { left, top, right: left + width, bottom: top + height, width, height };
            },
          } as unknown as Range;
        };
        const words = measureTextWords(layer, {
          div,
          viewport,
          number: 1,
        } as NativePage);
        assert.equal(words.length, 2);
        for (const [index, word] of words.entries()) {
          for (const [actual, expected] of [
            [word.start[0], index ? 110 : 50],
            [word.start[1], 650],
            [word.end[0], index ? 150 : 100],
            [word.end[1], 650],
            [word.height, 12],
          ]) {
            assert(
              Math.abs(actual! - expected!) < 0.00001,
              `${rotation}/${scale}: ${actual} != ${expected}`,
            );
          }
        }
        dom.window.close();
      }
    }
  } finally {
    await task.destroy();
  }
});

test('missing, skewed or broken glyph measurements fall back without preventing a marker gesture', () => {
  const dom = new JSDOM('<div><span style="transform: rotate(13deg)">Unknown</span></div>');
  const div = dom.window.document.querySelector('div')!;
  const page = {
    div,
    viewport: {
      width: 600,
      height: 800,
      scale: 1,
      rotation: 0,
      convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    },
    number: 1,
  } as unknown as NativePage;
  div.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }) as DOMRect;
  assert.deepEqual(measureTextWords(div, page), []);
  div.querySelector('span')!.style.transform = '';
  assert.deepEqual(measureTextWords(div, page), []);
  dom.window.document.createRange = () => {
    throw new Error('Unavailable range');
  };
  assert.deepEqual(measureTextWords(div, page), []);
  dom.window.close();
});
