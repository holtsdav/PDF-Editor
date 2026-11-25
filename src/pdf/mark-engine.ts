import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
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
    !mark.id.startsWith(MARK_PREFIX) ||
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
function kindOf(dict: PDFDict): MarkKind | undefined {
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
function bounds(page: PDFPage): Rect {
  const box = page.getCropBox();
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

/** Only our tagged annotations are editable; other highlights and comments stay untouched. */
export function readMarks(pdf: PDFDocument): PdfMark[] {
  const marks: PdfMark[] = [];
  const ids = new Set<string>();
  pdf.getPages().forEach((page, index) => {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const dict = pdf.context.lookup(ref);
      if (!(dict instanceof PDFDict)) {
        continue;
      }
      const kind = kindOf(dict);
      if (!kind) {
        continue;
      }
      const id = text(dict, 'NM')!;
      if (ids.has(id)) {
        throw new Error('The PDF contains duplicate highlight IDs.');
      }
      ids.add(id);
      const rect = numbers(dict, 'Rect');
      const color = numbers(dict, 'C') ?? [1, 0.9, 0.2];
      const points = kind === 'highlight' ? numbers(dict, 'QuadPoints') : [];
      if (rect?.length !== 4 || color.length !== 3 || !points || points.length % 8) {
        throw new Error('Invalid highlight or comment in this PDF.');
      }
      const quads: Rect[] = [];
      for (let i = 0; i < points.length; i += 8) {
        const xs = [points[i]!, points[i + 2]!, points[i + 4]!, points[i + 6]!];
        const ys = [points[i + 1]!, points[i + 3]!, points[i + 5]!, points[i + 7]!];
        quads.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
      const opacity = dict.lookup(PDFName.of('CA'));
      const mark: PdfMark = {
        id,
        page: index + 1,
        kind,
        quads,
        rect: [
          Math.min(rect[0]!, rect[2]!),
          Math.min(rect[1]!, rect[3]!),
          Math.max(rect[0]!, rect[2]!),
          Math.max(rect[1]!, rect[3]!),
        ],
        color: color as PdfColor,
        opacity: opacity instanceof PDFNumber ? opacity.asNumber() : 1,
        comment: text(dict, 'Contents') ?? '',
        modified: text(dict, 'M') ?? pdfDate(new Date(0)),
      };
      validateMark(mark, bounds(page));
      marks.push(mark);
    }
  });
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

function ownedAnnotations(page: PDFPage, pdf: PDFDocument, id: string): PDFDict[] {
  return (page.node.Annots()?.asArray() ?? [])
    .map((ref) => pdf.context.lookup(ref))
    .filter(
      (dict): dict is PDFDict =>
        dict instanceof PDFDict && text(dict, 'NM') === id && !!kindOf(dict),
    );
}

/** Remove our annotation and its popup from every page. */
function removeMark(pdf: PDFDocument, id: string): PDFDict[] {
  const removed: PDFDict[] = [];
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) {
      continue;
    }
    const owned = ownedAnnotations(page, pdf, id);
    const popups = new Set<unknown>(owned.map((dict) => dict.get(PDFName.of('Popup'))));
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const ref = annotations.get(i);
      const dict = annotations.lookup(i);
      if ((dict instanceof PDFDict && owned.includes(dict)) || popups.has(ref)) {
        if (dict instanceof PDFDict) {
          removed.push(dict);
        }
        annotations.remove(i);
      }
    }
  }
  return removed;
}

export function writeMarks(
  pdf: PDFDocument,
  changed: Map<string, PdfMark>,
  deleted: Set<string>,
): void {
  const existing = new Map(readMarks(pdf).map((mark) => [mark.id, mark]));
  const context = pdf.context;
  const replaced = referencedObjects(
    pdf,
    pdf
      .getPages()
      .flatMap((page) =>
        [...changed.keys(), ...deleted]
          .flatMap((id) => ownedAnnotations(page, pdf, id))
          .flatMap((dict) => [dict.get(PDFName.of('AP')), dict.get(PDFName.of('Popup'))]),
      ),
  );
  for (const id of deleted) {
    if (!id.startsWith(MARK_PREFIX)) {
      throw new Error('Only highlights and comments made by this plugin can be removed.');
    }
    removeMark(pdf, id);
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
    if (prior) {
      removeMark(pdf, mark.id);
    }
    const [left, bottom, right, top] = mark.rect;
    const highlight = mark.kind === 'highlight';
    const ap = context.register(
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
      annotation.set(
        PDFName.of('QuadPoints'),
        context.obj(mark.quads.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1])),
      );
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

/** Display copy: our marks are painted live by the editor, so drop them and their popups. */
export function stripMarks(pdf: PDFDocument): void {
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) {
      continue;
    }
    const popups = new Set<unknown>();
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const dict = annotations.lookup(i);
      if (dict instanceof PDFDict && kindOf(dict)) {
        popups.add(dict.get(PDFName.of('Popup')));
        annotations.remove(i);
      }
    }
    for (let i = annotations.size() - 1; i >= 0; i--) {
      if (popups.has(annotations.get(i))) {
        annotations.remove(i);
      }
    }
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
