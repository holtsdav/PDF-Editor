import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

async function open() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]);
  let bytes = await pdf.save();
  const session = await TextSession.open(
    {
      read: async () => bytes.slice(),
      write: async (value) => {
        bytes = value.slice();
      },
      backup: async () => '',
    },
    font,
  );
  return { session, bytes: () => bytes };
}

test('rectangles, ellipses, lines and arrows are saved as standard PDF annotations', async () => {
  const { session, bytes } = await open();
  const rectangle = session.addShape({
    page: 1,
    kind: 'rectangle',
    box: [40, 260, 160, 340],
    color: [0.8, 0.1, 0.1],
    width: 2,
  });
  session.addShape({
    page: 1,
    kind: 'ellipse',
    box: [200, 260, 340, 340],
    color: [0.1, 0.3, 0.8],
    fill: [0.7, 0.85, 1],
    width: 3,
  });
  session.addShape({
    page: 1,
    kind: 'line',
    start: [40, 200],
    end: [340, 200],
    color: [0, 0, 0],
    width: 1,
  });
  session.addShape({
    page: 1,
    kind: 'arrow',
    start: [40, 120],
    end: [300, 160],
    color: [0.1, 0.6, 0.2],
    width: 2,
  });
  await session.save();
  assert.equal(session.status, 'saved');

  const shapes = (await readTextPdf(bytes())).shapes!;
  assert.deepEqual(
    shapes.map((shape) => [shape.kind, shape.fill ?? null, shape.width]),
    [
      ['rectangle', null, 2],
      ['ellipse', [0.7, 0.85, 1], 3],
      ['line', null, 1],
      ['arrow', null, 2],
    ],
  );
  // PDF.js (Firefox, Obsidian) sees standard Square, Circle and Line annotations.
  const document = await getDocument({ data: bytes().slice() }).promise;
  const annotations = await (await document.getPage(1)).getAnnotations();
  assert.deepEqual(
    annotations.map((item) => item.subtype),
    ['Square', 'Circle', 'Line', 'Line'],
  );
  assert.deepEqual(annotations[2]!.lineCoordinates, [40, 200, 340, 200]);
  await document.destroy();
  const pdf = await PDFDocument.load(bytes());
  const arrow = pdf.context.lookup(pdf.getPages()[0]!.node.Annots()!.get(3), PDFDict);
  assert.equal(arrow.lookup(PDFName.of('LE'))!.toString(), '[ /None /ClosedArrow ]');
  await writeFile(new URL('../tmp/shapes.pdf', import.meta.url), bytes());

  // Moving, restyling and deleting, each undoable.
  session.updateShape(rectangle.id, { box: [60, 240, 180, 320], fill: [1, 0.9, 0.5] });
  session.updateShape(rectangle.id, { color: [0, 0, 0], width: 4 });
  session.undoStroke();
  assert.equal(session.snapshot.shapes![0]!.width, 2);
  session.updateShape(rectangle.id, { fill: null });
  assert.equal(session.snapshot.shapes![0]!.fill, undefined);
  session.deleteShape(session.snapshot.shapes![3]!.id);
  await session.save();
  const saved = (await readTextPdf(bytes())).shapes!;
  assert.equal(saved.length, 3);
  assert.deepEqual(saved[0]!.box, [60, 240, 180, 320]);
  assert.equal(saved[0]!.fill, undefined);
  // The editor paints shapes itself, so the display copy has none.
  const display = await PDFDocument.load(await renderTextPdf(bytes()));
  assert.equal(display.getPages()[0]!.node.Annots()?.size() ?? 0, 0);
});

test('shapes must stay inside the page and lines cannot be filled', async () => {
  const { session } = await open();
  assert.throws(
    () =>
      session.addShape({
        page: 1,
        kind: 'rectangle',
        box: [300, 300, 500, 380],
        color: [0, 0, 0],
        width: 1,
      }),
    /inside its PDF page/,
  );
  assert.throws(
    () =>
      session.addShape({
        page: 1,
        kind: 'line',
        start: [10, 10],
        end: [10.2, 10.2],
        color: [0, 0, 0],
        width: 1,
      }),
    /Invalid shape/,
  );
  const line = session.addShape({
    page: 1,
    kind: 'line',
    start: [10, 10],
    end: [100, 10],
    color: [0, 0, 0],
    width: 1,
  });
  session.updateShape(line.id, { fill: [1, 0, 0] });
  assert.equal(session.snapshot.shapes![0]!.fill, undefined, 'fill is ignored for lines');
});
