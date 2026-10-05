import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { Rect } from './text-engine.ts';

export const INK_PREFIX = 'pdf-form-studio-ink-';
export type Point = [number, number];
export type InkKind = 'marker' | 'scribble';
export interface InkStroke {
  id: string; page: number; kind: InkKind; points: Point[]; width: number;
  color: [number, number, number]; opacity: number; rect: Rect; readOnly: boolean;
  annotationId?: string;
}

function text(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}
function numbers(dict: PDFDict, key: string): number[] | undefined {
  const array = dict.lookup(PDFName.of(key));
  if (!(array instanceof PDFArray)) return;
  const result = array.asArray().map((_, index) => array.lookup(index));
  return result.every(value => value instanceof PDFNumber) ? result.map(value => (value as PDFNumber).asNumber()) : undefined;
}
function number(dict: PDFDict, key: string, fallback: number): number {
  const value = dict.lookup(PDFName.of(key)); return value instanceof PDFNumber ? value.asNumber() : fallback;
}

export function strokeBounds(points: Point[], width: number, bounds: Rect): Rect {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const [x, y] of points) { left = Math.min(left, x); bottom = Math.min(bottom, y); right = Math.max(right, x); top = Math.max(top, y); }
  // PDF.js validates BS/W against half the annotation rectangle's dimensions.
  // A full-width margin keeps thin lines and tap dots editable in that viewer.
  const pad = width + 0.5;
  return [Math.max(bounds[0], left - pad), Math.max(bounds[1], bottom - pad), Math.min(bounds[2], right + pad), Math.min(bounds[3], top + pad)];
}

export function validateStroke(stroke: InkStroke, bounds: Rect): void {
  if (!stroke.id.startsWith(INK_PREFIX) || !['marker', 'scribble'].includes(stroke.kind) || !Number.isFinite(stroke.width)
    || stroke.width <= 0 || stroke.width > 100 || !Number.isFinite(stroke.opacity) || stroke.opacity <= 0 || stroke.opacity > 1
    || stroke.color.length !== 3 || stroke.color.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || !stroke.points.length || stroke.points.length > 12000
    || stroke.rect.length !== 4 || stroke.rect.some(value => !Number.isFinite(value)) || stroke.rect[2] <= stroke.rect[0] || stroke.rect[3] <= stroke.rect[1]
    || stroke.rect[0] < bounds[0] || stroke.rect[1] < bounds[1] || stroke.rect[2] > bounds[2] || stroke.rect[3] > bounds[3]
    || stroke.points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < bounds[0] || y < bounds[1] || x > bounds[2] || y > bounds[3])) {
    throw new Error('Invalid drawing geometry. Keep the stroke inside its PDF page.');
  }
}

/** Only our tagged standard Ink annotations are edited; unrelated annotations are untouched. */
export function readInk(pdf: PDFDocument): InkStroke[] {
  const strokes: InkStroke[] = []; const ids = new Set<string>();
  pdf.getPages().forEach((page, index) => {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const dict = pdf.context.lookup(ref);
      if (!(dict instanceof PDFDict) || dict.get(PDFName.of('Subtype'))?.toString() !== '/Ink') continue;
      const id = text(dict, 'NM'); const tag = dict.get(PDFName.of('PFSKind'))?.toString();
      if (!id?.startsWith(INK_PREFIX) || (tag !== '/Marker' && tag !== '/Scribble')) continue;
      if (ids.has(id)) throw new Error('The PDF contains duplicate drawing IDs.');
      ids.add(id);
      const list = dict.lookup(PDFName.of('InkList'));
      if (!(list instanceof PDFArray) || list.size() !== 1) throw new Error('Unsupported drawing paths in this PDF.');
      const path = list.lookup(0);
      if (!(path instanceof PDFArray) || path.size() < 2 || path.size() % 2) throw new Error('Invalid drawing path in this PDF.');
      const points: Point[] = [];
      for (let i = 0; i < path.size(); i += 2) points.push([path.lookup(i, PDFNumber).asNumber(), path.lookup(i + 1, PDFNumber).asNumber()]);
      const bs = dict.lookup(PDFName.of('BS')); const box = page.getCropBox();
      const bounds: Rect = [box.x, box.y, box.x + box.width, box.y + box.height];
      const width = bs instanceof PDFDict ? number(bs, 'W', 2) : 2;
      const color = numbers(dict, 'C') ?? [0, 0, 0]; const rect = numbers(dict, 'Rect');
      if (color.length !== 3 || rect?.length !== 4) throw new Error('Invalid drawing appearance in this PDF.');
      const stroke: InkStroke = { id, page: index + 1, kind: tag === '/Marker' ? 'marker' : 'scribble', points, width,
        opacity: number(dict, 'CA', 1), color: color as InkStroke['color'], rect: rect as Rect,
        readOnly: !!(number(dict, 'F', 0) & (64 | 128 | 512)),
        annotationId: ref instanceof PDFRef ? `${ref.objectNumber}R${ref.generationNumber || ''}` : undefined };
      validateStroke(stroke, bounds); strokes.push(stroke);
    }
  });
  return strokes;
}

const decimal = (value: number) => String(Math.round(value * 100000) / 100000);
function appearance(stroke: InkStroke): string {
  const [x0, y0] = stroke.rect; const p = stroke.points.map(([x, y]) => [x - x0, y - y0] as Point);
  const [first] = p; const [x, y] = first!;
  const color = stroke.color.map(decimal).join(' ');
  const commands = ['q', '/GS0 gs', `${decimal(stroke.width)} w 1 J 1 j`, `${color} RG`, `${color} rg`];
  if (p.every(point => Math.hypot(point[0] - x, point[1] - y) < 0.001)) {
    // Explicit circle fill makes a tap dot visible even in viewers that omit zero-length strokes.
    const r = stroke.width / 2, k = r * 0.5522847498;
    commands.push(`${decimal(x + r)} ${decimal(y)} m`);
    for (const segment of [
      [x + r, y + k, x + k, y + r, x, y + r], [x - k, y + r, x - r, y + k, x - r, y],
      [x - r, y - k, x - k, y - r, x, y - r], [x + k, y - r, x + r, y - k, x + r, y]
    ]) commands.push(`${segment.map(decimal).join(' ')} c`);
    commands.push('h f');
  } else {
    commands.push(`${decimal(x)} ${decimal(y)} m`);
    for (const [a, b] of p.slice(1)) commands.push(`${decimal(a)} ${decimal(b)} l`);
    commands.push('S');
  }
  commands.push('Q'); return commands.join('\n');
}

export function writeInk(pdf: PDFDocument, added: Map<string, InkStroke>, deleted: Set<string>): void {
  const existing = new Map(readInk(pdf).map(stroke => [stroke.id, stroke]));
  for (const id of deleted) {
    if (!id.startsWith(INK_PREFIX) || existing.get(id)?.readOnly) throw new Error('This drawing cannot be removed.');
    for (const page of pdf.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;
      for (let i = annotations.size() - 1; i >= 0; i--) {
        const dict = annotations.lookup(i);
        if (dict instanceof PDFDict && text(dict, 'NM') === id && existing.has(id)) annotations.remove(i);
      }
    }
  }
  for (const stroke of added.values()) {
    if (deleted.has(stroke.id)) continue;
    if (existing.has(stroke.id)) throw new Error('Duplicate drawing ID.');
    const page = pdf.getPages()[stroke.page - 1];
    if (!page) throw new Error('The drawing page no longer exists.');
    const box = page.getCropBox(); validateStroke(stroke, [box.x, box.y, box.x + box.width, box.y + box.height]);
    const [left, bottom, right, top] = stroke.rect;
    const context = pdf.context;
    const resources = context.obj({ ExtGState: { GS0: { Type: 'ExtGState', CA: stroke.opacity, ca: stroke.opacity,
      BM: stroke.kind === 'marker' ? 'Multiply' : 'Normal' } } });
    const ap = context.register(context.flateStream(appearance(stroke), { Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [0, 0, right - left, top - bottom], Resources: resources }));
    const points = stroke.points.length === 1 ? [...stroke.points, ...stroke.points] : stroke.points;
    const dict = context.obj({ Type: 'Annot', Subtype: 'Ink', NM: PDFHexString.fromText(stroke.id), P: page.ref, F: 4,
      Rect: stroke.rect, InkList: [points.flat()], BS: { Type: 'Border', W: stroke.width, S: 'S' }, C: stroke.color, CA: stroke.opacity,
      Contents: PDFString.of(stroke.kind === 'marker' ? 'Marker' : 'Scribble'),
      PFSKind: stroke.kind === 'marker' ? 'Marker' : 'Scribble', AP: { N: ap } });
    if (stroke.kind === 'marker') dict.set(PDFName.of('IT'), PDFName.of('InkHighlight'));
    page.node.addAnnot(context.register(dict));
  }
}

export function verifyInk(pdf: PDFDocument, added: Map<string, InkStroke>, deleted: Set<string>): void {
  const saved = new Map(readInk(pdf).map(stroke => [stroke.id, stroke]));
  for (const id of deleted) if (saved.has(id)) throw new Error('PDF drawing deletion verification failed.');
  for (const stroke of added.values()) {
    if (deleted.has(stroke.id)) continue;
    const output = saved.get(stroke.id);
    const points = stroke.points.length === 1 ? [...stroke.points, ...stroke.points] : stroke.points;
    if (!output || output.page !== stroke.page || output.kind !== stroke.kind || output.width !== stroke.width || output.opacity !== stroke.opacity
      || JSON.stringify(output.points) !== JSON.stringify(points) || JSON.stringify(output.color) !== JSON.stringify(stroke.color)
      || output.rect.some((value, i) => Math.abs(value - stroke.rect[i]!) > 0.001)) throw new Error('PDF drawing value verification failed.');
    const page = pdf.getPages()[output.page - 1]!;
    const dict = page.node.Annots()!.asArray().map(ref => pdf.context.lookup(ref, PDFDict)).find(dict => text(dict, 'NM') === stroke.id)!;
    const ap = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    if (!(ap instanceof PDFStream) || !ap.dict.has(PDFName.of('Resources'))) throw new Error('PDF drawing appearance verification failed.');
  }
}
