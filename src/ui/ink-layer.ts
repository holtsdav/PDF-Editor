import { Component } from 'obsidian';
import type { NativePage } from '../compat/native-pdf';
import { strokeBounds } from '../pdf/ink-engine';
import type { InkKind, InkStroke, Point } from '../pdf/ink-engine';
import type { PdfColor } from '../pdf/text-format';
import { hitsStroke, simplifyStroke, resizeInkFrame, resizeInkPoints } from '../pdf/ink-geometry';
import { screenRectangle, pdfRectangle } from '../compat/native-pdf';
import type { Rect } from '../pdf/text-engine';
import type { ResizeHandle } from '../pdf/box-geometry';
import { snapTextBands } from '../pdf/marker-text';
import type { TextBand, TextWord } from '../pdf/marker-text';
import type { TextSession } from '../pdf/text-session';
import { DrawHold, recognizeShape, smoothInk } from '../pdf/ink-assist';
import type { RecognizedShape } from '../pdf/ink-assist';
import { HeldShape } from '../pdf/held-shape';
import { labelSvgOverlay } from './overlay-label';

export type EditorTool = 'select' | 'text' | 'marker' | 'scribble' | 'eraser';
interface InkOptions {
  tool(): EditorTool;
  width(kind: InkKind): number;
  color(kind: InkKind): PdfColor;
  selected(): string | undefined;
  select(id?: string): void;
  start(): void;
  changed(): void;
  remove(id: string): void;
  error(error: unknown): void;
  smooth(): boolean;
  shapes(): boolean;
  straightHold(): boolean;
  snapText?(): boolean;
}
interface InkControl {
  group: SVGGElement;
  visual: SVGPathElement;
  hit: SVGPathElement;
  outline: SVGRectElement;
  handles: SVGRectElement[];
  dispose(): void;
}
interface Gesture {
  pointer: number;
  tool: EditorTool;
  width: number;
  color: PdfColor;
  points: Point[];
  straight: boolean;
  y: number;
  signature: string;
  release(): void;
  id?: string;
  last?: Point;
  smooth?: boolean;
  hold?: DrawHold;
  holdAttempted?: boolean;
  snapped?: RecognizedShape;
  snapEnd?: Point;
  resize?: HeldShape;
  inkResize?: {
    stroke: InkStroke;
    handle: ResizeHandle;
    start: Point;
    rect: Rect;
    preview?: Point[];
  };
  textWords?: TextWord[];
}
const namespace = 'http://www.w3.org/2000/svg';

/** Live geometry stays visible while the shared document session batches writes. */
export class InkLayer extends Component {
  private page: NativePage;
  private layer: HTMLElement;
  private svg: SVGSVGElement;
  private preview: SVGPathElement;
  private snapPreviews: SVGPathElement[] = [];
  private controls = new Map<string, InkControl>();
  private session: TextSession;
  private options: InkOptions;
  private gesture?: Gesture;
  private previewFrame?: number;
  private holdTimer?: number;
  private hint: HTMLElement;
  private shortcutProxy: HTMLTextAreaElement;
  private shortcutRelease?: () => void;

  /** An active stroke must keep its page mounted even while scrolling moves the viewport away. */
  get interacting(): boolean {
    return !!this.gesture;
  }

  constructor(page: NativePage, layer: HTMLElement, session: TextSession, options: InkOptions) {
    super();
    this.page = page;
    this.layer = layer;
    this.session = session;
    this.options = options;
    const doc = layer.ownerDocument;
    this.svg = doc.createElementNS(namespace, 'svg');
    this.svg.classList.add('pdf-form-studio-ink');
    layer.prepend(this.svg);
    this.preview = doc.createElementNS(namespace, 'path');
    this.preview.classList.add('pdf-form-studio-stroke-preview');
    this.svg.append(this.preview);
    this.hint = layer.createDiv({ cls: 'pfs-ink-hint', attr: { role: 'status' } });
    this.hint.hidden = true;
    // Live Preview can consume shortcuts before they reach a focused SVG group.
    // Keep one keyboard target per page, regardless of the number of strokes.
    this.shortcutProxy = doc.createElement('textarea');
    this.shortcutProxy.className = 'pdf-form-studio-shortcut-proxy';
    this.shortcutProxy.readOnly = true;
    this.shortcutProxy.tabIndex = -1;
    this.shortcutProxy.setAttribute('aria-label', 'Selected PDF drawing');
    layer.append(this.shortcutProxy);
    this.registerDomEvent(this.shortcutProxy, 'focus', () => {
      this.shortcutRelease?.();
      this.shortcutRelease = this.session.beginInteraction();
    });
    this.registerDomEvent(this.shortcutProxy, 'blur', () => {
      this.shortcutRelease?.();
      this.shortcutRelease = undefined;
      this.options.changed();
    });
    this.registerDomEvent(this.shortcutProxy, 'keydown', (event) => {
      const id = this.options.selected();
      if (id) {
        this.keySelected(event, id);
      }
    });
    this.register(() => {
      this.cancel();
      this.shortcutRelease?.();
      this.shortcutRelease = undefined;
      for (const control of this.controls.values()) {
        control.dispose();
      }
      this.controls.clear();
      this.svg.remove();
      this.hint.remove();
      this.shortcutProxy.remove();
    });
    this.registerDomEvent(layer, 'pointerdown', (event) => this.down(event));
    this.registerDomEvent(layer, 'pointermove', (event) => this.move(event));
    this.registerDomEvent(layer, 'pointerup', (event) => this.up(event));
    this.registerDomEvent(layer, 'pointercancel', () => this.cancel());
    this.registerDomEvent(layer, 'lostpointercapture', () => {
      if (this.gesture && !layer.hasPointerCapture(this.gesture.pointer)) {
        this.cancel();
      }
    });
    this.registerDomEvent(doc.defaultView!, 'blur', () => this.cancel());
    this.registerDomEvent(doc, 'focusin', (event) => {
      if (this.gesture && !layer.contains(event.target as Node)) {
        this.cancel();
      }
    });
    this.registerDomEvent(layer, 'keydown', (event) => {
      if (event.key === 'Escape' && this.gesture) {
        event.preventDefault();
        this.cancel();
      }
    });
  }
  private signature(): string {
    const v = this.page.viewport;
    return [v.width, v.height, v.rotation, this.session.renderEpoch].join(':');
  }
  private screenPoint(event: PointerEvent): Point {
    const box = this.layer.getBoundingClientRect();
    const v = this.page.viewport;
    return [
      ((event.clientX - box.left) * v.width) / box.width,
      ((event.clientY - box.top) * v.height) / box.height,
    ];
  }
  private screen(point: Point): Point {
    const result = this.page.viewport.convertToViewportRectangle([...point, ...point]);
    return [result[0]!, result[1]!];
  }
  private point(event: PointerEvent, straightY?: number): Point {
    const box = this.layer.getBoundingClientRect();
    const v = this.page.viewport;
    const x = Math.max(0, Math.min(v.width, ((event.clientX - box.left) * v.width) / box.width));
    const y =
      straightY ??
      Math.max(0, Math.min(v.height, ((event.clientY - box.top) * v.height) / box.height));
    const result = v.convertToPdfPoint(x, y);
    const b = this.session.snapshot.pages[this.page.number - 1]!;
    return [Math.max(b[0], Math.min(b[2], result[0]!)), Math.max(b[1], Math.min(b[3], result[1]!))];
  }
  private path(points: Point[]): string {
    if (
      points.every(
        (point) => Math.hypot(point[0] - points[0]![0], point[1] - points[0]![1]) < 0.001,
      )
    ) {
      const [x, y] = this.screen(points[0]!);
      return `M${x},${y} l0.001,0`;
    }
    return points
      .map((point, i) => {
        const [x, y] = this.screen(point);
        return `${i ? 'L' : 'M'}${x},${y}`;
      })
      .join(' ');
  }
  private paint(
    path: SVGPathElement,
    kind: InkKind,
    width: number,
    color: PdfColor,
    opacity = kind === 'marker' ? 0.4 : 1,
  ): void {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', `rgb(${color.map((c) => c * 255).join(' ')})`);
    path.setAttribute('stroke-width', String(width * this.page.viewport.scale));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('opacity', String(opacity));
    path.style.mixBlendMode = kind === 'marker' ? 'multiply' : 'normal';
  }
  update(page: NativePage): void {
    if (
      this.gesture &&
      (this.gesture.signature !==
        [
          page.viewport.width,
          page.viewport.height,
          page.viewport.rotation,
          this.session.renderEpoch,
        ].join(':') ||
        this.options.tool() !== this.gesture.tool ||
        this.session.replacing ||
        this.session.status === 'conflict')
    ) {
      this.cancel();
    }
    this.page = page;
    // renderTextPdf removes editable owned ink from the raster copy; this layer draws it once.
    const strokes = this.session.snapshot.strokes.filter(
      (stroke) => stroke.page === page.number && !stroke.hidden,
    );
    const ids = new Set(strokes.map((stroke) => stroke.id));
    for (const [id, control] of this.controls) {
      if (!ids.has(id)) {
        control.dispose();
        this.controls.delete(id);
      }
    }
    this.svg.setAttribute('viewBox', `0 0 ${page.viewport.width} ${page.viewport.height}`);
    for (const stroke of strokes) {
      let control = this.controls.get(stroke.id);
      if (!control) {
        control = this.mount(stroke);
        this.controls.set(stroke.id, control);
      }
      const points =
        this.gesture?.id === stroke.id
          ? (this.gesture.inkResize?.preview ?? stroke.points)
          : stroke.points;
      const path = this.path(points);
      control.visual.setAttribute('d', path);
      control.hit.setAttribute('d', path);
      this.paint(control.visual, stroke.kind, stroke.width, stroke.color, stroke.opacity);
      control.hit.setAttribute(
        'stroke-width',
        String(Math.max(12, stroke.width * page.viewport.scale)),
      );
      const editable =
        this.options.tool() === 'select' &&
        !stroke.readOnly &&
        this.session.status !== 'conflict' &&
        !this.session.replacing;
      control.group.classList.toggle('is-interactive', editable);
      control.group.tabIndex = editable ? 0 : -1;
      const resizing = this.gesture?.id === stroke.id ? this.gesture.inkResize : undefined;
      const p = page.viewport.convertToViewportRectangle(
        resizing?.preview
          ? strokeBounds(points, stroke.width, this.session.snapshot.pages[stroke.page - 1]!)
          : stroke.rect,
      );
      control.outline.setAttribute('x', String(Math.min(p[0]!, p[2]!)));
      control.outline.setAttribute('y', String(Math.min(p[1]!, p[3]!)));
      control.outline.setAttribute('width', String(Math.abs(p[2]! - p[0]!)));
      control.outline.setAttribute('height', String(Math.abs(p[3]! - p[1]!)));
      control.outline.classList.toggle('is-selected', stroke.id === this.options.selected());
      for (const handle of control.handles) {
        const side = handle.dataset.inkResize!;
        const x = side.includes('w')
          ? Math.min(p[0]!, p[2]!)
          : side.includes('e')
            ? Math.max(p[0]!, p[2]!)
            : (p[0]! + p[2]!) / 2;
        const y = side.includes('n')
          ? Math.min(p[1]!, p[3]!)
          : side.includes('s')
            ? Math.max(p[1]!, p[3]!)
            : (p[1]! + p[3]!) / 2;
        handle.setAttribute('x', String(x - 6));
        handle.setAttribute('y', String(y - 6));
        const visible = editable && stroke.id === this.options.selected();
        handle.classList.toggle('is-selected', visible);
        handle.tabIndex = visible ? 0 : -1;
      }
    }
    if (
      this.layer.ownerDocument.activeElement === this.shortcutProxy &&
      !ids.has(this.options.selected() ?? '')
    ) {
      this.shortcutProxy.blur();
    }
    if (this.svg.lastElementChild !== this.preview) {
      this.svg.append(this.preview);
    }
  }
  private mount(stroke: InkStroke): InkControl {
    const doc = this.layer.ownerDocument;
    const group = doc.createElementNS(namespace, 'g');
    group.classList.add('pdf-form-studio-ink-control');
    group.setAttribute('role', 'button');
    group.dataset.pdfStroke = stroke.id;
    const removeLabel = labelSvgOverlay(
      group,
      this.layer,
      `${stroke.kind === 'marker' ? 'Marker' : 'Scribble'} on page ${stroke.page}. Drag to move; Delete to remove.`,
    );
    const visual = doc.createElementNS(namespace, 'path');
    visual.classList.add('pdf-form-studio-stroke');
    const hit = doc.createElementNS(namespace, 'path');
    hit.classList.add('pdf-form-studio-stroke-hit');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-linecap', 'round');
    hit.setAttribute('stroke-linejoin', 'round');
    const outline = doc.createElementNS(namespace, 'rect');
    outline.classList.add('pdf-form-studio-stroke-outline');
    group.append(visual, hit, outline);
    this.svg.append(group);
    const labels = {
      n: 'top',
      ne: 'top right',
      e: 'right',
      se: 'bottom right',
      s: 'bottom',
      sw: 'bottom left',
      w: 'left',
      nw: 'top left',
    };
    const handles = (Object.keys(labels) as ResizeHandle[]).map((side) => {
      const handle = doc.createElementNS(namespace, 'rect');
      handle.classList.add('pfs-ink-resize');
      handle.dataset.inkResize = side;
      handle.setAttribute('width', '12');
      handle.setAttribute('height', '12');
      handle.setAttribute('rx', '2');
      handle.setAttribute('role', 'button');
      handle.setAttribute('aria-label', `Resize ${labels[side]}`);
      handle.setAttribute(
        'aria-description',
        'Arrow keys resize. Shift with a corner preserves proportions.',
      );
      group.append(handle);
      return handle;
    });
    const focus = () => {
      this.options.select(stroke.id);
      this.shortcutProxy.focus({ preventScroll: true });
    };
    const pointer = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        this.options.tool() !== 'select' ||
        stroke.readOnly ||
        this.session.status === 'conflict' ||
        this.session.replacing
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
      if (!this.session.beginInkAction(this)) {
        return;
      }
      const current = this.session.snapshot.strokes.find((item) => item.id === stroke.id)!;
      const handle = (event.target as SVGElement).dataset.inkResize as ResizeHandle | undefined;
      this.gesture = {
        pointer: event.pointerId,
        tool: 'select',
        id: stroke.id,
        last: this.point(event),
        points: [],
        width: 0,
        color: stroke.color,
        ...(handle
          ? {
              inkResize: {
                stroke: structuredClone(current),
                handle,
                start: this.screenPoint(event),
                rect: screenRectangle(this.page.viewport, current.rect),
              },
            }
          : {}),
        straight: false,
        y: 0,
        signature: this.signature(),
        release: this.session.beginInteraction(),
      };
      this.options.start();
      this.options.select(stroke.id);
      this.shortcutProxy.focus({ preventScroll: true });
      this.layer.setPointerCapture(event.pointerId);
    };
    const key = (event: KeyboardEvent) => {
      const side = (event.target as SVGElement).dataset.inkResize as ResizeHandle | undefined;
      if (
        side &&
        event.key.startsWith('Arrow') &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        const delta: Record<string, Point> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const current = this.session.snapshot.strokes.find((item) => item.id === stroke.id);
        if (!current || !delta[event.key]) {
          return;
        }
        const v = this.page.viewport;
        const rect = screenRectangle(v, current.rect);
        const d = delta[event.key]!.map((n) => n * v.scale) as Point;
        const next = resizeInkFrame(
          rect,
          [0, 0, v.width, v.height],
          d,
          side,
          (2 * current.width + 1.1) * v.scale,
          event.shiftKey,
        );
        try {
          this.session.resizeStroke(
            stroke.id,
            resizeInkPoints(
              current.points,
              current.rect,
              pdfRectangle(v, [next[0], next[1]], [next[2], next[3]]),
            ),
          );
          this.options.changed();
        } catch (error) {
          this.options.error(error);
        }
      } else {
        this.keySelected(event, stroke.id);
      }
    };
    group.addEventListener('focus', focus);
    group.addEventListener('pointerdown', pointer);
    group.addEventListener('keydown', key);
    return {
      group,
      visual,
      hit,
      outline,
      handles,
      dispose: () => {
        group.removeEventListener('focus', focus);
        group.removeEventListener('pointerdown', pointer);
        group.removeEventListener('keydown', key);
        removeLabel();
        group.remove();
      },
    };
  }
  private keySelected(event: KeyboardEvent, id: string): void {
    if (
      ![
        'Delete',
        'Backspace',
        'Escape',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
      ].includes(event.key)
    ) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (event.key === 'Delete' || event.key === 'Backspace') {
      this.shortcutProxy.blur();
      this.options.remove(id);
      return;
    }
    if (event.key === 'Escape') {
      this.cancel();
      this.shortcutProxy.blur();
      this.options.select();
      return;
    }
    const direction: Record<string, Point> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const delta = direction[event.key]!;
    const [x, y] = this.screen([0, 0]);
    const v = this.page.viewport;
    const a = v.convertToPdfPoint(x, y);
    const b = v.convertToPdfPoint(x + delta[0] * v.scale, y - delta[1] * v.scale);
    try {
      this.session.moveStroke(id, [
        (b[0]! - a[0]!) * (event.shiftKey ? 10 : 1),
        (b[1]! - a[1]!) * (event.shiftKey ? 10 : 1),
      ]);
      this.options.changed();
    } catch (error) {
      this.options.error(error);
    }
  }
  private collect(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture) {
      return;
    }
    for (const sample of [...(event.getCoalescedEvents?.() ?? []), event]) {
      if (gesture.points.length >= 12000 && !gesture.resize) {
        break;
      }
      const point = this.point(sample, gesture.straight ? gesture.y : undefined);
      const last = gesture.points.at(-1);
      if (gesture.resize) {
        gesture.snapped = gesture.resize.resize(
          point,
          this.session.snapshot.pages[this.page.number - 1]!,
          2 / this.page.viewport.scale,
        );
        continue;
      }
      if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) >= 0.15) {
        gesture.points.push(point);
      }
      if (gesture.hold?.update(point, performance.now(), 2.5 / this.page.viewport.scale)) {
        gesture.holdAttempted = false;
      }
    }
  }
  private erase(from: Point, to: Point): void {
    for (const stroke of [...this.session.snapshot.strokes]) {
      if (
        stroke.page === this.page.number &&
        !stroke.readOnly &&
        hitsStroke(stroke.points, from, to, stroke.width / 2 + 6 / this.page.viewport.scale)
      ) {
        this.session.deleteStroke(stroke.id, this);
      }
    }
  }
  private down(event: PointerEvent): void {
    const tool = this.options.tool();
    if (
      event.button !== 0 ||
      event.target !== this.layer ||
      !['marker', 'scribble', 'eraser'].includes(tool) ||
      this.session.status === 'conflict' ||
      this.session.replacing
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
    if (!this.session.beginInkAction(this)) {
      return;
    }
    const kind = tool === 'marker' ? 'marker' : 'scribble';
    const box = this.layer.getBoundingClientRect();
    this.gesture = {
      pointer: event.pointerId,
      tool,
      width: this.options.width(kind),
      color: [...this.options.color(kind)],
      points: [],
      straight: tool === 'marker' && event.shiftKey,
      textWords:
        tool === 'marker' && this.options.snapText?.()
          ? (this.page.getTextWords?.() ?? [])
          : undefined,
      smooth: tool === 'scribble' && this.options.smooth(),
      hold:
        (tool === 'marker' && this.options.straightHold()) ||
        (tool === 'scribble' && this.options.shapes())
          ? new DrawHold()
          : undefined,
      y: Math.max(
        0,
        Math.min(
          this.page.viewport.height,
          ((event.clientY - box.top) * this.page.viewport.height) / box.height,
        ),
      ),
      signature: this.signature(),
      release: this.session.beginInteraction(),
    };
    this.options.start();
    this.layer.focus({ preventScroll: true });
    this.collect(event);
    this.layer.setPointerCapture(event.pointerId);
    if (tool === 'eraser') {
      const p = this.gesture.points[0]!;
      this.erase(p, p);
    } else {
      this.paintPreview();
    }
    this.scheduleHold();
  }
  private assisted(g: Gesture): Point[] {
    return (
      g.snapped?.points ??
      (g.straight ? [g.points[0]!, g.points.at(-1)!] : smoothInk(g.points, !!g.smooth))
    );
  }
  private textBands(g: Gesture): TextBand[] {
    // Fit the text while honoring the captured brush thickness as a minimum in both preview and save.
    return g.textWords
      ? snapTextBands(g.points, g.textWords).map((band) => ({
          ...band,
          width: Math.max(band.width, g.width),
        }))
      : [];
  }
  private scheduleHold(): void {
    if (this.holdTimer !== undefined || !this.gesture?.hold || this.gesture.snapped) {
      return;
    }
    this.holdTimer = this.layer.ownerDocument.defaultView!.setTimeout(() => {
      this.holdTimer = undefined;
      const g = this.gesture;
      if (!g?.hold || g.snapped) {
        return;
      }
      if (!g.holdAttempted && g.hold.ready(performance.now())) {
        g.holdAttempted = true;
        const shape = recognizeShape(g.points, g.tool === 'marker', 12 / this.page.viewport.scale);
        const b = this.session.snapshot.pages[this.page.number - 1]!;
        if (
          shape &&
          shape.points.every(([x, y]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])
        ) {
          g.snapped = shape;
          g.snapEnd = [...g.points.at(-1)!];
          g.resize = new HeldShape(shape, g.snapEnd);
          const [x, y] = this.screen(g.snapEnd);
          this.hint.textContent =
            shape.kind === 'line'
              ? 'Straight line'
              : shape.kind[0]!.toUpperCase() + shape.kind.slice(1);
          this.hint.style.left = `${Math.max(4, Math.min(this.page.viewport.width - 100, x + 12))}px`;
          this.hint.style.top = `${Math.max(4, y - 32)}px`;
          this.hint.hidden = false;
          this.paintPreview();
          return;
        }
      }
      this.scheduleHold();
    }, 100);
  }
  private paintPreview(): void {
    if (this.previewFrame !== undefined) {
      return;
    }
    this.previewFrame = this.layer.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.previewFrame = undefined;
      const g = this.gesture;
      if (!g || (g.tool !== 'marker' && g.tool !== 'scribble')) {
        return;
      }
      const bands = this.textBands(g);
      const previews = bands.length ? bands : [{ points: this.assisted(g), width: g.width }];
      while (this.snapPreviews.length < previews.length - 1) {
        const path = this.layer.ownerDocument.createElementNS(namespace, 'path');
        path.classList.add('pdf-form-studio-stroke-preview');
        this.svg.append(path);
        this.snapPreviews.push(path);
      }
      for (const [i, path] of [this.preview, ...this.snapPreviews].entries()) {
        const band = previews[i];
        if (!band) {
          path.removeAttribute('d');
          continue;
        }
        path.setAttribute('d', this.path(band.points));
        this.paint(path, g.tool, band.width, g.color);
      }
    });
  }
  private move(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointer !== event.pointerId) {
      return;
    }
    if (g.signature !== this.signature()) {
      this.cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      if (g.inkResize) {
        const r = g.inkResize;
        const p = this.screenPoint(event);
        const v = this.page.viewport;
        const next = resizeInkFrame(
          r.rect,
          [0, 0, v.width, v.height],
          [p[0] - r.start[0], p[1] - r.start[1]],
          r.handle,
          (2 * r.stroke.width + 1.1) * v.scale,
          event.shiftKey,
        );
        r.preview = resizeInkPoints(
          r.stroke.points,
          r.stroke.rect,
          pdfRectangle(v, [next[0], next[1]], [next[2], next[3]]),
        );
        this.update(this.page);
      } else if (g.tool === 'select') {
        const p = this.point(event);
        this.session.moveStroke(g.id!, [p[0] - g.last![0], p[1] - g.last![1]], this);
        g.last = p;
      } else if (g.tool === 'eraser') {
        const from = g.points.at(-1)!;
        this.collect(event);
        this.erase(from, g.points.at(-1)!);
      } else {
        this.collect(event);
        this.paintPreview();
      }
    } catch (error) {
      this.options.error(error);
      this.cancel();
    }
  }
  private up(event: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointer !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (g.signature !== this.signature()) {
      this.cancel();
      return;
    }
    if (g.tool === 'marker' || g.tool === 'scribble') {
      this.collect(event);
    } else {
      this.move(event);
    }
    this.finishPending();
  }
  finishPending(): void {
    const g = this.gesture;
    if (!g) {
      return;
    }
    // End pointer ownership before notifying subscribers; refresh can reenter.
    this.finish();
    try {
      if (g.inkResize?.preview) {
        this.session.resizeStroke(g.id!, g.inkResize.preview, this);
      }
      if ((g.tool === 'marker' || g.tool === 'scribble') && g.points.length) {
        const bands = this.textBands(g);
        if (bands.length) {
          for (const band of bands) {
            this.session.addStroke(
              this.page.number,
              'marker',
              band.points,
              band.width,
              g.color,
              this,
            );
          }
        } else {
          this.session.addStroke(
            this.page.number,
            g.tool,
            g.snapped || g.smooth || g.straight ? this.assisted(g) : simplifyStroke(g.points),
            g.width,
            g.color,
            this,
          );
        }
      }
      this.session.finishInkAction(false, this);
      this.options.changed();
    } catch (error) {
      this.session.finishInkAction(true, this);
      this.options.error(error);
    }
  }
  private finish(): void {
    if (this.holdTimer !== undefined) {
      this.layer.ownerDocument.defaultView!.clearTimeout(this.holdTimer);
    }
    this.holdTimer = undefined;
    this.hint.hidden = true;
    if (this.previewFrame !== undefined) {
      this.layer.ownerDocument.defaultView!.cancelAnimationFrame(this.previewFrame);
    }
    this.previewFrame = undefined;
    const g = this.gesture;
    this.gesture = undefined;
    this.preview.removeAttribute('d');
    g?.release();
    for (const path of this.snapPreviews) {
      path.remove();
    }
    this.snapPreviews = [];
    if (g && this.layer.hasPointerCapture(g.pointer)) {
      this.layer.releasePointerCapture(g.pointer);
    }
  }
  cancel(): void {
    const active = !!this.gesture;
    this.finish();
    if (active) {
      this.session.finishInkAction(true, this);
      this.update(this.page);
    }
  }
}
