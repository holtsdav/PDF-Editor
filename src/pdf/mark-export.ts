import type { Rect } from './text-engine.ts';
import type { PdfMark } from './mark-engine.ts';

/** The subset of a PDF.js text item used to recover highlighted text. */
export interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Text under highlight quads, from PDF.js text content in PDF user space.
 * Partially covered items contribute the proportional part of their string.
 */
export function textInQuads(items: TextItem[], quads: Rect[]): string {
  const lines: string[] = [];
  for (const quad of quads) {
    const pieces: { x: number; end: number; text: string; size: number }[] = [];
    for (const item of items) {
      const [a = 1, b = 0, c = 0, , x = 0, y = 0] = item.transform;
      // Upright text only; rotated items are skipped rather than guessed.
      if (!item.str || Math.abs(b) > 0.01 * Math.abs(a) || Math.abs(c) > 0.01 * Math.abs(a)) {
        continue;
      }
      const size = item.height || Math.abs(a) || 10;
      const bottom = y - 0.2 * size;
      const top = y + 0.8 * size;
      const vertical = Math.min(top, quad[3]) - Math.max(bottom, quad[1]);
      if (vertical < 0.5 * Math.min(top - bottom, quad[3] - quad[1])) {
        continue;
      }
      const width = item.width || 0;
      const left = Math.max(x, quad[0]);
      const right = Math.min(x + width, quad[2]);
      if (right - left <= 0.25 || width <= 0) {
        continue;
      }
      const characters = [...item.str];
      const start = Math.max(0, Math.round(((left - x) / width) * characters.length));
      const end = Math.min(
        characters.length,
        Math.round(((right - x) / width) * characters.length),
      );
      if (end > start) {
        pieces.push({ x: left, end: right, text: characters.slice(start, end).join(''), size });
      }
    }
    pieces.sort((p, q) => p.x - q.x);
    let line = '';
    let previous: (typeof pieces)[number] | undefined;
    for (const piece of pieces) {
      if (previous && piece.x - previous.end > 0.2 * piece.size && !/\s$/.test(line)) {
        line += ' ';
      }
      line += piece.text;
      previous = piece;
    }
    lines.push(line.replace(/\s+/g, ' ').trim());
  }
  // Join lines, removing hyphenation at line breaks ("Hypo-" + "these").
  return lines
    .filter(Boolean)
    .reduce(
      (all, line) =>
        !all
          ? line
          : /\p{L}-$/u.test(all) && /^\p{Ll}/u.test(line)
            ? all.slice(0, -1) + line
            : `${all} ${line}`,
      '',
    );
}

export interface ExportedMark {
  mark: PdfMark;
  text: string;
}

const COLOUR_NAMES: [string, [number, number, number]][] = [
  ['yellow', [1, 0.85, 0.1]],
  ['green', [0.45, 0.9, 0.45]],
  ['blue', [0.45, 0.75, 1]],
  ['pink', [1, 0.55, 0.75]],
  ['red', [0.9, 0.2, 0.2]],
  ['orange', [1, 0.6, 0.1]],
  ['purple', [0.6, 0.4, 0.85]],
];

/** Nearest common colour name, used as a tag so notes can be filtered by colour. */
export function colourName(color: readonly number[]): string {
  let best = COLOUR_NAMES[0]!;
  let distance = Infinity;
  for (const entry of COLOUR_NAMES) {
    const d = entry[1].reduce((sum, value, i) => sum + (value - color[i]!) ** 2, 0);
    if (d < distance) {
      distance = d;
      best = entry;
    }
  }
  return best[0];
}

export const BLOCK_START = '<!-- pdf-editor:highlights -->';
export const BLOCK_END = '<!-- /pdf-editor:highlights -->';

const inline = (value: string) => value.replace(/\s*\n\s*/g, ' ').trim();

/** Markdown list of highlights and notes, by page, with links that open the PDF at that page. */
export function marksMarkdown(pdfPath: string, entries: ExportedMark[]): string {
  const sorted = [...entries].sort(
    (a, b) =>
      a.mark.page - b.mark.page ||
      b.mark.rect[3] - a.mark.rect[3] ||
      a.mark.rect[0] - b.mark.rect[0],
  );
  const lines = [BLOCK_START, `Highlights and comments from [[${pdfPath}]]`, ''];
  let page = 0;
  for (const { mark, text } of sorted) {
    if (mark.page !== page) {
      if (page) {
        lines.push('');
      }
      page = mark.page;
      lines.push(`## Page ${page}`, '');
    }
    const link = `[[${pdfPath}#page=${page}|p. ${page}]]`;
    const author = mark.foreign && mark.author ? ` — ${inline(mark.author)}` : '';
    if (mark.kind === 'highlight') {
      const quote = inline(text) || '(highlighted area)';
      lines.push(`- ==${quote}== ${link} #highlight/${colourName(mark.color)}${author}`);
      if (mark.comment.trim()) {
        for (const [index, line] of mark.comment.trim().split('\n').entries()) {
          lines.push(`\t- ${index ? '' : '**Comment:** '}${line.trim()}`);
        }
      }
    } else {
      const [first = '', ...rest] = mark.comment.trim().split('\n');
      lines.push(`- **Note:** ${first.trim() || '(empty)'} ${link}${author}`);
      for (const line of rest) {
        lines.push(`\t- ${line.trim()}`);
      }
    }
  }
  if (!sorted.length) {
    lines.push('_No highlights or comments yet._');
  }
  lines.push('', BLOCK_END);
  return lines.join('\n');
}

/**
 * Replace the generated block in an existing note, or append it. Everything the user
 * wrote outside the markers is kept, so exporting again only refreshes the list.
 */
export function upsertBlock(note: string, block: string): string {
  const start = note.indexOf(BLOCK_START);
  const end = note.indexOf(BLOCK_END, start);
  if (start >= 0 && end > start) {
    return note.slice(0, start) + block + note.slice(end + BLOCK_END.length);
  }
  return note.trim() ? `${note.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
}
