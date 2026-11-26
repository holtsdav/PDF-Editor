import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readTextPdf, renderTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { imageSize, storedImage } from '../src/pdf/image-engine.ts';
import { png } from './fixtures/pictures.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

const jpeg = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwClRRRX0B4h/9k=',
    'base64',
  ),
);

test('pasted PNG and JPEG pictures are saved as stamps other readers show', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  let bytes = await doc.save();
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
  const picture = session.addImage({ page: 1, box: [40, 200, 200, 360], bytes: png() });
  session.addImage({ page: 1, box: [220, 40, 380, 120], bytes: jpeg });
  assert.throws(
    () => session.addImage({ page: 1, box: [300, 300, 500, 380], bytes: png() }),
    /inside its PDF page/,
  );
  assert.throws(
    () => session.addImage({ page: 1, box: [0, 0, 10, 10], bytes: new Uint8Array([1, 2, 3]) }),
    /PNG and JPEG/,
  );
  await session.save();
  const saved = (await readTextPdf(bytes)).images!;
  assert.equal(saved.length, 2);
  assert.deepEqual(storedImage(saved[0]!.source)!.bytes, png(), 'original PNG kept');
  assert.deepEqual(storedImage(saved[1]!.source)!.bytes, jpeg, 'JPEG read from its stream');
  assert.deepEqual(
    [imageSize(png(30, 7)), imageSize(jpeg)],
    [
      [30, 7],
      [4, 2],
    ],
  );
  // PDF.js sees standard stamps with appearances.
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const annotations = await (await pdf.getPage(1)).getAnnotations();
  assert.deepEqual(
    annotations.map((item) => [item.subtype, item.hasAppearance]),
    [
      ['Stamp', true],
      ['Stamp', true],
    ],
  );
  await pdf.destroy();
  await writeFile(new URL('../tmp/images.pdf', import.meta.url), bytes);

  // Move and turn, lock, then unlock and delete; the image data is not duplicated.
  const size = bytes.length;
  session.updateImage(picture.id, { box: [60, 180, 220, 340], rotation: 90 });
  session.updateImage(picture.id, { locked: true });
  assert.throws(() => session.deleteImage(picture.id), /locked/);
  await session.save();
  assert.ok(bytes.length < size + 400, `${bytes.length} vs ${size}`);
  const moved = (await readTextPdf(bytes)).images![0]!;
  assert.deepEqual([moved.box, moved.rotation, moved.locked], [[60, 180, 220, 340], 90, true]);
  session.updateImage(picture.id, { locked: false });
  session.deleteImage(picture.id);
  session.undoStroke();
  assert.equal(session.snapshot.images!.length, 2);
  session.redoStroke();
  await session.save();
  assert.equal((await readTextPdf(bytes)).images!.length, 1);
  const display = await PDFDocument.load(await renderTextPdf(bytes));
  assert.equal(display.getPages()[0]!.node.Annots()?.size() ?? 0, 0);
});
