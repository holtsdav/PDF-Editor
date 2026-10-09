import type { Rect } from '../pdf/text-engine';

/** PDF.js conversion arrays are loosely typed; reject unusable layout values. */
export function pdfPoint(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('PDF.js returned an invalid point.');
  const [x, y]: unknown[] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('PDF.js returned an invalid point.');
  return [x, y];
}

export function pdfRectangle(value: unknown): Rect {
  if (!Array.isArray(value) || value.length !== 4) throw new Error('PDF.js returned an invalid rectangle.');
  const [x1, y1, x2, y2]: unknown[] = value;
  if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number'
    || ![x1, y1, x2, y2].every(Number.isFinite)) throw new Error('PDF.js returned an invalid rectangle.');
  return [x1, y1, x2, y2];
}
