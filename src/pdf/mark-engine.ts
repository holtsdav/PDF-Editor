import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { Rect } from './text-engine.ts';
import type { PdfColor } from './text-format.ts';
import { referencedObjects, pruneReplacedObjects } from './object-references.ts';

/**
 * Text highlights and comment notes stored as standard PDF annotations
 * (/Highlight with QuadPoints, /Text sticky notes, each with /Contents and a /Popup),
 * so Acrobat, Okular, Preview, PDF.js and other readers show them and their comments.
 */
export const MARK_PREFIX = 'pdf-form-studio-mark-';
export const MARK_AUTHOR = 'PDF Editor';
/** IDs for other apps' annotations, derived from their PDF object reference. */
export const FOREIGN_PREFIX = 'pdf-foreign-mark-';
export const NOTE_SIZE = 20;
export type MarkKind = 'highlight' | 'note';
export interface PdfMark {
  id: string;
  page: number;
  kind: MarkKind;
  /** Highlight line rectangles in PDF coordinates; empty for notes. */
  quads: Rect[];
  /** Annotation rectangle: union of quads, or the note icon. */
  rect: Rect;
  color: PdfColor;
  opacity: number;
  comment: string;
  /** PDF date string (D:YYYYMMDDHHmmSS) of the last change. */
  modified: string;
  /** Made by another app; edited in place. */
  foreign?: true;
  author?: string;
}

export function pdfDate(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function unionRect(rects: Rect[]): Rect {
  return [
    Math.min(...rects.map((rect) => rect[0])),
    Math.min(...rects.map((rect) => rect[1])),
    Math.max(...rects.map((rect) => rect[2])),
    Math.max(...rects.map((rect) => rect[3])),
  ];
}

/** Merge selection rectangles into one band per text line. */
export function lineQuads(rects: Rect[]): Rect[] {
  const sorted = rects
    .filter(
      (rect) => rect.every(Number.isFinite) && rect[2] - rect[0] > 0.5 && rect[3] - rect[1] > 0.5,
    )
    .sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const lines: Rect[] = [];
  for (const rect of sorted) {
    const line = lines.find((item) => {
      const overlap = Math.min(item[3], rect[3]) - Math.max(item[1], rect[1]);
      return overlap > 0.5 * Math.min(item[3] - item[1], rect[3] - rect[1]);
    });
    if (line) {
      line[0] = Math.min(line[0], rect[0]);
      line[1] = Math.min(line[1], rect[1]);
      line[2] = Math.max(line[2], rect[2]);
      line[3] = Math.max(line[3], rect[3]);
    } else {
      lines.push([...rect]);
    }
  }
  return lines.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
}

export function validateMark(mark: PdfMark, bounds: Rect): void {
  const inside = (rect: Rect) =>
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1] &&
    rect[0] >= bounds[0] - 0.01 &&
    rect[1] >= bounds[1] - 0.01 &&
    rect[2] <= bounds[2] + 0.01 &&
    rect[3] <= bounds[3] + 0.01;
  if (
    (!mark.id.startsWith(MARK_PREFIX) && !mark.id.startsWith(FOREIGN_PREFIX)) ||
    (mark.kind !== 'highlight' && mark.kind !== 'note') ||
    (mark.kind === 'highlight' && (!mark.quads.length || mark.quads.length > 2000)) ||
    (mark.kind === 'note' && mark.quads.length) ||
    !mark.quads.every(inside) ||
    !inside(mark.rect) ||
    mark.color.length !== 3 ||
    mark.color.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    !Number.isFinite(mark.opacity) ||
    mark.opacity <= 0 ||
    mark.opacity > 1 ||
    typeof mark.comment !== 'string' ||
    mark.comment.length > 100000 ||
    !/^D:\d{14}/.test(mark.modified)
  ) {
    throw new Error('Invalid highlight or comment. Keep it inside its PDF page.');
  }
}

function text(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}
function numbers(dict: PDFDict, key: string): number[] | undefined {
  const array = dict.lookup(PDFName.of(key));
  if (!(array instanceof PDFArray)) {
    return undefined;
  }
  const values = array.asArray().map((_, index) => array.lookup(index));
  return values.every((value) => value instanceof PDFNumber)
    ? values.map((value) => value.asNumber())
    : undefined;
}
/** Our own annotations, tagged when we created them. */
function ownKind(dict: PDFDict): MarkKind | undefined {
  const id = text(dict, 'NM');
  const tag = dict.get(PDFName.of('PFSKind'))?.toString();
  const subtype = dict.get(PDFName.of('Subtype'))?.toString();
  if (!id?.startsWith(MARK_PREFIX)) {
    return undefined;
  }
  if (subtype === '/Highlight' && tag === '/Highlight') {
    return 'highlight';
  }
  if (subtype === '/Text' && tag === '/Note') {
    return 'note';
  }
  return undefined;
}

/**
 * Highlights and sticky notes made by other apps (Acrobat, Okular, PDF++ …). Replies,
 * review states and hidden annotations are left alone and keep their own rendering.
 */
function foreignKind(dict: PDFDict): MarkKind | undefined {
  if (text(dict, 'NM')?.startsWith(MARK_PREFIX) || dict.has(PDFName.of('PFSKind'))) {
    return undefined;
  }
  const flags = dict.lookup(PDFName.of('F'));
  if (
    dict.has(PDFName.of('IRT')) ||
    dict.has(PDFName.of('State')) ||
    (flags instanceof PDFNumber && flags.asNumber() & (1 | 2 | 32))
  ) {
    return undefined;
  }
  const subtype = dict.get(PDFName.of('Subtype'))?.toString();
  return subtype === '/Highlight' ? 'highlight' : subtype === '/Text' ? 'note' : undefined;
}

function foreignId(ref: PDFRef): string {
  return `${FOREIGN_PREFIX}${ref.objectNumber}-${ref.generationNumber}`;
}

function bounds(page: PDFPage): Rect {
  const box = page.getCropBox();
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

interface Located {
  page: PDFPage;
  index: number;
  ref?: PDFRef;
  dict: PDFDict;
  kind: MarkKind;
  id: string;
  foreign: boolean;
}

/** Every highlight/note annotation this plugin can show and edit, with a stable ID. */
function locate(pdf: PDFDocument): Located[] {
  const found: Located[] = [];
  pdf.getPages().forEach((page, index) => {
    for (const entry of page.node.Annots()?.asArray() ?? []) {
      const dict = pdf.context.lookup(entry);
      if (!(dict instanceof PDFDict)) {
        continue;
      }
      const own = ownKind(dict);
      if (own) {
        found.push({ page, index, dict, kind: own, id: text(dict, 'NM')!, foreign: false });
        continue;
      }
      const foreign = entry instanceof PDFRef ? foreignKind(dict) : undefined;
      if (foreign && entry instanceof PDFRef) {
        found.push({
          page,
          index,
          ref: entry,
          dict,
          kind: foreign,
          id: foreignId(entry),
          foreign: true,
        });
      }
    }
  });
  return found;
}

function markOf(item: Located): PdfMark | undefined {
  const { dict, kind } = item;
  const raw = numbers(dict, 'Rect');
  const color = numbers(dict, 'C');
  if (raw?.length !== 4) {
    return undefined;
  }
  const rect: Rect = [
    Math.min(raw[0]!, raw[2]!),
    Math.min(raw[1]!, raw[3]!),
    Math.max(raw[0]!, raw[2]!),
    Math.max(raw[1]!, raw[3]!),
  ];
  const quads: Rect[] = [];
  if (kind === 'highlight') {
    const points = numbers(dict, 'QuadPoints');
    if (points?.length && points.length % 8 === 0) {
      for (let i = 0; i < points.length; i += 8) {
        const xs = [points[i]!, points[i + 2]!, points[i + 4]!, points[i + 6]!];
        const ys = [points[i + 1]!, points[i + 3]!, points[i + 5]!, points[i + 7]!];
        quads.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    } else if (item.foreign) {
      quads.push(rect);
    } else {
      return undefined;
    }
  }
  const opacity = dict.lookup(PDFName.of('CA'));
  const modified = text(dict, 'M');
  return {
    id: item.id,
    page: item.index + 1,
    kind,
    quads,
    rect: kind === 'highlight' ? unionRect(quads) : rect,
    // Colour arrays may be gray (1), RGB (3) or CMYK (4) components.
    color: (color?.length === 3
      ? color
      : color?.length === 1
        ? [color[0]!, color[0]!, color[0]!]
        : color?.length === 4
          ? color.slice(0, 3).map((value) => 1 - Math.min(1, value + color[3]!))
          : [1, 0.85, 0.1]) as PdfColor,
    opacity: opacity instanceof PDFNumber ? opacity.asNumber() : 1,
    comment: text(dict, 'Contents') ?? '',
    modified: modified && /^D:\d{14}/.test(modified) ? modified : pdfDate(new Date(0)),
    ...(item.foreign ? { foreign: true as const, author: text(dict, 'T') ?? '' } : {}),
  };
}

/**
 * Highlights and notes, our own and other apps'. Our own must be valid (we wrote them);
 * a foreign annotation we cannot represent faithfully is skipped and left untouched.
 */
export function readMarks(pdf: PDFDocument): PdfMark[] {
  const marks: PdfMark[] = [];
  const ids = new Set<string>();
  for (const item of locate(pdf)) {
    const mark = markOf(item);
    if (!item.foreign) {
      if (ids.has(item.id)) {
        throw new Error('The PDF contains duplicate highlight IDs.');
      }
      if (!mark) {
        throw new Error('Invalid highlight or comment in this PDF.');
      }
      validateMark(mark, bounds(item.page));
    } else {
      if (!mark || ids.has(item.id)) {
        continue;
      }
      try {
        validateMark(mark, bounds(item.page));
      } catch {
        continue;
      }
    }
    ids.add(item.id);
    marks.push(mark);
  }
  return marks;
}

const decimal = (value: number) => String(Math.round(value * 1000) / 1000);

function highlightAppearance(mark: PdfMark): string {
  const [x0, y0] = mark.rect;
  const color = mark.color.map(decimal).join(' ');
  return [
    'q',
    '/GS0 gs',
    `${color} rg`,
    ...mark.quads.map(
      ([left, bottom, right, top]) =>
        `${decimal(left - x0)} ${decimal(bottom - y0)} ${decimal(right - left)} ${decimal(top - bottom)} re f`,
    ),
    'Q',
  ].join('\n');
}

/** A folded sticky note with text lines, drawn without fonts so every reader can paint it. */
function noteAppearance(mark: PdfMark): string {
  const size = NOTE_SIZE;
  const color = mark.color.map(decimal).join(' ');
  return [
    'q',
    `${color} rg 0.25 0.25 0.25 RG 0.8 w 1 j`,
    `0.5 0.5 m ${size - 6} 0.5 l ${size - 0.5} 6 l ${size - 0.5} ${size - 0.5} l 0.5 ${size - 0.5} l h B`,
    `${size - 6} 0.5 m ${size - 6} 6 l ${size - 0.5} 6 l S`,
    '0.25 0.25 0.25 RG 1 w',
    `4 ${size - 5} m ${size - 4} ${size - 5} l S`,
    `4 ${size - 9} m ${size - 4} ${size - 9} l S`,
    `4 ${size - 13} m ${size - 9} ${size - 13} l S`,
    'Q',
  ].join('\n');
}

function appearanceStream(pdf: PDFDocument, mark: PdfMark): PDFRef {
  const context = pdf.context;
  const [left, bottom, right, top] = mark.rect;
  const highlight = mark.kind === 'highlight';
  return context.register(
    context.flateStream(highlight ? highlightAppearance(mark) : noteAppearance(mark), {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, right - left, top - bottom],
      ...(highlight
        ? {
            Resources: {
              ExtGState: {
                GS0: { Type: 'ExtGState', CA: mark.opacity, ca: mark.opacity, BM: 'Multiply' },
              },
            },
          }
        : {}),
    }),
  );
}

/** Remove an annotation, its popup and any replies to it from its page. */
function removeLocated(item: Located): void {
  const annotations = item.page.node.Annots();
  if (!annotations) {
    return;
  }
  const popup = item.dict.get(PDFName.of('Popup'));
  for (let i = annotations.size() - 1; i >= 0; i--) {
    const entry = annotations.get(i);
    const dict = annotations.lookup(i);
    const reply =
      dict instanceof PDFDict && item.ref !== undefined && dict.get(PDFName.of('IRT')) === item.ref;
    if (dict === item.dict || (popup !== undefined && entry === popup) || reply) {
      annotations.remove(i);
    }
  }
}

const quadPoints = (quads: Rect[]) =>
  quads.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);

/** Change another app's annotation in place, so its author, replies and other keys survive. */
function updateForeign(pdf: PDFDocument, item: Located, mark: PdfMark, prior: PdfMark): void {
  const { dict } = item;
  const context = pdf.context;
  dict.set(PDFName.of('Contents'), PDFHexString.fromText(mark.comment));
  // Rich text would override the plain comment in Acrobat; keep a single source of truth.
  dict.delete(PDFName.of('RC'));
  dict.set(PDFName.of('M'), PDFString.of(mark.modified));
  dict.set(PDFName.of('C'), context.obj(mark.color));
  const recoloured = mark.color.some((value, i) => Math.abs(value - prior.color[i]!) > 0.0005);
  if (mark.kind === 'highlight') {
    dict.set(PDFName.of('QuadPoints'), context.obj(quadPoints(mark.quads)));
    dict.set(PDFName.of('Rect'), context.obj(mark.rect));
    if (
      recoloured ||
      JSON.stringify(mark.quads) !== JSON.stringify(prior.quads) ||
      !dict.has(PDFName.of('AP'))
    ) {
      dict.set(PDFName.of('AP'), context.obj({ N: appearanceStream(pdf, mark) }));
    }
  } else if (recoloured) {
    // Readers draw a note icon from /Name and /C when there is no appearance.
    dict.delete(PDFName.of('AP'));
  }
}

export function writeMarks(
  pdf: PDFDocument,
  changed: Map<string, PdfMark>,
  deleted: Set<string>,
): void {
  const located = new Map(locate(pdf).map((item) => [item.id, item]));
  const existing = new Map(readMarks(pdf).map((mark) => [mark.id, mark]));
  const context = pdf.context;
  const touched = [...changed.keys(), ...deleted]
    .map((id) => located.get(id))
    .filter((item): item is Located => !!item);
  const replaced = referencedObjects(
    pdf,
    touched.flatMap((item) => [
      item.dict.get(PDFName.of('AP')),
      item.dict.get(PDFName.of('Popup')),
    ]),
  );
  for (const id of deleted) {
    if (!id.startsWith(MARK_PREFIX) && !id.startsWith(FOREIGN_PREFIX)) {
      throw new Error('This annotation cannot be removed.');
    }
    const item = located.get(id);
    if (item) {
      removeLocated(item);
    }
  }
  for (const mark of changed.values()) {
    if (deleted.has(mark.id)) {
      continue;
    }
    const prior = existing.get(mark.id);
    if (prior && (prior.page !== mark.page || prior.kind !== mark.kind)) {
      throw new Error('This highlight cannot be moved to another page.');
    }
    const page = pdf.getPages()[mark.page - 1];
    if (!page) {
      throw new Error('The highlight page no longer exists.');
    }
    validateMark(mark, bounds(page));
    if (mark.id.startsWith(FOREIGN_PREFIX)) {
      const item = located.get(mark.id);
      if (!item || !prior) {
        throw new Error('This highlight changed in the PDF. Reload it before editing.');
      }
      updateForeign(pdf, item, mark, prior);
      continue;
    }
    const item = located.get(mark.id);
    if (item) {
      removeLocated(item);
    }
    const [, , right, top] = mark.rect;
    const highlight = mark.kind === 'highlight';
    const ap = appearanceStream(pdf, mark);
    const annotRef = context.nextRef();
    const popupRef = context.nextRef();
    const annotation = context.obj({
      Type: 'Annot',
      Subtype: highlight ? 'Highlight' : 'Text',
      NM: PDFHexString.fromText(mark.id),
      P: page.ref,
      F: 4,
      Rect: mark.rect,
      C: mark.color,
      CA: mark.opacity,
      T: PDFHexString.fromText(MARK_AUTHOR),
      M: PDFString.of(mark.modified),
      CreationDate: PDFString.of(mark.modified),
      Contents: PDFHexString.fromText(mark.comment),
      PFSKind: highlight ? 'Highlight' : 'Note',
      Popup: popupRef,
      AP: { N: ap },
    });
    if (highlight) {
      annotation.set(PDFName.of('QuadPoints'), context.obj(quadPoints(mark.quads)));
    } else {
      annotation.set(PDFName.of('Name'), PDFName.of('Comment'));
      annotation.set(PDFName.of('Open'), context.obj(false));
    }
    const box = bounds(page);
    const popupLeft = Math.min(Math.max(box[0], right + 4), box[2] - 180);
    const popupTop = Math.min(top, box[3]);
    context.assign(annotRef, annotation);
    context.assign(
      popupRef,
      context.obj({
        Type: 'Annot',
        Subtype: 'Popup',
        Parent: annotRef,
        F: 28,
        Open: false,
        Rect: [popupLeft, Math.max(box[1], popupTop - 120), popupLeft + 180, popupTop],
      }),
    );
    page.node.addAnnot(annotRef);
    page.node.addAnnot(popupRef);
  }
  pruneReplacedObjects(pdf, replaced);
}

export function verifyMarks(
  pdf: PDFDocument,
  changed: Map<string, PdfMark>,
  deleted: Set<string>,
): void {
  const saved = new Map(readMarks(pdf).map((mark) => [mark.id, mark]));
  for (const id of deleted) {
    if (saved.has(id)) {
      throw new Error('PDF highlight deletion verification failed.');
    }
  }
  for (const mark of changed.values()) {
    if (deleted.has(mark.id)) {
      continue;
    }
    const output = saved.get(mark.id);
    const near = (a: number[], b: number[]) =>
      a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < 0.01);
    if (
      !output ||
      output.page !== mark.page ||
      output.kind !== mark.kind ||
      output.comment !== mark.comment ||
      !near(output.rect, mark.rect) ||
      !near(output.color, mark.color) ||
      !near(output.quads.flat(), mark.quads.flat())
    ) {
      throw new Error('PDF highlight verification failed.');
    }
  }
}

/** Display copy: editable marks (ours and other apps') are painted live, so drop them and their popups. */
export function stripMarks(pdf: PDFDocument): void {
  const shown = new Set(readMarks(pdf).map((mark) => mark.id));
  const items = locate(pdf).filter((item) => shown.has(item.id));
  for (const item of items.reverse()) {
    removeLocated(item);
  }
}

/** Same text line: the rectangles overlap vertically by more than half the smaller height. */
function sameLine(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return overlap > 0.5 * Math.min(a[3] - a[1], b[3] - b[1]);
}

/** Whether a selection touches a highlight: same line and horizontally overlapping. */
export function quadsOverlap(quads: Rect[], cuts: Rect[]): boolean {
  return quads.some((quad) =>
    cuts.some(
      (cut) => sameLine(quad, cut) && Math.min(quad[2], cut[2]) - Math.max(quad[0], cut[0]) > 0.5,
    ),
  );
}

/**
 * Remove the selected parts from highlight quads, keeping what is left on each line.
 * Leftover slivers narrower than 1.5 pt (part of a space or glyph edge) are dropped.
 */
export function subtractQuads(quads: Rect[], cuts: Rect[]): Rect[] {
  let result = quads.map((quad) => [...quad] as Rect);
  for (const cut of cuts) {
    result = result.flatMap((quad) => {
      if (!sameLine(quad, cut) || Math.min(quad[2], cut[2]) - Math.max(quad[0], cut[0]) <= 0.5) {
        return [quad];
      }
      const pieces: Rect[] = [];
      if (cut[0] - quad[0] >= 1.5) {
        pieces.push([quad[0], quad[1], cut[0], quad[3]]);
      }
      if (quad[2] - cut[2] >= 1.5) {
        pieces.push([cut[2], quad[1], quad[2], quad[3]]);
      }
      return pieces;
    });
  }
  return result;
}
