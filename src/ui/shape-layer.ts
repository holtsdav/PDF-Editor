import type { NativePage } from '../compat/native-pdf';
import { screenRectangle } from '../compat/native-pdf';
import type { Rect } from '../pdf/text-engine';
import type { TextSession } from '../pdf/text-session';
import { arrowSize, rotatedCorners, shapeRect } from '../pdf/shape-engine';
import type { PdfShape, Point, ShapeKind } from '../pdf/shape-engine';
import { cssColor } from '../pdf/text-format';
import type { PdfColor } from '../pdf/text-format';
import type { EditorTool } from './ink-layer';

export interface ShapeStyle {
  kind: ShapeKind;
  filled: boolean;
  color: PdfColor;
  width: number;
}
export interface ShapeOptions {
  tool(): EditorTool;
  style(): ShapeStyle;
  selected(): string | undefined;
  select(id: string | undefined): void;
  /** A new shape was drawn. */
  drawn(id: string): void;
  changed(): void;
  error(error: unknown): void;
}

const NS = 'http://www.w3.org/2000/svg';
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'start' | 'end' | 'rotate';
type Gesture =
  | { type: 'draw'; pointer: number; start: Point; end: Point; shift: boolean }
  | { type: 'move'; pointer: number; id: string; from: Point; to: Point }
  | {
      type: 'resize';
      pointer: number;
      id: string;
      handle: Handle;
      to: Point;
      shift: boolean;
    };

const boxed = (kind: ShapeKind) => kind === 'rectangle' || kind === 'ellipse';

/** Shapes of one page, painted as SVG over the page in viewport pixels. */
export class ShapeLayer {
  readonly svg: SVGSVGElement;
  private page: NativePage;
  private layer: HTMLElement;
  private session: TextSession;
  private options: ShapeOptions;
  private gesture?: Gesture;
  private signature = '';
  private cleanups: (() => void)[] = [];

  constructor(page: NativePage, layer: HTMLElement, session: TextSession, options: ShapeOptions) {
    this.page = page;
    this.layer = layer;
    this.session = session;
    this.options = options;
    const doc = layer.ownerDocument;
    this.svg = doc.createElementNS(NS, 'svg');
    this.svg.classList.add('pfs-shapes');
    layer.prepend(this.svg);
    const listen = <K extends keyof HTMLElementEventMap>(
      target: EventTarget,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, handler as EventListener);
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
    };
    // Drawing: the layer receives pointers while the shape tool is active.
    listen(layer, 'pointerdown', (event) => {
      if (
        this.options.tool() !== 'shape' ||
        event.button !== 0 ||
        (event.target !== layer && event.target !== this.svg)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const point = this.viewportPoint(event);
      this.gesture = {
        type: 'draw',
        pointer: event.pointerId,
        start: point,
        end: point,
        shift: event.shiftKey,
      };
      layer.setPointerCapture(event.pointerId);
    });
    // Moving and resizing: shapes and handles receive pointers in the select tool.
    listen(this.svg, 'pointerdown', (event) => {
      const target = event.target as Element;
      const id = target.closest<SVGElement>('[data-shape-id]')?.dataset.shapeId;
      if (this.options.tool() !== 'select' || event.button !== 0 || !id) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const handle = (target as SVGElement).dataset.handle as Handle | undefined;
      const point = this.viewportPoint(event);
      this.options.select(id);
      if (this.session.snapshot.shapes?.find((shape) => shape.id === id)?.locked) {
        return; // Locked shapes can be selected (for the context menu) but not changed.
      }
      this.gesture = handle
        ? {
            type: 'resize',
            pointer: event.pointerId,
            id,
            handle,
            to: point,
            shift: event.shiftKey,
          }
        : { type: 'move', pointer: event.pointerId, id, from: point, to: point };
    });
    const move = (event: PointerEvent) => {
      const gesture = this.gesture;
      if (!gesture || gesture.pointer !== event.pointerId) {
        return;
      }
      const point = this.viewportPoint(event);
      if (gesture.type === 'draw') {
        gesture.end = point;
        gesture.shift = event.shiftKey;
      } else if (gesture.type === 'move') {
        gesture.to = point;
      } else {
        gesture.to = point;
        gesture.shift = event.shiftKey;
      }
      this.paint(true);
    };
    const up = (event: PointerEvent) => {
      const gesture = this.gesture;
      if (!gesture || gesture.pointer !== event.pointerId) {
        return;
      }
      this.gesture = undefined;
      try {
        this.commit(gesture);
      } catch (error) {
        this.options.error(error);
      }
      this.paint(true);
    };
    // Follow the pointer on the document: repainting replaces the shape element that was
    // pressed, so listeners on it (or its pointer capture) would lose the gesture.
    const cancel = () => {
      this.gesture = undefined;
      this.paint(true);
    };
    listen(doc, 'pointermove', move);
    listen(doc, 'pointerup', up);
    listen(doc, 'pointercancel', cancel);
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.svg.remove();
  }

  get interacting(): boolean {
    return !!this.gesture;
  }

  update(page: NativePage, session: TextSession): void {
    this.page = page;
    this.session = session;
    if (!this.svg.isConnected) {
      this.layer.prepend(this.svg);
    }
    this.paint();
  }

  private viewportPoint(event: PointerEvent): Point {
    const box = this.layer.getBoundingClientRect();
    const { viewport } = this.page;
    return [
      ((event.clientX - box.left) * viewport.width) / (box.width || viewport.width),
      ((event.clientY - box.top) * viewport.height) / (box.height || viewport.height),
    ];
  }

  private pdf(point: Point): Point {
    const [x, y] = this.page.viewport.convertToPdfPoint(point[0], point[1]);
    return [x!, y!];
  }

  private view(point: Point): Point {
    const r = this.page.viewport.convertToViewportRectangle([...point, ...point]);
    return [r[0]!, r[1]!];
  }

  private bounds(): Rect {
    return this.session.snapshot.pages[this.page.number - 1]!;
  }

  /** Geometry after an in-progress move or resize, in PDF points (clamped to the page). */
  private transformed(shape: PdfShape, gesture: Gesture): PdfShape {
    const next = structuredClone(shape);
    const bounds = this.bounds();
    if (gesture.type === 'move') {
      const [fx, fy] = this.pdf(gesture.from);
      const [tx, ty] = this.pdf(gesture.to);
      const extent = shape.box ? shapeRect(shape) : shapeExtent(shape);
      const dx = Math.max(bounds[0] - extent[0], Math.min(bounds[2] - extent[2], tx - fx));
      const dy = Math.max(bounds[1] - extent[1], Math.min(bounds[3] - extent[3], ty - fy));
      if (next.box) {
        next.box = [next.box[0] + dx, next.box[1] + dy, next.box[2] + dx, next.box[3] + dy];
      } else {
        next.start = [next.start![0] + dx, next.start![1] + dy];
        next.end = [next.end![0] + dx, next.end![1] + dy];
      }
      return next;
    }
    if (gesture.type !== 'resize') {
      return next;
    }
    const clamp = (p: Point): Point => [
      Math.max(bounds[0], Math.min(bounds[2], p[0])),
      Math.max(bounds[1], Math.min(bounds[3], p[1])),
    ];
    const to = clamp(this.pdf(gesture.to));
    if (next.box) {
      const [l, b, r, t] = next.box;
      const cx = (l + r) / 2;
      const cy = (b + t) / 2;
      if (gesture.handle === 'rotate') {
        // The handle sits above the top edge: pointing straight up means no turn.
        let angle = (Math.atan2(to[1] - cy, to[0] - cx) * 180) / Math.PI - 90;
        if (gesture.shift) {
          angle = Math.round(angle / 15) * 15;
        }
        next.rotation = Math.round(angle * 100) / 100;
      } else {
        // Resize in the shape's own (unrotated) frame, keeping the opposite corner fixed.
        const angle = ((shape.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const local: Point = [
          (to[0] - cx) * cos + (to[1] - cy) * sin,
          -(to[0] - cx) * sin + (to[1] - cy) * cos,
        ];
        const hw = (r - l) / 2;
        const hh = (t - b) / 2;
        const fixed: Point =
          gesture.handle === 'nw'
            ? [hw, -hh]
            : gesture.handle === 'ne'
              ? [-hw, -hh]
              : gesture.handle === 'sw'
                ? [hw, hh]
                : [-hw, hh];
        const [x0, y0, x1, y1] = boxFrom(fixed, local, gesture.shift);
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const ncx = cx + mx * cos - my * sin;
        const ncy = cy + mx * sin + my * cos;
        const w = (x1 - x0) / 2;
        const h = (y1 - y0) / 2;
        next.box = [ncx - w, ncy - h, ncx + w, ncy + h];
      }
      if (!next.rotation) {
        delete next.rotation;
      }
      // A turn or resize that would leave the page keeps the last valid geometry.
      const rect = shapeRect(next);
      if (
        rect[0] < bounds[0] - 0.01 ||
        rect[1] < bounds[1] - 0.01 ||
        rect[2] > bounds[2] + 0.01 ||
        rect[3] > bounds[3] + 0.01 ||
        next.box[2] - next.box[0] < 1 ||
        next.box[3] - next.box[1] < 1
      ) {
        return structuredClone(shape);
      }
    } else if (gesture.handle === 'start') {
      next.start = gesture.shift ? snap(next.end!, to) : to;
    } else {
      next.end = gesture.shift ? snap(next.start!, to) : to;
    }
    return next;
  }

  private commit(gesture: Gesture): void {
    if (gesture.type === 'draw') {
      const [sx, sy] = gesture.start;
      const [ex, ey] = gesture.end;
      if (Math.hypot(ex - sx, ey - sy) < 4) {
        return;
      }
      const style = this.options.style();
      const start = this.pdf(gesture.start);
      let end = this.pdf(gesture.end);
      const bounds = this.bounds();
      end = [
        Math.max(bounds[0], Math.min(bounds[2], end[0])),
        Math.max(bounds[1], Math.min(bounds[3], end[1])),
      ];
      const shape = boxed(style.kind)
        ? this.session.addShape({
            page: this.page.number,
            kind: style.kind,
            box: boxFrom(start, end, gesture.shift),
            color: style.color,
            ...(style.filled ? { fill: style.color } : {}),
            width: style.width,
          })
        : this.session.addShape({
            page: this.page.number,
            kind: style.kind,
            start,
            end: gesture.shift ? snap(start, end) : end,
            color: style.color,
            width: style.width,
          });
      this.options.drawn(shape.id);
      this.options.changed();
      return;
    }
    const shape = this.session.snapshot.shapes?.find((item) => item.id === gesture.id);
    if (!shape) {
      return;
    }
    const next = this.transformed(shape, gesture);
    if (
      JSON.stringify([next.box, next.start, next.end, next.rotation ?? 0]) ===
      JSON.stringify([shape.box, shape.start, shape.end, shape.rotation ?? 0])
    ) {
      return;
    }
    this.session.updateShape(
      shape.id,
      next.box
        ? { box: next.box, rotation: next.rotation ?? 0 }
        : { start: next.start!, end: next.end! },
    );
    this.options.changed();
  }

  /** Repaint when shapes, selection, tool or viewport changed (or always during gestures). */
  private paint(force = false): void {
    const shapes = (this.session.snapshot.shapes ?? []).filter(
      (shape) => shape.page === this.page.number,
    );
    const { viewport } = this.page;
    const selected = this.options.selected();
    const signature = JSON.stringify([
      shapes,
      selected,
      this.options.tool(),
      viewport.width,
      viewport.height,
      viewport.rotation,
    ]);
    if (!force && !this.gesture && signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.svg.setAttribute('width', String(viewport.width));
    this.svg.setAttribute('height', String(viewport.height));
    this.svg.dataset.tool = this.options.tool();
    this.svg.replaceChildren();
    const gesture = this.gesture;
    for (const original of shapes) {
      const shape =
        gesture && gesture.type !== 'draw' && gesture.id === original.id
          ? this.transformed(original, gesture)
          : original;
      const group = this.draw(shape);
      group.dataset.shapeId = shape.id;
      this.svg.append(group);
      if (shape.id === selected) {
        this.svg.append(this.selection(shape));
      }
    }
    if (gesture?.type === 'draw') {
      const style = this.options.style();
      const start = this.pdf(gesture.start);
      const end = this.pdf(gesture.end);
      const preview: PdfShape = {
        id: 'preview',
        page: this.page.number,
        kind: style.kind,
        ...(boxed(style.kind)
          ? { box: boxFrom(start, end, gesture.shift) }
          : { start, end: gesture.shift ? snap(start, end) : end }),
        color: style.color,
        ...(style.filled && boxed(style.kind) ? { fill: style.color } : {}),
        width: style.width,
        opacity: 1,
        modified: '',
      };
      const group = this.draw(preview);
      group.classList.add('is-preview');
      this.svg.append(group);
    }
  }

  private element<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number | undefined>,
  ): SVGElementTagNameMap[K] {
    const element = this.svg.ownerDocument.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        element.setAttribute(key, String(value));
      }
    }
    return element;
  }

  private draw(shape: PdfShape): SVGGElement {
    const group = this.element('g', { class: 'pfs-shape' });
    const scale = this.page.viewport.scale;
    const stroke = cssColor(shape.color);
    const width = shape.width * scale;
    const paint = {
      stroke,
      'stroke-width': width,
      fill: shape.fill ? cssColor(shape.fill) : 'none',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      opacity: shape.opacity,
    };
    // A wider invisible copy makes thin outlines easy to click.
    const hit = {
      class: 'pfs-shape-hit',
      stroke: 'transparent',
      'stroke-width': width + 10,
      fill: shape.fill ? 'transparent' : 'none',
    };
    if (shape.box) {
      const [l, t, r, b] = screenRectangle(this.page.viewport, shape.box);
      const inset = width / 2;
      const geometry =
        shape.kind === 'rectangle'
          ? {
              tag: 'rect' as const,
              attrs: {
                x: l + inset,
                y: t + inset,
                width: Math.max(0, r - l - width),
                height: Math.max(0, b - t - width),
              },
            }
          : {
              tag: 'ellipse' as const,
              attrs: {
                cx: (l + r) / 2,
                cy: (t + b) / 2,
                rx: Math.max(0, (r - l - width) / 2),
                ry: Math.max(0, (b - t - width) / 2),
              },
            };
      group.append(this.element(geometry.tag, { ...geometry.attrs, ...paint }));
      group.append(this.element(geometry.tag, { ...geometry.attrs, ...hit }));
      if (shape.rotation) {
        // PDF turns counter-clockwise with y up; on screen (y down) that is a negative SVG angle.
        group.setAttribute('transform', `rotate(${-shape.rotation} ${(l + r) / 2} ${(t + b) / 2})`);
      }
      return group;
    }
    const [sx, sy] = this.view(shape.start!);
    let [ex, ey] = this.view(shape.end!);
    if (shape.kind === 'arrow') {
      const length = Math.hypot(ex - sx, ey - sy) || 1;
      const ux = (ex - sx) / length;
      const uy = (ey - sy) / length;
      const size = arrowSize(shape.width) * scale;
      const bx = ex - ux * size;
      const by = ey - uy * size;
      const half = size * 0.45;
      group.append(
        this.element('polygon', {
          points: `${ex},${ey} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}`,
          fill: stroke,
          opacity: shape.opacity,
        }),
      );
      ex -= ux * size * 0.8;
      ey -= uy * size * 0.8;
    }
    const line = { x1: sx, y1: sy, x2: ex, y2: ey };
    group.append(this.element('line', { ...line, ...paint, fill: 'none' }));
    group.append(this.element('line', { ...line, ...hit }));
    return group;
  }

  private selection(shape: PdfShape): SVGGElement {
    const group = this.element('g', {
      class: shape.locked ? 'pfs-shape-selection is-locked' : 'pfs-shape-selection',
    });
    group.dataset.shapeId = shape.id;
    const handle = (name: Handle, [x, y]: Point) => {
      if (shape.locked) {
        return;
      }
      const element = this.element('rect', {
        class: 'pfs-shape-handle',
        x: x - 5,
        y: y - 5,
        width: 10,
        height: 10,
      });
      element.dataset.handle = name;
      group.append(element);
    };
    if (shape.box) {
      // Corners in PDF order (lower left, lower right, upper right, upper left), turned.
      const corners = rotatedCorners(shape.box, shape.rotation).map((p) => this.view(p));
      group.append(
        this.element('polygon', {
          class: 'pfs-shape-outline',
          points: corners.map(([x, y]) => `${x},${y}`).join(' '),
        }),
      );
      const [sw, se, ne, nw] = corners as [Point, Point, Point, Point];
      handle('sw', sw);
      handle('se', se);
      handle('ne', ne);
      handle('nw', nw);
      // Rotation handle, a short stem above the middle of the (turned) top edge.
      const top: Point = [(nw[0] + ne[0]) / 2, (nw[1] + ne[1]) / 2];
      const centre: Point = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
      const length = Math.hypot(top[0] - centre[0], top[1] - centre[1]) || 1;
      const knob: Point = [
        top[0] + ((top[0] - centre[0]) / length) * 24,
        top[1] + ((top[1] - centre[1]) / length) * 24,
      ];
      group.append(
        this.element('line', {
          class: 'pfs-shape-outline',
          x1: top[0],
          y1: top[1],
          x2: knob[0],
          y2: knob[1],
        }),
      );
      const rotate = this.element('circle', {
        class: 'pfs-shape-handle pfs-shape-rotate',
        cx: knob[0],
        cy: knob[1],
        r: 6,
      });
      rotate.dataset.handle = 'rotate';
      if (!shape.locked) {
        group.append(rotate);
      }
    } else {
      handle('start', this.view(shape.start!));
      handle('end', this.view(shape.end!));
    }
    return group;
  }
}

/** Box from two corners in PDF points; Shift makes it square (or a circle). */
export function boxFrom(a: Point, b: Point, square = false): Rect {
  let [x, y] = b;
  if (square) {
    const size = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    x = a[0] + Math.sign(b[0] - a[0] || 1) * size;
    y = a[1] + Math.sign(b[1] - a[1] || 1) * size;
  }
  return [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[0], x), Math.max(a[1], y)];
}

/** Shift snaps lines to 45° steps. */
export function snap(from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length];
}

export function shapeExtent(shape: PdfShape): Rect {
  if (shape.box) {
    return shape.box;
  }
  return [
    Math.min(shape.start![0], shape.end![0]),
    Math.min(shape.start![1], shape.end![1]),
    Math.max(shape.start![0], shape.end![0]),
    Math.max(shape.start![1], shape.end![1]),
  ];
}
