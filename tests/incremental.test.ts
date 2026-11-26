import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { loadAppendedUpdate, loadPdfDocumentReusing } from '../src/pdf/pdf-load.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);
const latin1 = new TextDecoder('latin1');
const revisions = (bytes: Uint8Array) => latin1.decode(bytes).split('%%EOF').length - 1;
const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((value, index) => value === bytes[index]);

for (const objectStreams of [false, true]) {
  test(`saves append only changed objects to the original bytes (${objectStreams ? 'cross-reference streams' : 'classic table'})`, async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 20; i++) {
      doc.addPage([400, 400]).drawText(`Page ${i + 1}`, { x: 40, y: 340 });
    }
    // Large enough that small updates are appended rather than compacted away.
    let seed = 1;
    const noise = new Uint8Array(400_000).map(() => (seed = (seed * 48271) % 2147483647) & 0xff);
    await doc.attach(noise, 'data.bin');
    const original = await doc.save({ useObjectStreams: objectStreams });
    let bytes = original.slice();
    const open = () =>
      TextSession.open(
        {
          read: async () => bytes.slice(),
          write: async (value) => {
            bytes = value.slice();
          },
          backup: async () => '',
        },
        font,
      );
    let session = await open();
    const field = session.add(2, [40, 200, 300, 240], 12, false);
    session.setValue(field.name, 'Erste Sitzung');
    const shape = session.addShape({
      page: 5,
      kind: 'arrow',
      start: [40, 40],
      end: [200, 120],
      color: [1, 0, 0],
      width: 2,
    });
    await session.save();
    // The original bytes stay untouched; one update holds the field, shape, page and form objects.
    assert.ok(startsWith(bytes, original));
    const appended = latin1.decode(bytes.subarray(original.length));
    assert.ok((appended.match(/\d+ \d+ obj\b/g) ?? []).length < 25, appended.slice(0, 200));
    assert.equal(revisions(bytes), revisions(original) + 1);
    // Saving again in the same session replaces that update instead of stacking another.
    session.updateShape(shape.id, { end: [220, 140] });
    await session.save();
    assert.ok(startsWith(bytes, original));
    assert.equal(revisions(bytes), revisions(original) + 1);
    const pdf = await getDocument({ data: bytes.slice() }).promise;
    assert.equal(pdf.numPages, 20);
    assert.deepEqual(
      (await (await pdf.getPage(5)).getAnnotations()).map((item) => item.subtype),
      ['Line'],
    );
    assert.equal((await (await pdf.getPage(2)).getAnnotations())[0]!.fieldValue, 'Erste Sitzung');
    await pdf.destroy();

    // A later editing session appends after the first update.
    const first = bytes.slice();
    session = await open();
    session.setValue(field.name, 'Zweite Sitzung');
    await session.save();
    assert.ok(startsWith(bytes, first));
    const reread = await readTextPdf(bytes);
    assert.equal(reread.fields.find((item) => item.name === field.name)!.value, 'Zweite Sitzung');
    assert.deepEqual(reread.shapes![0]!.end, [220, 140]);
  });
}

test('after many appended revisions a save rewrites the file compactly', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  let bytes = await doc.save();
  for (let i = 0; i < 14; i++) {
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
    session.addShape({
      page: 1,
      kind: 'line',
      start: [10, 10 + i * 20],
      end: [300, 10 + i * 20],
      color: [0, 0, 0],
      width: 1,
    });
    await session.save();
    assert.ok(revisions(bytes) <= 12, `revision ${revisions(bytes)}`);
  }
  assert.equal((await readTextPdf(bytes)).shapes!.length, 14);
});

test('an appended update is read back through its own index and rejected when it is broken', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  let state = 7;
  await doc.attach(
    new Uint8Array(200_000).map(() => (state = (state * 48271) % 2147483647) & 0xff),
    'data.bin',
  );
  const seed = await doc.save({ useObjectStreams: false });
  let bytes = seed.slice();
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
  session.addShape({
    page: 1,
    kind: 'line',
    start: [10, 10],
    end: [200, 10],
    color: [0, 0, 0],
    width: 1,
  });
  await session.save();
  const own = (session as unknown as { seed: Uint8Array }).seed;
  await loadPdfDocumentReusing(own);
  const read = await loadAppendedUpdate(own, bytes);
  assert.equal(read?.getPageCount(), 1);
  // An index entry pointing at the wrong object must fail, not be guessed around.
  const text = latin1.decode(bytes);
  const at = text.lastIndexOf(' 00000 n');
  const broken = bytes.slice();
  broken[at - 1] = broken[at - 1] === 0x30 ? 0x31 : 0x30;
  await assert.rejects(loadAppendedUpdate(own, broken), /index|object/i);
});
