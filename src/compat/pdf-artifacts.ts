import type { PageViewport } from 'pdfjs-dist';
import type { Rect } from '../pdf/text-engine';
import type { AnswerLine } from '../pdf/answer-lines';

export interface OperatorList { fnArray: number[]; argsArray: unknown[] }

type Operations = typeof import('pdfjs-dist')['OPS'];
type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const numbers = (value: unknown, length: number): number[] | undefined => {
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView))) return;
  const array = Array.from(value as ArrayLike<number>);
  return array.length === length && array.every(Number.isFinite) ? array : undefined;
};
const multiply = (a: Matrix, b: number[]): Matrix => [a[0] * b[0]! + a[2] * b[1]!, a[1] * b[0]! + a[3] * b[1]!,
  a[0] * b[2]! + a[2] * b[3]!, a[1] * b[2]! + a[3] * b[3]!, a[0] * b[4]! + a[2] * b[5]! + a[4], a[1] * b[4]! + a[3] * b[5]! + a[5]];

/** PDF.js operator layouts vary. Unrecognized layouts retain answer candidates. */
export function decorativeFooterRules(list: OperatorList, ops: Operations, viewport: PageViewport): Rect[] {
  const marks: boolean[] = [], saved: (Matrix | undefined)[] = [], pieces: Rect[] = [];
  let matrix: Matrix | undefined = identity();
  const painted = new Set([ops.stroke, ops.closeStroke, ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i]!, raw: unknown = list.argsArray[i];
    const args: unknown[] | undefined = Array.isArray(raw) ? raw : undefined;
    if (fn === ops.beginMarkedContent || fn === ops.beginMarkedContentProps) {
      const tag = args?.[0]; marks.push(tag === 'Artifact' || (!!tag && typeof tag === 'object' && 'name' in tag && tag.name === 'Artifact'));
    } else if (fn === ops.endMarkedContent) marks.pop();
    else if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
      saved.push(matrix && [...matrix]);
      if (fn === ops.paintFormXObjectBegin && args?.[0]) { const transform = numbers(args[0], 6); matrix = matrix && transform ? multiply(matrix, transform) : undefined; }
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) matrix = saved.pop();
    else if (fn === ops.transform) { const transform = numbers(args, 6); matrix = matrix && transform ? multiply(matrix, transform) : undefined; }
    else if (fn === ops.constructPath && matrix && marks.includes(true) && typeof args?.[0] === 'number' && painted.has(args[0])) {
      // Newer PDF.js combines painting and path construction and exposes its
      // bounds. Legacy/unknown argument layouts are deliberately ignored.
      const bounds = numbers(args[2], 4); if (!bounds) continue;
      const corners: [number, number][] = [];
      for (const [x, y] of [[bounds[0]!, bounds[1]!], [bounds[2]!, bounds[1]!], [bounds[2]!, bounds[3]!], [bounds[0]!, bounds[3]!]]) {
        const point = numbers(viewport.convertToViewportPoint(matrix[0] * x! + matrix[2] * y! + matrix[4], matrix[1] * x! + matrix[3] * y! + matrix[5]), 2);
        if (!point) break;
        corners.push([point[0]!, point[1]!]);
      }
      // Unknown or non-finite conversions must retain legitimate answer lines.
      if (corners.length !== 4) continue;
      const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
      const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (rect[1] >= viewport.height * 0.88 && rect[3] - rect[1] <= 2 && rect[2] > rect[0]) pieces.push(rect);
    }
  }
  const merged: Rect[] = [];
  for (const piece of pieces.sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const previous = merged.find(rect => Math.abs(rect[1] - piece[1]) <= 0.75 && Math.abs(rect[3] - piece[3]) <= 0.75 && piece[0] <= rect[2] + 1 && piece[2] >= rect[0] - 1);
    if (previous) { previous[0] = Math.min(previous[0], piece[0]); previous[2] = Math.max(previous[2], piece[2]); previous[1] = Math.min(previous[1], piece[1]); previous[3] = Math.max(previous[3], piece[3]); }
    else merged.push([...piece]);
  }
  return merged.filter(rect => rect[2] - rect[0] >= viewport.width * 0.6);
}

export function excludeDecorativeFooters(lines: AnswerLine[], rules: Rect[]): AnswerLine[] {
  return lines.filter(({ rect }) => !rules.some(rule => Math.abs(rect[3] - (rule[1] + rule[3]) / 2) <= 1.5
    && Math.abs(rect[0] - rule[0]) <= 2 && Math.abs(rect[2] - rule[2]) <= 2));
}
