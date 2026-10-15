import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAnswerLines } from '../src/pdf/answer-lines.ts';
import type { PagePixels } from '../src/pdf/answer-lines.ts';
import { growRuledBlock, ruledAnswerBlock, validRuledLayout } from '../src/pdf/ruled-text.ts';
import type { DetectedLine } from '../src/pdf/ruled-text.ts';
import { PDFDocument, beginMarkedContent, endMarkedContent } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decorativeFooterRules, excludeDecorativeFooters } from '../src/compat/pdf-artifacts.ts';
import type { OperatorList } from '../src/compat/pdf-artifacts.ts';
import type { PageViewport } from 'pdfjs-dist';

function image(scale = 1): PagePixels & { ink(x: number, y: number, w: number, h: number): void } {
  const width = 600 * scale;
  const height = 800 * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return {
    width,
    height,
    data,
    ink(x, y, w, h) {
      for (let j = y * scale; j < (y + h) * scale; j++) {
        for (let i = x * scale; i < (x + w) * scale; i++) {
          const index = (j * width + i) * 4;
          data[index] = data[index + 1] = data[index + 2] = 0;
        }
      }
    },
  };
}
test('answer lines merge their raster rows once and retain geometry at different resolutions', () => {
  for (const scale of [1, 2]) {
    const pixels = image(scale);
    pixels.ink(70, 150, 280, 1);
    pixels.ink(70, 220, 350, 2);
    const lines = detectAnswerLines(pixels, 600, 800);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.rect),
      [
        [70, 132, 350, 150],
        [70, 202, 420, 220],
      ],
    );
  }
});
test('answer line detection excludes table borders, occupied headings, thick rules and page edges', () => {
  const pixels = image();
  pixels.ink(70, 150, 280, 1);
  pixels.ink(70, 130, 1, 40);
  pixels.ink(349, 130, 1, 40);
  pixels.ink(70, 220, 280, 1);
  pixels.ink(85, 205, 180, 8);
  pixels.ink(70, 400, 280, 1);
  pixels.ink(70, 450, 280, 1);
  pixels.ink(70, 400, 1, 51);
  pixels.ink(349, 400, 1, 51);
  pixels.ink(70, 300, 280, 6);
  pixels.ink(0, 550, 600, 1);
  pixels.ink(70, 5, 280, 1);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});
test('blank, transparent and invalid images are harmless and large scans are bounded', () => {
  const pixels = image();
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
  pixels.data.fill(0);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
  assert.deepEqual(detectAnswerLines({ ...pixels, width: NaN }, 600, 800), []);
  assert.deepEqual(detectAnswerLines(pixels, 0, 800), []);
  assert.deepEqual(
    detectAnswerLines({ width: 2000, height: 2000, data: new Uint8ClampedArray() }, 600, 800),
    [],
  );
});

test('short dashes and gray scans are detected, with nearby labels limiting the typing area', () => {
  const pixels = image();
  for (let x = 80; x < 320; x += 10) {
    pixels.ink(x, 150, 7, 1);
  }
  pixels.ink(80, 220, 240, 1);
  pixels.ink(80, 198, 240, 7);
  pixels.ink(80, 300, 240, 1);
  pixels.ink(75, 285, 15, 10);
  // A lighter anti-aliased scanned rule.
  pixels.ink(80, 400, 240, 1);
  for (let x = 80; x < 320; x++) {
    const i = (400 * pixels.width + x) * 4;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 165;
  }
  const lines = detectAnswerLines(pixels, 600, 800);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[1]!.rect, [80, 206, 320, 220]);
  assert(lines[2]!.rect[0] >= 92, 'typing area clears a label attached at its left edge');
});

test('inset answer rules inside a frame stay fillable while the frame edges remain excluded', () => {
  for (const scale of [1, 2]) {
    for (const inset of [3, 4, 5]) {
      const pixels = image(scale);
      pixels.ink(70, 120, 401, 1);
      pixels.ink(70, 300, 401, 1);
      pixels.ink(70, 120, 1, 181);
      pixels.ink(470, 120, 1, 181);
      pixels.ink(75, 130, 110, 8); // label, above the first answer's typing area
      for (const y of [180, 210, 240]) {
        pixels.ink(70 + inset, y, 400 - inset * 2, 1);
      }
      const lines = detectAnswerLines(pixels, 600, 800);
      assert.equal(lines.length, 3, `scale ${scale}, inset ${inset}`);
      assert.deepEqual(
        lines.map((line) => line.rect),
        [180, 210, 240].map((y) => [70 + inset, y - 18, 470 - inset, y]),
      );
    }
  }
});

test('regular compact dotted answer lines are detected once at both raster resolutions, including near the bottom', () => {
  for (const scale of [1, 2]) {
    const pixels = image(scale);
    const rows = [150, 220, 300, 400, 500, 600, 775];
    for (const y of rows) {
      for (let x = 70; x < 500; x += 6) {
        pixels.ink(x, y, 2, 2);
      }
    }
    const lines = detectAnswerLines(pixels, 600, 800);
    assert.equal(lines.length, 7);
    assert.deepEqual(
      lines.map((line) => line.rect[3]),
      rows,
    );
    assert.equal(lines.at(-1)!.rect[3], 775, 'a legitimate bottom dotted line remains available');
  }
});
test('dotted patterns do not admit irregular punctuation, short ellipses, tall letter stems or occupied dot leaders', () => {
  const pixels = image();
  for (let x = 70, i = 0; x < 400; i++) {
    pixels.ink(x, 150, [1, 3, 2, 1][i % 4]!, 2);
    x += [6, 10, 4, 8][i % 4]!;
  }
  for (let x = 70; x < 90; x += 6) {
    pixels.ink(x, 220, 2, 2);
  }
  for (let x = 70; x < 400; x += 6) {
    pixels.ink(x, 300, 2, 10);
  }
  for (let x = 70; x < 400; x += 6) {
    pixels.ink(x, 400, 2, 2);
  }
  pixels.ink(90, 383, 180, 12);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});
test('gray dots and mixed solid/dashed/dotted rules retain their individual typing areas', () => {
  const pixels = image();
  pixels.ink(70, 150, 350, 1);
  for (let x = 70; x < 420; x += 10) {
    pixels.ink(x, 220, 7, 1);
  }
  for (let x = 70; x < 420; x += 8) {
    pixels.ink(x, 300, 2, 2);
  }
  for (let y = 300; y < 302; y++) {
    for (let x = 70; x < 420; x++) {
      const i = (y * pixels.width + x) * 4;
      if (pixels.data[i] === 0) {
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 165;
      }
    }
  }
  assert.deepEqual(
    detectAnswerLines(pixels, 600, 800).map((line) => line.rect[3]),
    [150, 220, 300],
  );
});

const line = (y: number, page = 1, x = 70): DetectedLine => ({
  page,
  rect: [x, y, x + 300, y + 18],
});
test('aligned consecutive lines form one fixed writing block from any clicked row', () => {
  const rows = [620, 596, 572, 548].map((y) => line(y));
  for (const target of rows) {
    assert.deepEqual(
      ruledAnswerBlock([...rows].reverse(), target, () => false),
      { rect: [70, 548, 370, 638], layout: { spacing: 24, rows: 4 } },
    );
  }
});
test('grouping stops at occupied lines, page boundaries, column offsets and question gaps', () => {
  const rows = [
    line(620),
    line(596),
    line(572),
    line(548),
    line(500),
    line(476, 1, 100),
    line(452, 2),
  ];
  assert.deepEqual(
    ruledAnswerBlock(rows, rows[0]!, (l) => l === rows[2]),
    { rect: [70, 596, 370, 638], layout: { spacing: 24, rows: 2 } },
  );
  assert.equal(
    ruledAnswerBlock(rows, rows[2]!, (l) => l === rows[2]),
    undefined,
  );
  for (const i of [3, 4, 5, 6]) {
    assert.equal(
      ruledAnswerBlock(rows, rows[i]!, (l) => l === rows[2]),
      undefined,
    );
  }
  assert.equal(
    ruledAnswerBlock([line(620), line(596), line(569)], line(596), () => false)?.layout.rows,
    2,
  );
});
test('invalid stored layouts never become a ruled answer block', () => {
  for (const layout of [
    { spacing: NaN, rows: 3 },
    { spacing: 24, rows: 0 },
    { spacing: 24, rows: 2.5 },
    { spacing: 100, rows: 3 },
    { spacing: 24, rows: 1000 },
  ]) {
    assert.equal(validRuledLayout(layout, [70, 572, 370, 638]), false);
  }
});

test('fractional-pitch growth retains CropBox bounds and whole rows without upward movement', () => {
  const rect: [number, number, number, number] = [70, 227.68, 370, 286];
  const layout = { spacing: 20.16, rows: 3 };
  const grown = growRuledBlock(rect, layout, 6, 13, [40, 100, 500, 700]);
  assert.equal(grown.rect[3], 286);
  assert.equal(grown.layout?.rows, 6);
  assert(validRuledLayout(grown.layout!, grown.rect));
  assert(Math.abs(grown.rect[1] - 167.2) < 0.001);
  const edge = growRuledBlock(grown.rect, grown.layout!, 100, 13, [40, 100, 500, 700]);
  assert.equal(edge.layout?.rows, 9);
  assert(edge.rect[1] >= 100);
  assert(validRuledLayout(edge.layout!, edge.rect));
});

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.pushOperators(beginMarkedContent('Artifact'));
  page.drawRectangle({ x: 50, y: 40, width: 500, height: 0.5 });
  page.pushOperators(endMarkedContent());
  // A legitimate full-width answer closer to the bottom, with no decorative tag.
  page.drawLine({ start: { x: 50, y: 20 }, end: { x: 550, y: 20 }, thickness: 0.5 });
  const task = getDocument({ data: await pdf.save(), isEvalSupported: false });
  const doc = await task.promise;
  const pdfPage = await doc.getPage(1);
  const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  return { task, page: pdfPage, viewport };
}
test('only a PDF-declared decorative footer is excluded; an equally wide lower answer remains', async () => {
  const f = await fixture();
  try {
    const rules = decorativeFooterRules(await f.page.getOperatorList(), OPS, f.viewport);
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0], [50, 759.5, 550, 760]);
    const footer = { rect: [50, 742, 550, 760] as [number, number, number, number] };
    const answer = { rect: [50, 762, 550, 780] as [number, number, number, number] };
    assert.deepEqual(excludeDecorativeFooters([footer, answer], rules), [answer]);
    assert.deepEqual(excludeDecorativeFooters([footer, answer], []), [footer, answer]);
  } finally {
    await f.task.destroy();
  }
});
test('transformed nested artifacts and adjacent painted pieces combine without covering unrelated answers', async () => {
  const f = await fixture();
  try {
    const list: OperatorList = {
      fnArray: [
        OPS.save,
        OPS.transform,
        OPS.beginMarkedContent,
        OPS.beginMarkedContentProps,
        OPS.constructPath,
        OPS.constructPath,
        OPS.endMarkedContent,
        OPS.endMarkedContent,
        OPS.restore,
        OPS.constructPath,
      ],
      argsArray: [
        null,
        [1, 0, 0, 1, 10, 10],
        ['Artifact'],
        ['Span', 1],
        [OPS.fill, [], [40, 30, 280, 30.5]],
        [OPS.fill, [], [280, 30, 540, 30.5]],
        null,
        null,
        null,
        [OPS.fill, [], [50, 20, 550, 20.5]],
      ],
    };
    assert.deepEqual(decorativeFooterRules(list, OPS, f.viewport), [[50, 759.5, 550, 760]]);
  } finally {
    await f.task.destroy();
  }
});
test('legacy or malformed operator bounds, clips, non-footer graphics and untagged rules fail open', async () => {
  const f = await fixture();
  try {
    const list: OperatorList = {
      fnArray: [
        OPS.beginMarkedContent,
        OPS.constructPath,
        OPS.constructPath,
        OPS.constructPath,
        OPS.constructPath,
        OPS.endMarkedContent,
        OPS.constructPath,
      ],
      argsArray: [
        ['Artifact'],
        [[OPS.rectangle], [50, 40, 500, 0.5], [50, 40, 550, 40.5]],
        [OPS.fill, [], [50, NaN, 550, 40.5]],
        [OPS.endPath, [], [50, 40, 550, 40.5]],
        [OPS.fill, [], [50, 600, 550, 600.5]],
        null,
        [OPS.fill, [], [50, 40, 550, 40.5]],
      ],
    };
    assert.deepEqual(decorativeFooterRules(list, OPS, f.viewport), []);
  } finally {
    await f.task.destroy();
  }
});

test('malformed viewport conversion results retain footer answer candidates', () => {
  const list: OperatorList = {
    fnArray: [OPS.beginMarkedContent, OPS.constructPath],
    argsArray: [['Artifact'], [OPS.fill, [], [50, 40, 550, 40.5]]],
  };
  for (const result of [
    undefined,
    null,
    [50],
    [50, 760, 1],
    ['50', 760],
    [NaN, 760],
    [50, Infinity],
  ]) {
    const viewport = {
      width: 600,
      height: 800,
      convertToViewportPoint: () => result,
    } as unknown as PageViewport;
    assert.deepEqual(decorativeFooterRules(list, OPS, viewport), []);
  }
  const viewport = {
    width: 600,
    height: 800,
    convertToViewportPoint: (x: number, y: number) => new Float64Array([x, 800 - y]),
  } as unknown as PageViewport;
  assert.deepEqual(decorativeFooterRules(list, OPS, viewport), [[50, 759.5, 550, 760]]);
});
