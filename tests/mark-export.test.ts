import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  BLOCK_END,
  BLOCK_START,
  colourName,
  markCallout,
  marksMarkdown,
  textInQuads,
  upsertBlock,
} from '../src/pdf/mark-export.ts';
import type { TextItem } from '../src/pdf/mark-export.ts';
import type { PdfMark } from '../src/pdf/mark-engine.ts';

async function items(lines: [string, number][]): Promise<TextItem[]> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [text, y] of lines) {
    page.drawText(text, { x: 40, y, size: 12, font });
  }
  const document = await getDocument({ data: await pdf.save() }).promise;
  const content = await (await document.getPage(1)).getTextContent();
  await document.destroy();
  return content.items.filter((item) => 'str' in item) as TextItem[];
}

test('highlighted text is recovered from PDF.js text content, across lines and hyphens', async () => {
  const text = await items([
    ['Die Nullhypothese wird verworfen, wenn', 340],
    ['der p-Wert klein ist. Konfidenz-', 324],
    ['intervalle helfen beim Verständnis.', 308],
  ]);
  // A quad over the whole first line.
  assert.equal(textInQuads(text, [[40, 337, 360, 351]]), 'Die Nullhypothese wird verworfen, wenn');
  // Part of a line: proportional slice of the item, then trimmed.
  const part = textInQuads(text, [[40, 337, 135, 351]]);
  assert.ok(part.startsWith('Die Nullhypothese'), part);
  // Two lines with a hyphen at the break are joined into one word.
  assert.equal(
    textInQuads(text, [
      [40, 321, 360, 335],
      [40, 305, 360, 319],
    ]),
    'der p-Wert klein ist. Konfidenzintervalle helfen beim Verständnis.',
  );
  assert.equal(textInQuads(text, [[40, 100, 300, 114]]), '');
});

const mark = (over: Partial<PdfMark>): PdfMark => ({
  id: 'pdf-form-studio-mark-x',
  page: 1,
  kind: 'highlight',
  quads: [[40, 300, 100, 312]],
  rect: [40, 300, 100, 312],
  color: [1, 0.85, 0.1],
  opacity: 0.45,
  comment: '',
  modified: 'D:20261125000000Z',
  ...over,
});

test('the exported note lists highlights by page with links back to the PDF', () => {
  const markdown = marksMarkdown('Uni/Statistik.pdf', [
    { mark: mark({ page: 3, rect: [40, 300, 100, 312], color: [0.4, 0.88, 0.5] }), text: 'p-Wert' },
    {
      mark: mark({
        page: 1,
        rect: [40, 500, 100, 512],
        comment: 'Prüfungsrelevant\nSiehe Folie 4',
      }),
      text: 'Nullhypothese',
    },
    {
      mark: mark({
        page: 1,
        kind: 'note',
        quads: [],
        rect: [300, 300, 320, 320],
        comment: 'Frage',
      }),
      text: '',
    },
    {
      mark: mark({ page: 3, rect: [40, 400, 100, 412], foreign: true, author: 'Anna' }),
      text: 'Alpha',
    },
  ]);
  assert.equal(
    markdown,
    [
      BLOCK_START,
      'Highlights and comments from [[Uni/Statistik.pdf]]',
      '',
      '## Page 1',
      '',
      '- ==Nullhypothese== [[Uni/Statistik.pdf#page=1|p. 1]] #highlight/yellow',
      '\t- **Comment:** Prüfungsrelevant',
      '\t- Siehe Folie 4',
      '- **Note:** Frage [[Uni/Statistik.pdf#page=1|p. 1]]',
      '',
      '## Page 3',
      '',
      '- ==Alpha== [[Uni/Statistik.pdf#page=3|p. 3]] #highlight/yellow — Anna',
      '- ==p-Wert== [[Uni/Statistik.pdf#page=3|p. 3]] #highlight/green',
      '',
      BLOCK_END,
    ].join('\n'),
  );
  assert.equal(colourName([0.45, 0.75, 1]), 'blue');
});

test('exporting again refreshes only the generated block and keeps own notes', () => {
  const first = upsertBlock('', `${BLOCK_START}\nold\n${BLOCK_END}`);
  assert.equal(first, `${BLOCK_START}\nold\n${BLOCK_END}\n`);
  const edited = `# Lernzettel\nMeine Gedanken\n\n${first}\nNoch mehr eigene Notizen`;
  assert.equal(
    upsertBlock(edited, `${BLOCK_START}\nnew\n${BLOCK_END}`),
    `# Lernzettel\nMeine Gedanken\n\n${BLOCK_START}\nnew\n${BLOCK_END}\n\nNoch mehr eigene Notizen`,
  );
  // A note without the markers gets the block appended, nothing is replaced.
  assert.equal(
    upsertBlock('Eigene Notiz', `${BLOCK_START}\nx\n${BLOCK_END}`),
    `Eigene Notiz\n\n${BLOCK_START}\nx\n${BLOCK_END}\n`,
  );
});

test('a copied highlight is a PDF++-style callout titled with its page link', () => {
  const mark = {
    page: 175,
    color: [1, 0.9, 0.2] as [number, number, number],
    comment: 'Check the contractors.',
  };
  assert.equal(
    markCallout('Betra/40600_V9_0_DE.pdf', '40600_V9_0_DE', mark, 'Verteilung an\nAuftragnehmer'),
    [
      '> [!PDF|yellow] [[Betra/40600_V9_0_DE.pdf#page=175|40600_V9_0_DE, p.175]]',
      '> Verteilung an',
      '> Auftragnehmer',
      '>',
      '> Check the contractors.',
    ].join('\n'),
  );
});
