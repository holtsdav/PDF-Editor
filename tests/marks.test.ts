import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFHexString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { lineQuads, subtractQuads } from '../src/pdf/mark-engine.ts';
import type { Rect } from '../src/pdf/text-engine.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

async function textPdf(foreign = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('The quick brown fox jumps over the lazy dog.', {
    x: 40,
    y: 340,
    size: 12,
    font: helvetica,
  });
  page.drawText('Second line of text.', { x: 40, y: 320, size: 12, font: helvetica });
  if (foreign) {
    // A highlight made by another app (no NM prefix) must stay untouched.
    page.node.addAnnot(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: [40, 300, 100, 312],
          QuadPoints: [40, 312, 100, 312, 40, 300, 100, 300],
          C: [0, 1, 0],
          Contents: PDFHexString.fromText('Foreign note'),
        }),
      ),
    );
  }
  return pdf.save();
}

function memory(seed: Uint8Array) {
  let bytes = seed.slice();
  const store = {
    read: async () => bytes.slice(),
    write: async (value: Uint8Array) => {
      bytes = value.slice();
    },
    backup: async () => 'backup.pdf',
  };
  return { store, bytes: () => bytes };
}

test('selection rectangles merge into one quad per text line', () => {
  const rects: Rect[] = [
    [40, 338, 70, 352],
    [70, 338.5, 120, 351.5],
    [40, 318, 90, 332],
    [10, 10, 10.2, 10.2],
  ];
  assert.deepEqual(lineQuads(rects), [
    [40, 338, 120, 352],
    [40, 318, 90, 332],
  ]);
});

test('highlights and notes are saved as standard annotations other readers show', async () => {
  const file = memory(await textPdf(true));
  const session = await TextSession.open(file.store, font);
  const highlight = session.addMark({
    page: 1,
    kind: 'highlight',
    quads: [
      [40, 338, 200, 352],
      [40, 318, 140, 332],
    ],
    color: [1, 0.85, 0.1],
    comment: 'Wichtig für die Prüfung – €, ü, 日本',
  });
  const note = session.addMark({
    page: 1,
    kind: 'note',
    at: [300, 380],
    color: [1, 0.9, 0.3],
    comment: 'Frage an den Dozenten',
  });
  await session.save();
  assert.equal(session.status, 'saved');

  // Our own reader.
  const marks = (await readTextPdf(file.bytes())).marks!;
  assert.deepEqual(
    marks.map((mark) => [mark.kind, mark.comment]),
    [
      ['highlight', 'Wichtig für die Prüfung – €, ü, 日本'],
      ['note', 'Frage an den Dozenten'],
    ],
  );

  // PDF.js (Firefox, Obsidian) reads type, comment, author and quad points.
  const document = await getDocument({ data: file.bytes().slice() }).promise;
  const annotations = await (await document.getPage(1)).getAnnotations();
  const shown = annotations.filter((item) => item.subtype !== 'Popup');
  const ours = shown.filter((item) => item.titleObj?.str === 'PDF Editor');
  assert.deepEqual(
    ours.map((item) => [item.subtype, item.contentsObj?.str]),
    [
      ['Highlight', 'Wichtig für die Prüfung – €, ü, 日本'],
      ['Text', 'Frage an den Dozenten'],
    ],
  );
  assert.equal(ours[0]!.quadPoints.length, 2 * 8);
  assert.ok(shown.some((item) => item.contentsObj?.str === 'Foreign note'));
  assert.equal(annotations.filter((item) => item.subtype === 'Popup').length, 2);
  await document.destroy();

  // Editing and deleting keep exactly one annotation per mark.
  session.updateMark(highlight.id, { comment: 'Geändert', color: [0.4, 0.9, 0.4] });
  session.deleteMark(note.id);
  await session.save();
  const pdf = await PDFDocument.load(file.bytes());
  const dicts = pdf
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => pdf.context.lookup(ref, PDFDict));
  const subtypes = dicts.map((dict) => dict.get(PDFName.of('Subtype'))?.toString());
  assert.deepEqual(subtypes.sort(), ['/Highlight', '/Highlight', '/Popup']);
  const saved = (await readTextPdf(file.bytes())).marks!;
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.comment, 'Geändert');
  assert.deepEqual(saved[0]!.color, [0.4, 0.9, 0.4]);
});

test('undo and redo restore highlights and comments', async () => {
  const file = memory(await textPdf());
  const session = await TextSession.open(file.store, font);
  const mark = session.addMark({
    page: 1,
    kind: 'highlight',
    quads: [[40, 338, 200, 352]],
    color: [1, 0.85, 0.1],
  });
  session.updateMark(mark.id, { comment: 'A' });
  session.updateMark(mark.id, { comment: 'AB' });
  session.undoStroke();
  assert.equal(session.snapshot.marks![0]!.comment, '');
  session.undoStroke();
  assert.equal(session.snapshot.marks!.length, 0);
  session.redoStroke();
  session.redoStroke();
  assert.equal(session.snapshot.marks![0]!.comment, 'AB');
  session.deleteMark(mark.id);
  session.undoStroke();
  assert.equal(session.snapshot.marks!.length, 1);
  await session.save();
  assert.equal((await readTextPdf(file.bytes())).marks![0]!.comment, 'AB');
});

test('invalid highlights are rejected and the display copy omits our marks only', async () => {
  const file = memory(await textPdf(true));
  const session = await TextSession.open(file.store, font);
  assert.throws(
    () => session.addMark({ page: 1, kind: 'highlight', quads: [], color: [1, 1, 0] }),
    /Select some text/,
  );
  assert.throws(
    () => session.addMark({ page: 9, kind: 'highlight', quads: [[0, 0, 5, 5]], color: [1, 1, 0] }),
    /no longer exists/,
  );
  session.addMark({ page: 1, kind: 'note', at: [100, 100], color: [1, 1, 0], comment: 'x' });
  await session.save();
  const display = await PDFDocument.load(await renderTextPdf(file.bytes()));
  const left = display
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => display.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))?.toString());
  assert.deepEqual(left, ['/Highlight']);
});

test('removing part of a highlight keeps the rest of the line and the comment', async () => {
  assert.deepEqual(
    subtractQuads(
      [
        [40, 338, 200, 352],
        [40, 318, 140, 332],
      ],
      [[90, 338.5, 130, 351.5]],
    ),
    [
      [40, 338, 90, 352],
      [130, 338, 200, 352],
      [40, 318, 140, 332],
    ],
  );
  // Removing the whole highlighted text leaves nothing, not slivers.
  assert.deepEqual(subtractQuads([[40, 338, 200, 352]], [[39.2, 338, 200.8, 352]]), []);

  const file = memory(await textPdf());
  const session = await TextSession.open(file.store, font);
  const mark = session.addMark({
    page: 1,
    kind: 'highlight',
    quads: [[40, 338, 200, 352]],
    color: [1, 0.85, 0.1],
    comment: 'bleibt',
  });
  assert.equal(session.eraseHighlights(1, [[150, 338, 200, 352]]), 1);
  assert.deepEqual(session.snapshot.marks![0]!.quads, [[40, 338, 150, 352]]);
  assert.equal(session.snapshot.marks![0]!.comment, 'bleibt');
  assert.equal(session.eraseHighlights(1, [[300, 100, 350, 112]]), 0, 'no overlap, no change');
  session.eraseHighlights(1, [[40, 338, 150, 352]]);
  assert.equal(session.snapshot.marks!.length, 0);
  session.undoStroke();
  assert.deepEqual(session.snapshot.marks![0]!.quads, [[40, 338, 150, 352]]);
  session.undoStroke();
  assert.deepEqual(session.snapshot.marks![0]!.quads, [[40, 338, 200, 352]]);
  session.eraseHighlights(1, [[40, 338, 120, 352]]);
  await session.save();
  const saved = (await readTextPdf(file.bytes())).marks!;
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.id, mark.id);
  assert.deepEqual(saved[0]!.quads, [[120, 338, 200, 352]]);
});
