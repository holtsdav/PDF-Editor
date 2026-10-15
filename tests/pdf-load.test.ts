import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdfDocument } from '../src/pdf/pdf-load.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { previewForms, ownedName } from './fixtures/preview-forms.ts';

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);
const standardFontDataUrl = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
  .pathname;
const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

/** Append an anonymous update without shifting any indexed object bytes. */
function append(bytes: Uint8Array, text: string): Uint8Array {
  const suffix = encoder.encode(text);
  const combined = new Uint8Array(bytes.length + suffix.length);
  combined.set(bytes);
  combined.set(suffix, bytes.length);
  return combined;
}
function xrefOffset(bytes: Uint8Array): number {
  return Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(decoder.decode(bytes))![1]);
}
function memory(seed: Uint8Array) {
  let bytes = seed.slice();
  let writes = 0;
  const originals: Uint8Array[] = [];
  return {
    store: {
      read: async () => bytes.slice(),
      write: async (value: Uint8Array) => {
        bytes = value.slice();
        writes++;
      },
      backup: async (value: Uint8Array) => {
        originals.push(value.slice());
        return 'original.pdf';
      },
    },
    bytes: () => bytes,
    writes: () => writes,
    originals,
  };
}

/** Legal empty classic sections with earlier table or stream indexes, including a hybrid update. */
async function emptyIndex(
  kind: 'incremental' | 'compressed' | 'hybrid' | 'mixed',
  subsection = '0 0',
) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  page.drawText('Anonymous indexed content', { x: 30, y: 740 });
  const field = pdf.getForm().createTextField('Index answer');
  field.setText('Original answer');
  field.addToPage(page, { x: 30, y: 600, width: 180, height: 30 });
  let bytes = await pdf.save({ useObjectStreams: kind === 'compressed' || kind === 'mixed' });
  const previous = xrefOffset(bytes);
  const originalSize = Number(/\/Size\s+(\d+)/.exec(decoder.decode(bytes.subarray(previous)))![1]);
  let pointers = kind === 'compressed' ? `/XRefStm ${previous}` : `/Prev ${previous}`;
  if (kind === 'hybrid') {
    // A real cross-reference stream alongside the original classic table.
    const number = pdf.context.largestObjectNumber + 1;
    const offset = bytes.length + 1;
    const entry = new Uint8Array(7);
    entry[0] = 1;
    new DataView(entry.buffer).setUint32(1, offset);
    bytes = append(
      bytes,
      `\n${number} 0 obj\n<< /Type /XRef /Size ${number + 1} /W [1 4 2] /Index [${number} 1] /Length 7 >>\nstream\n`,
    );
    const combined = new Uint8Array(bytes.length + entry.length);
    combined.set(bytes);
    combined.set(entry, bytes.length);
    bytes = append(combined, '\nendstream\nendobj\n');
    pointers += ` /XRefStm ${offset}`;
  }
  const size = originalSize + (kind === 'hybrid' ? 1 : 0);
  return append(
    bytes,
    `\nxref\n${subsection}\ntrailer\n<< /Size ${size} /Root ${pdf.context.trailerInfo.Root!.toString()} ${pointers} >>\nstartxref\n${bytes.length + 1}\n%%EOF\n`,
  );
}

test('empty classic subsections load earlier incremental and hybrid indexes without writes, then preserve edits on save/reopen', async () => {
  for (const kind of ['incremental', 'compressed', 'hybrid'] as const) {
    for (const subsection of ['0 0', '0 0\n5 0\n0 0']) {
      const seed = await emptyIndex(kind, subsection);
      const file = memory(seed);
      const task = getDocument({ data: seed.slice(), standardFontDataUrl });
      try {
        const independent = await task.promise;
        assert.equal(independent.numPages, 2);
        assert(
          (await (await independent.getPage(1)).getAnnotations()).some(
            (a) => a.fieldName === 'Index answer' && a.fieldValue === 'Original answer',
          ),
        );
      } finally {
        await task.destroy();
      }
      const session = await TextSession.open(file.store, font);
      assert.equal(session.snapshot.pages.length, 2);
      assert.equal(session.snapshot.fields[0]!.value, 'Original answer');
      await session.renderBytes();
      await session.saveWhenIdle();
      assert.equal(file.writes(), 0);
      assert.deepEqual(file.bytes(), seed);
      assert.deepEqual(file.originals, []);
      session.setValue('Index answer', 'Changed answer');
      await session.save();
      const box = session.add(2, [30, 500, 220, 535], 14, true);
      session.setValue(box.name, 'Added answer');
      session.addStroke(
        2,
        'scribble',
        [
          [30, 450],
          [100, 460],
        ],
        2,
        [0, 0, 1],
      );
      await session.save();
      const reopened = await TextSession.open(file.store, font);
      assert.equal(
        reopened.snapshot.fields.find((f) => f.name === 'Index answer')!.value,
        'Changed answer',
      );
      assert.equal(
        reopened.snapshot.fields.find((f) => f.name === box.name)!.value,
        'Added answer',
      );
      assert.equal(reopened.snapshot.strokes.length, 1);
      assert.deepEqual(file.originals[0], seed);
      const saved = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
      try {
        const independent = await saved.promise;
        assert.equal(independent.numPages, 2);
        const first = await independent.getPage(1);
        const second = await independent.getPage(2);
        assert(
          (await first.getAnnotations()).some(
            (a) =>
              a.fieldName === 'Index answer' &&
              a.fieldValue === 'Changed answer' &&
              a.hasAppearance,
          ),
        );
        assert(
          (await first.getTextContent()).items.some(
            (item) => 'str' in item && item.str === 'Anonymous indexed content',
          ),
        );
        const annotations = await second.getAnnotations();
        assert(
          annotations.some(
            (a) => a.fieldName === box.name && a.fieldValue === 'Added answer' && a.hasAppearance,
          ),
        );
        assert(annotations.some((a) => a.subtype === 'Ink' && a.hasAppearance));
      } finally {
        await saved.destroy();
      }
    }
  }
});

test('an empty classic update over a previous stream index retains mixed-index loading', async () => {
  const seed = await emptyIndex('mixed');
  const file = memory(seed);
  const session = await TextSession.open(file.store, font);
  assert.equal(session.snapshot.pages.length, 2);
  assert.equal(session.snapshot.fields[0]!.value, 'Original answer');
  session.setValue('Index answer', 'Mixed-index edit');
  await session.save();
  const task = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 2);
    assert(
      (await (await pdf.getPage(1)).getAnnotations()).some(
        (a) => a.fieldName === 'Index answer' && a.fieldValue === 'Mixed-index edit',
      ),
    );
  } finally {
    await task.destroy();
  }
});

test('empty subsections in a standalone table keep active Preview objects authoritative', async () => {
  const sample = await previewForms();
  const offset = xrefOffset(sample.bytes);
  const section = decoder.decode(sample.bytes.subarray(offset));
  const suffix = encoder.encode(
    section.replace(/^xref\n/, 'xref\n0 0\n').replace('\ntrailer', '\n5 0\ntrailer'),
  );
  const bytes = new Uint8Array(offset + suffix.length);
  bytes.set(sample.bytes.subarray(0, offset));
  bytes.set(suffix, offset);
  const pdf = await loadPdfDocument(bytes);
  assert.equal(pdf.getPageCount(), 2);
  assert.equal(pdf.getForm().getTextField(ownedName).getText(), 'Existing box');
  const file = memory(bytes);
  const session = await TextSession.open(file.store, font);
  assert.equal(session.snapshot.fields.length, 2);
  assert.equal(file.writes(), 0);
  session.setValue(ownedName, 'Updated active box');
  await session.save();
  assert.equal(
    (await loadPdfDocument(file.bytes())).getForm().getTextField(ownedName).getText(),
    'Updated active box',
  );
});

test('allowing empty subsections does not accept malformed counts, truncated entries or unindexed standalone catalogs', async () => {
  for (const subsection of [
    '0 -1',
    '0 1.5',
    '0 invalid',
    '0 9007199254740992',
    '999999 2',
    '0 1000001',
    '0 10000',
    '0 1\ntrailer',
    '0 0\n0 1\n0000000000 65536 f',
  ]) {
    const file = memory(await emptyIndex('incremental', subsection));
    await assert.rejects(TextSession.open(file.store, font), /PDF object index/);
    assert.equal(file.writes(), 0);
    assert.deepEqual(file.originals, []);
  }
  const seed = await emptyIndex('incremental');
  const offset = xrefOffset(seed);
  const section = decoder.decode(seed.subarray(offset));
  const bytes = append(seed.subarray(0, offset), section.replace(/\/Prev \d+/, ''));
  const file = memory(bytes);
  await assert.rejects(TextSession.open(file.store, font), /active PDF catalog/);
  assert.equal(file.writes(), 0);
  assert.deepEqual(file.originals, []);
  const hybrid = await emptyIndex('hybrid');
  const hybridOffset = xrefOffset(hybrid);
  const hybridSection = decoder.decode(hybrid.subarray(hybridOffset));
  for (const size of ['0', '-1', '1.5', '1000001', 'null']) {
    const invalid = memory(
      append(
        hybrid.subarray(0, hybridOffset),
        hybridSection.replace(/\/Size \d+/, '/Size ' + size),
      ),
    );
    await assert.rejects(TextSession.open(invalid.store, font), /object index size/);
    assert.equal(invalid.writes(), 0);
    assert.deepEqual(invalid.originals, []);
  }
});

test('classic index chains reject invalid previous pointers and preserve newest free entries', async () => {
  const seed = await emptyIndex('incremental');
  const offset = xrefOffset(seed);
  const section = decoder.decode(seed.subarray(offset));
  for (const value of [
    '-1',
    '0',
    '1.5',
    'null',
    '(invalid)',
    String(offset),
    String(offset + 1),
    '9007199254740992',
  ]) {
    const file = memory(
      append(seed.subarray(0, offset), section.replace(/\/Prev \d+/, '/Prev ' + value)),
    );
    await assert.rejects(TextSession.open(file.store, font), /previous cross-reference offset/);
    assert.equal(file.writes(), 0);
    assert.deepEqual(file.originals, []);
  }
  const pdf = await loadPdfDocument(seed);
  const root = pdf.context.trailerInfo.Root!;
  const number = Number(root.toString().split(' ')[0]);
  const freed = append(
    seed,
    `\nxref\n${number} 1\n0000000000 00001 f \ntrailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${root.toString()} /Prev ${offset} >>\nstartxref\n${seed.length + 1}\n%%EOF\n`,
  );
  const file = memory(freed);
  await assert.rejects(TextSession.open(file.store, font), /active PDF catalog/);
  assert.equal(file.writes(), 0);
  assert.deepEqual(file.originals, []);
});

test('a first-page classic table can index later objects and follow a forward Prev link as in linearized layouts', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  page.drawText('Forward-index content');
  const field = pdf.getForm().createTextField('Forward answer');
  field.setText('Original');
  field.addToPage(page, { x: 30, y: 600, width: 180, height: 30 });
  const seed = await pdf.save({ useObjectStreams: false });
  const offset = xrefOffset(seed);
  const source = decoder.decode(seed);
  const headerEnd = source.indexOf('1 0 obj');
  const root = pdf.context.trailerInfo.Root!.toString();
  assert(headerEnd > 0);
  const rootNumber = Number(root.split(' ')[0]);
  const rootOffset = source.indexOf(root.replace(' R', ' obj'));
  const size = pdf.context.largestObjectNumber + 1;
  const early = (objectOffset: number, previous: number) =>
    `xref\n${rootNumber} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root ${root} /Prev ${String(previous).padStart(10, '0')} >>\n`;
  const length = encoder.encode(early(0, 0)).length;
  const prefix = encoder.encode(early(rootOffset + length, offset + length));
  const table = source
    .slice(offset)
    .replace(
      /^(\d{10}) (\d{5}) n /gm,
      (_, position: string, generation: string) =>
        `${String(Number(position) + length).padStart(10, '0')} ${generation} n `,
    )
    .replace(/startxref\s+\d+/, 'startxref\n' + headerEnd);
  const suffix = encoder.encode(table);
  const bytes = new Uint8Array(offset + length + suffix.length);
  bytes.set(seed.subarray(0, headerEnd));
  bytes.set(prefix, headerEnd);
  bytes.set(seed.subarray(headerEnd, offset), headerEnd + length);
  bytes.set(suffix, offset + length);
  const file = memory(bytes);
  const session = await TextSession.open(file.store, font);
  assert.equal(session.snapshot.pages.length, 2);
  assert.equal(session.snapshot.fields[0]!.value, 'Original');
  assert.equal(file.writes(), 0);
  const original = getDocument({ data: bytes.slice(), standardFontDataUrl });
  try {
    assert.equal((await original.promise).numPages, 2);
  } finally {
    await original.destroy();
  }
  session.setValue('Forward answer', 'Saved forward-index answer');
  await session.save();
  const saved = getDocument({ data: file.bytes().slice(), standardFontDataUrl });
  try {
    const doc = await saved.promise;
    assert.equal(doc.numPages, 2);
    assert(
      (await (await doc.getPage(1)).getAnnotations()).some(
        (a) =>
          a.fieldName === 'Forward answer' &&
          a.fieldValue === 'Saved forward-index answer' &&
          a.hasAppearance,
      ),
    );
  } finally {
    await saved.destroy();
  }
  const main = decoder.decode(bytes.subarray(offset + length));
  const cyclic = append(
    bytes.subarray(0, offset + length),
    main.replace('trailer\n<<', 'trailer\n<< /Prev ' + headerEnd),
  );
  const invalid = memory(cyclic);
  await assert.rejects(TextSession.open(invalid.store, font), /previous cross-reference offset/);
  assert.equal(invalid.writes(), 0);
  assert.deepEqual(invalid.originals, []);
});
