import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { Rect } from './text-engine.ts';
import type { PdfColor } from './text-format.ts';
import { referencedObjects, pruneReplacedObjects } from './object-references.ts';
import { pdfDate } from './mark-engine.ts';

/**
 * Rectangles, ellipses, lines and arrows as standard PDF annotations
 * (/Square, /Circle, /Line with /LE), so other readers show and edit them.
 */
export const SHAPE_PREFIX = 'pdf-form-studio-shape-';
export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'arrow';
export type Point = [number, number];
export interface PdfShape {
  id: string;
  page: number;
  kind: ShapeKind;
  /** Rectangle/ellipse: the outer box. Line/arrow: start and end points. */
  box?: Rect;
  start?: Point;
  end?: Point;
  color: PdfColor;
  /** Interior colour for rectangles and ellipses; undefined means outline only. */
  fill?: PdfColor;
  width: number;
  opacity: number;
  modified: string;
  /**
   * Rectangles and ellipses: counter-clockwise turn in degrees around the box centre.
   * Standard /Square and /Circle cannot rotate, so the box and angle are kept in
   * PFSBox/PFSRotation and the appearance draws the turned shape inside /Rect.
   */
  rotation?: number;
  /** PDF "Locked" flag: cannot be moved, resized or deleted until unlocked. */
  locked?: true;
}

/** Box corners after rotation, counter-clockwise from lower left. */
export function rotatedCorners(box: Rect, rotation = 0): [number, number][] {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (
    [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
    ] as [number, number][]
  ).map(([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]);
}

const SUBTYPES: Record<ShapeKind, string> = {
  rectangle: 'Square',
  ellipse: 'Circle',
  line: 'Line',
  arrow: 'Line',
};

export function arrowSize(width: number): number {
  return Math.max(6, width * 4);
}

/** Annotation rectangle: the box, or the line's bounds plus room for its stroke and head. */
export function shapeRect(shape: PdfShape): Rect {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
    if (!shape.rotation) {
      return [...shape.box!] as Rect;
    }
    const corners = rotatedCorners(shape.box!, shape.rotation);
    return [
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1])),
    ];
  }
  const pad = shape.width + (shape.kind === 'arrow' ? arrowSize(shape.width) : 0) + 1;
  const [a, b] = [shape.start!, shape.end!];
  return [
    Math.min(a[0], b[0]) - pad,
    Math.min(a[1], b[1]) - pad,
    Math.max(a[0], b[0]) + pad,
    Math.max(a[1], b[1]) + pad,
  ];
}

export function validateShape(shape: PdfShape, bounds: Rect): void {
  const finite = (values: number[]) => values.every(Number.isFinite);
  const colour = (value?: PdfColor) =>
    !value || (value.length === 3 && value.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  const boxed = shape.kind === 'rectangle' || shape.kind === 'ellipse';
  const inside = (x: number, y: number) =>
    x >= bounds[0] - 0.01 &&
    x <= bounds[2] + 0.01 &&
    y >= bounds[1] - 0.01 &&
    y <= bounds[3] + 0.01;
  if (
    !shape.id.startsWith(SHAPE_PREFIX) ||
    !(shape.kind in SUBTYPES) ||
    (boxed
      ? !shape.box ||
        !finite(shape.box) ||
        shape.box[2] - shape.box[0] < 1 ||
        shape.box[3] - shape.box[1] < 1 ||
        (shape.rotation !== undefined &&
          (!Number.isFinite(shape.rotation) || Math.abs(shape.rotation) > 360)) ||
        !inside(shapeRect(shape)[0], shapeRect(shape)[1]) ||
        !inside(shapeRect(shape)[2], shapeRect(shape)[3])
      : !shape.start ||
        !shape.end ||
        !finite([...shape.start, ...shape.end]) ||
        Math.hypot(shape.end[0] - shape.start[0], shape.end[1] - shape.start[1]) < 1 ||
        !inside(...shape.start) ||
        !inside(...shape.end)) ||
    !colour(shape.color) ||
    !colour(shape.fill) ||
    (!boxed && shape.fill) ||
    !Number.isFinite(shape.width) ||
    shape.width <= 0 ||
    shape.width > 50 ||
    !Number.isFinite(shape.opacity) ||
    shape.opacity <= 0 ||
    shape.opacity > 1 ||
    !/^D:\d{14}/.test(shape.modified)
  ) {
    throw new Error('Invalid shape. Keep it inside its PDF page.');
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
function bounds(page: PDFPage): Rect {
  const box = page.getCropBox();
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}
function owned(dict: PDFDict): boolean {
  return (
    !!text(dict, 'NM')?.startsWith(SHAPE_PREFIX) &&
    dict.get(PDFName.of('PFSKind'))?.toString() === '/Shape'
  );
}

/** Only shapes made by this plugin are editable; other drawings stay untouched. */
export function readShapes(pdf: PDFDocument): PdfShape[] {
  const shapes: PdfShape[] = [];
  const ids = new Set<string>();
  pdf.getPages().forEach((page, index) => {
    for (const entry of page.node.Annots()?.asArray() ?? []) {
      const dict = pdf.context.lookup(entry);
      if (!(dict instanceof PDFDict) || !owned(dict)) {
        continue;
      }
      const id = text(dict, 'NM')!;
      if (ids.has(id)) {
        throw new Error('The PDF contains duplicate shape IDs.');
      }
      ids.add(id);
      const subtype = dict.get(PDFName.of('Subtype'))?.toString();
      const ends = dict.lookup(PDFName.of('LE'));
      const arrow =
        ends instanceof PDFArray && ends.size() === 2 && ends.get(1)?.toString() !== '/None';
      const kind: ShapeKind | undefined =
        subtype === '/Square'
          ? 'rectangle'
          : subtype === '/Circle'
            ? 'ellipse'
            : subtype === '/Line'
              ? arrow
                ? 'arrow'
                : 'line'
              : undefined;
      const rect = numbers(dict, 'Rect');
      const color = numbers(dict, 'C');
      const fill = numbers(dict, 'IC');
      const border = dict.lookup(PDFName.of('BS'));
      const opacity = dict.lookup(PDFName.of('CA'));
      const line = numbers(dict, 'L');
      if (
        !kind ||
        rect?.length !== 4 ||
        color?.length !== 3 ||
        (kind === 'line' || kind === 'arrow' ? line?.length !== 4 : false)
      ) {
        throw new Error('Invalid shape in this PDF.');
      }
      const shape: PdfShape = {
        id,
        page: index + 1,
        kind,
        ...(kind === 'rectangle' || kind === 'ellipse'
          ? (() => {
              const stored = numbers(dict, 'PFSBox');
              const turn = dict.lookup(PDFName.of('PFSRotation'));
              return stored?.length === 4 && turn instanceof PDFNumber && turn.asNumber()
                ? { box: stored as Rect, rotation: turn.asNumber() }
                : { box: [rect[0]!, rect[1]!, rect[2]!, rect[3]!] as Rect };
            })()
          : { start: [line![0]!, line![1]!] as Point, end: [line![2]!, line![3]!] as Point }),
        color: color as PdfColor,
        ...((kind === 'rectangle' || kind === 'ellipse') && fill?.length === 3
          ? { fill: fill as PdfColor }
          : {}),
        width:
          border instanceof PDFDict
            ? (border.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber() ?? 1)
            : 1,
        opacity: opacity instanceof PDFNumber ? opacity.asNumber() : 1,
        modified: text(dict, 'M') ?? pdfDate(new Date(0)),
        ...((dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) & 128
          ? { locked: true as const }
          : {}),
      };
      validateShape(shape, bounds(page));
      shapes.push(shape);
    }
  });
  return shapes;
}

const decimal = (value: number) => String(Math.round(value * 1000) / 1000);
const rgb = (color: PdfColor) => color.map(decimal).join(' ');

/** Appearance in the annotation's own space (origin at the rectangle's lower left). */
function appearance(shape: PdfShape): string {
  const rect = shapeRect(shape);
  const [x0, y0] = rect;
  const w = shape.width;
  const ops = ['q', '/GS0 gs', `${decimal(w)} w 1 j 1 J`, `${rgb(shape.color)} RG`];
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse') {
    const box = shape.box!;
    if (shape.rotation) {
      // Draw the unrotated box in its own frame, turned about its centre.
      const angle = (shape.rotation * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const hw = (box[2] - box[0]) / 2;
      const hh = (box[3] - box[1]) / 2;
      const cx = (box[0] + box[2]) / 2 - x0;
      const cy = (box[1] + box[3]) / 2 - y0;
      const e = cx - cos * hw + sin * hh;
      const f = cy - sin * hw - cos * hh;
      ops.push(`${[cos, sin, -sin, cos, e, f].map(decimal).join(' ')} cm`);
    } else {
      ops.push(`1 0 0 1 ${decimal(box[0] - x0)} ${decimal(box[1] - y0)} cm`);
    }
    const left = w / 2;
    const bottom = w / 2;
    const width = box[2] - box[0] - w;
    const height = box[3] - box[1] - w;
    if (shape.fill) {
      ops.push(`${rgb(shape.fill)} rg`);
    }
    const paint = shape.fill ? 'B' : 'S';
    if (shape.kind === 'rectangle') {
      ops.push(
        `${decimal(left)} ${decimal(bottom)} ${decimal(width)} ${decimal(height)} re ${paint}`,
      );
    } else {
      const cx = left + width / 2;
      const cy = bottom + height / 2;
      const rx = width / 2;
      const ry = height / 2;
      const kx = rx * 0.5522847498;
      const ky = ry * 0.5522847498;
      ops.push(
        `${decimal(cx + rx)} ${decimal(cy)} m`,
        `${decimal(cx + rx)} ${decimal(cy + ky)} ${decimal(cx + kx)} ${decimal(cy + ry)} ${decimal(cx)} ${decimal(cy + ry)} c`,
        `${decimal(cx - kx)} ${decimal(cy + ry)} ${decimal(cx - rx)} ${decimal(cy + ky)} ${decimal(cx - rx)} ${decimal(cy)} c`,
        `${decimal(cx - rx)} ${decimal(cy - ky)} ${decimal(cx - kx)} ${decimal(cy - ry)} ${decimal(cx)} ${decimal(cy - ry)} c`,
        `${decimal(cx + kx)} ${decimal(cy - ry)} ${decimal(cx + rx)} ${decimal(cy - ky)} ${decimal(cx + rx)} ${decimal(cy)} c`,
        `h ${paint}`,
      );
    }
  } else {
    const [sx, sy] = [shape.start![0] - x0, shape.start![1] - y0];
    let [ex, ey] = [shape.end![0] - x0, shape.end![1] - y0];
    if (shape.kind === 'arrow') {
      const length = Math.hypot(ex - sx, ey - sy) || 1;
      const ux = (ex - sx) / length;
      const uy = (ey - sy) / length;
      const size = arrowSize(w);
      const bx = ex - ux * size;
      const by = ey - uy * size;
      const half = size * 0.45;
      ops.push(
        `${rgb(shape.color)} rg`,
        `${decimal(ex)} ${decimal(ey)} m ${decimal(bx - uy * half)} ${decimal(by + ux * half)} l ${decimal(bx + uy * half)} ${decimal(by - ux * half)} l h f`,
      );
      // The shaft stops inside the head so its round cap does not poke through the tip.
      ex = ex - ux * size * 0.8;
      ey = ey - uy * size * 0.8;
    }
    ops.push(`${decimal(sx)} ${decimal(sy)} m ${decimal(ex)} ${decimal(ey)} l S`);
  }
  ops.push('Q');
  return ops.join('\n');
}

function ownedEntries(pdf: PDFDocument): { page: PDFPage; dict: PDFDict; id: string }[] {
  return pdf.getPages().flatMap((page) =>
    (page.node.Annots()?.asArray() ?? []).flatMap((entry) => {
      const dict = pdf.context.lookup(entry);
      return dict instanceof PDFDict && owned(dict) ? [{ page, dict, id: text(dict, 'NM')! }] : [];
    }),
  );
}

function remove(page: PDFPage, dict: PDFDict): void {
  const annotations = page.node.Annots();
  if (!annotations) {
    return;
  }
  for (let i = annotations.size() - 1; i >= 0; i--) {
    if (annotations.lookup(i) === dict) {
      annotations.remove(i);
    }
  }
}

export function writeShapes(
  pdf: PDFDocument,
  changed: Map<string, PdfShape>,
  deleted: Set<string>,
): void {
  const entries = ownedEntries(pdf);
  const context = pdf.context;
  const touched = entries.filter((entry) => changed.has(entry.id) || deleted.has(entry.id));
  const replaced = referencedObjects(
    pdf,
    touched.map((entry) => entry.dict.get(PDFName.of('AP'))),
  );
  for (const entry of touched) {
    remove(entry.page, entry.dict);
  }
  for (const shape of changed.values()) {
    if (deleted.has(shape.id)) {
      continue;
    }
    const page = pdf.getPages()[shape.page - 1];
    if (!page) {
      throw new Error('The shape page no longer exists.');
    }
    validateShape(shape, bounds(page));
    const rect = shapeRect(shape);
    const ap = context.register(
      context.flateStream(appearance(shape), {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]],
        Resources: {
          ExtGState: { GS0: { Type: 'ExtGState', CA: shape.opacity, ca: shape.opacity } },
        },
      }),
    );
    const dict = context.obj({
      Type: 'Annot',
      Subtype: SUBTYPES[shape.kind],
      NM: PDFHexString.fromText(shape.id),
      P: page.ref,
      F: shape.locked ? 4 | 128 : 4,
      Rect: rect,
      C: shape.color,
      CA: shape.opacity,
      BS: { Type: 'Border', W: shape.width, S: 'S' },
      T: PDFHexString.fromText('PDF Editor'),
      M: PDFString.of(shape.modified),
      CreationDate: PDFString.of(shape.modified),
      PFSKind: 'Shape',
      AP: { N: ap },
    });
    if (shape.fill) {
      dict.set(PDFName.of('IC'), context.obj(shape.fill));
    }
    if (shape.rotation && shape.box) {
      dict.set(PDFName.of('PFSBox'), context.obj(shape.box));
      dict.set(PDFName.of('PFSRotation'), PDFNumber.of(shape.rotation));
    }
    if (shape.kind === 'line' || shape.kind === 'arrow') {
      dict.set(PDFName.of('L'), context.obj([...shape.start!, ...shape.end!]));
      dict.set(
        PDFName.of('LE'),
        context.obj([
          PDFName.of('None'),
          PDFName.of(shape.kind === 'arrow' ? 'ClosedArrow' : 'None'),
        ]),
      );
      if (shape.kind === 'arrow') {
        dict.set(PDFName.of('IC'), context.obj(shape.color));
      }
    }
    page.node.addAnnot(context.register(dict));
  }
  pruneReplacedObjects(pdf, replaced);
}

export function verifyShapes(
  pdf: PDFDocument,
  changed: Map<string, PdfShape>,
  deleted: Set<string>,
): void {
  const saved = new Map(readShapes(pdf).map((shape) => [shape.id, shape]));
  for (const id of deleted) {
    if (saved.has(id) && !changed.has(id)) {
      throw new Error('PDF shape deletion verification failed.');
    }
  }
  const near = (a?: number[], b?: number[]) =>
    (!a && !b) ||
    (!!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 0.01));
  for (const shape of changed.values()) {
    if (deleted.has(shape.id)) {
      continue;
    }
    const output = saved.get(shape.id);
    if (
      !output ||
      output.kind !== shape.kind ||
      output.page !== shape.page ||
      !near(output.box, shape.box) ||
      !near(output.start, shape.start) ||
      !near(output.end, shape.end) ||
      !near(output.color, shape.color) ||
      !near(output.fill, shape.fill) ||
      Math.abs((output.rotation ?? 0) - (shape.rotation ?? 0)) > 0.001 ||
      !!output.locked !== !!shape.locked ||
      Math.abs(output.width - shape.width) > 0.001
    ) {
      throw new Error('PDF shape verification failed.');
    }
  }
}

/** Display copy: our shapes are painted live by the editor. */
export function stripShapes(pdf: PDFDocument): void {
  for (const entry of ownedEntries(pdf)) {
    remove(entry.page, entry.dict);
  }
}
