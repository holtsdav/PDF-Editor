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
  const marks = (await readTextPdf(file.bytes())).marks!.filter((mark) => !mark.foreign);
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
  // The foreign highlight is listed too, but marked as made elsewhere.
  const saved = (await readTextPdf(file.bytes())).marks!.filter((mark) => !mark.foreign);
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

test('invalid highlights are rejected and the display copy omits editable marks', async () => {
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
  // Our note and the foreign highlight are both painted live by the editor.
  assert.deepEqual(left, []);
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

async function acrobatPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const context = pdf.context;
  const ap = context.register(
    context.flateStream('1 1 0 rg 0 0 160 14 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 160, 14],
    }),
  );
  const highlight = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [40, 338, 200, 352],
      QuadPoints: [40, 352, 200, 352, 40, 338, 200, 338],
      C: [1, 1, 0],
      T: PDFHexString.fromText('Anna (Acrobat)'),
      Contents: PDFHexString.fromText('Alt'),
      RC: PDFHexString.fromText('<body><p>Alt</p></body>'),
      AP: { N: ap },
    }),
  );
  const reply = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [210, 338, 230, 358],
      IRT: highlight,
      Contents: PDFHexString.fromText('Antwort'),
    }),
  );
  const note = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [300, 300, 324, 324],
      Name: 'Comment',
      C: [1, 0.8, 0],
      Contents: PDFHexString.fromText('Okular-Notiz'),
      T: PDFHexString.fromText('Ben'),
    }),
  );
  const hidden = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      F: 2,
      Rect: [40, 100, 80, 112],
      QuadPoints: [40, 112, 80, 112, 40, 100, 80, 100],
    }),
  );
  for (const ref of [highlight, reply, note, hidden]) {
    page.node.addAnnot(ref);
  }
  return pdf.save();
}

test('highlights and notes from other apps can be edited, re-coloured, trimmed and deleted', async () => {
  const file = memory(await acrobatPdf());
  const session = await TextSession.open(file.store, font);
  const marks = session.snapshot.marks!;
  // Replies and hidden annotations are not offered for editing.
  assert.deepEqual(
    marks.map((mark) => [mark.kind, mark.comment, mark.author, mark.foreign]),
    [
      ['highlight', 'Alt', 'Anna (Acrobat)', true],
      ['note', 'Okular-Notiz', 'Ben', true],
    ],
  );
  const [highlight, note] = marks;
  session.updateMark(highlight!.id, { comment: 'Neu', color: [0.45, 0.9, 0.45] });
  session.eraseHighlights(1, [[150, 338, 200, 352]]);
  session.updateMark(note!.id, { comment: 'Erledigt' });
  await session.save();

  const pdf = await PDFDocument.load(file.bytes());
  const dicts = pdf
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => pdf.context.lookup(ref, PDFDict));
  const edited = dicts.find(
    (dict) =>
      dict.get(PDFName.of('Subtype'))?.toString() === '/Highlight' && !dict.has(PDFName.of('F')),
  )!;
  // Edited in place: author kept, rich text dropped so readers show the new comment.
  assert.equal(edited.lookup(PDFName.of('T'), PDFHexString).decodeText(), 'Anna (Acrobat)');
  assert.equal(edited.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), 'Neu');
  assert.equal(edited.has(PDFName.of('RC')), false);
  const reread = (await readTextPdf(file.bytes())).marks!;
  assert.deepEqual(reread[0]!.quads, [[40, 338, 150, 352]]);
  assert.deepEqual(reread[0]!.color, [0.45, 0.9, 0.45]);
  assert.equal(reread[1]!.comment, 'Erledigt');

  // PDF.js shows the edited comment.
  const document = await getDocument({ data: file.bytes().slice() }).promise;
  const shown = await (await document.getPage(1)).getAnnotations();
  assert.ok(shown.some((item) => item.subtype === 'Highlight' && item.contentsObj?.str === 'Neu'));
  await document.destroy();

  // Deleting removes the highlight together with its reply; the hidden one stays.
  session.deleteMark(highlight!.id);
  await session.save();
  const after = await PDFDocument.load(file.bytes());
  const left = after
    .getPages()[0]!
    .node.Annots()!
    .asArray()
    .map((ref) => after.context.lookup(ref, PDFDict))
    .map(
      (dict) => dict.lookupMaybe(PDFName.of('Contents'), PDFHexString)?.decodeText() ?? '(hidden)',
    );
  assert.deepEqual(left, ['Erledigt', '(hidden)']);
});

test('underline and strikethrough are standard annotations that toggle off again', async () => {
  const file = memory(await textPdf());
  const session = await TextSession.open(file.store, font);
  const line: Rect = [40, 338, 200, 352];
  session.addMark({ page: 1, kind: 'underline', quads: [line], color: [0.85, 0.15, 0.15] });
  session.addMark({ page: 1, kind: 'strikeout', quads: [line], color: [0.1, 0.1, 0.1] });
  // Pressing underline again on the left half removes just that part.
  assert.equal(session.highlightsAt(1, [[40, 338, 120, 352]], 'highlight').length, 0);
  session.eraseHighlights(1, [[40, 338, 120, 352]], 'underline');
  await session.save();
  const saved = (await readTextPdf(file.bytes())).marks!;
  assert.deepEqual(
    saved.map((mark) => [mark.kind, mark.quads[0]![0], mark.opacity]),
    [
      ['underline', 120, 1],
      ['strikeout', 40, 1],
    ],
  );
  const document = await getDocument({ data: file.bytes().slice() }).promise;
  const annotations = await (await document.getPage(1)).getAnnotations();
  assert.deepEqual(
    annotations
      .filter((item) => item.subtype !== 'Popup')
      .map((item) => [item.subtype, item.hasAppearance])
      .sort(),
    [
      ['StrikeOut', true],
      ['Underline', true],
    ],
  );
  await document.destroy();
});
