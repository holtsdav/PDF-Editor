import { Component } from 'obsidian';
import type { NativePage } from '../compat/native-pdf';
import type { InkKind, InkStroke, Point } from '../pdf/ink-engine';
import type { PdfColor } from '../pdf/text-format';
import { hitsStroke, simplifyStroke } from '../pdf/ink-geometry';
import type { TextSession } from '../pdf/text-session';

export type EditorTool = 'select' | 'text' | 'marker' | 'scribble' | 'eraser';
interface InkOptions {
  tool(): EditorTool; width(kind: InkKind): number; color(kind: InkKind): PdfColor; selected(): string | undefined;
  select(id?: string): void; start(): void; changed(): void; remove(id: string): void; error(error: unknown): void;
}
interface InkControl { group: SVGGElement; visual: SVGPathElement; hit: SVGPathElement; outline: SVGRectElement; dispose(): void }
interface Gesture {
  pointer: number; tool: EditorTool; width: number; color: PdfColor; points: Point[]; straight: boolean; y: number;
  signature: string; release(): void; id?: string; last?: Point;
}
const namespace = 'http://www.w3.org/2000/svg';

/** Live geometry stays visible while the shared document session batches writes. */
export class InkLayer extends Component {
  private page: NativePage;
  private layer: HTMLElement;
  private svg: SVGSVGElement;
  private preview: SVGPathElement;
  private controls = new Map<string, InkControl>();
  private hiddenNative = new Set<HTMLElement>();
  private session: TextSession;
  private options: InkOptions;
  private gesture?: Gesture;

  constructor(page: NativePage, layer: HTMLElement, session: TextSession, options: InkOptions) {
    super(); this.page = page; this.layer = layer; this.session = session; this.options = options;
    const doc = layer.ownerDocument;
    this.svg = doc.createElementNS(namespace, 'svg'); this.svg.classList.add('pdf-form-studio-ink'); layer.prepend(this.svg);
    this.preview = doc.createElementNS(namespace, 'path'); this.preview.classList.add('pdf-form-studio-stroke-preview'); this.svg.append(this.preview);
    this.register(() => {
      this.cancel(); for (const control of this.controls.values()) control.dispose(); this.controls.clear(); this.svg.remove();
      for (const element of this.hiddenNative) element.classList.remove('pdf-form-studio-hidden-ink'); this.hiddenNative.clear();
    });
    this.registerDomEvent(layer, 'pointerdown', event => this.down(event));
    this.registerDomEvent(layer, 'pointermove', event => this.move(event));
    this.registerDomEvent(layer, 'pointerup', event => this.up(event));
    this.registerDomEvent(layer, 'pointercancel', () => this.cancel());
    this.registerDomEvent(layer, 'lostpointercapture', () => { if (this.gesture && !layer.hasPointerCapture(this.gesture.pointer)) this.cancel(); });
    this.registerDomEvent(layer, 'keydown', event => { if (event.key === 'Escape' && this.gesture) { event.preventDefault(); this.cancel(); } });
  }
  private signature(): string { const v = this.page.viewport; return [v.width, v.height, v.rotation].join(':'); }
  private screen(point: Point): Point { const result = this.page.viewport.convertToViewportRectangle([...point, ...point]); return [result[0]!, result[1]!]; }
  private point(event: PointerEvent, straightY?: number): Point {
    const box = this.layer.getBoundingClientRect(), v = this.page.viewport;
    const x = Math.max(0, Math.min(v.width, (event.clientX - box.left) * v.width / box.width));
    const y = straightY ?? Math.max(0, Math.min(v.height, (event.clientY - box.top) * v.height / box.height));
    const result = v.convertToPdfPoint(x, y), b = this.session.snapshot.pages[this.page.number - 1]!;
    return [Math.max(b[0], Math.min(b[2], result[0]!)), Math.max(b[1], Math.min(b[3], result[1]!))];
  }
  private path(points: Point[]): string {
    if (points.every(point => Math.hypot(point[0] - points[0]![0], point[1] - points[0]![1]) < 0.001)) { const [x, y] = this.screen(points[0]!); return `M${x},${y} l0.001,0`; }
    return points.map((point, i) => { const [x, y] = this.screen(point); return `${i ? 'L' : 'M'}${x},${y}`; }).join(' ');
  }
  private paint(path: SVGPathElement, kind: InkKind, width: number, color: PdfColor, opacity = kind === 'marker' ? 0.4 : 1): void {
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', `rgb(${color.map(c => c * 255).join(' ')})`);
    path.setAttribute('stroke-width', String(width * this.page.viewport.scale));
    path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('opacity', String(opacity));
    path.style.mixBlendMode = kind === 'marker' ? 'multiply' : 'normal';
  }
  update(page: NativePage): void {
    this.page = page;
    if (this.gesture && (this.gesture.signature !== this.signature() || this.options.tool() !== this.gesture.tool)) this.cancel();
    const strokes = this.session.snapshot.strokes.filter(stroke => stroke.page === page.number), ids = new Set(strokes.map(stroke => stroke.id));
    for (const [id, control] of this.controls) if (!ids.has(id)) { control.dispose(); this.controls.delete(id); }
    for (const element of this.hiddenNative) if (!element.isConnected) this.hiddenNative.delete(element);
    this.svg.setAttribute('viewBox', `0 0 ${page.viewport.width} ${page.viewport.height}`);
    for (const stroke of strokes) {
      if (stroke.annotationId) for (const element of page.annotationElements(stroke.annotationId)) { element.classList.add('pdf-form-studio-hidden-ink'); this.hiddenNative.add(element); }
      let control = this.controls.get(stroke.id); if (!control) { control = this.mount(stroke); this.controls.set(stroke.id, control); }
      const path = this.path(stroke.points); control.visual.setAttribute('d', path); control.hit.setAttribute('d', path);
      this.paint(control.visual, stroke.kind, stroke.width, stroke.color, stroke.opacity);
      control.hit.setAttribute('stroke-width', String(Math.max(12, stroke.width * page.viewport.scale)));
      const editable = this.options.tool() === 'select' && !stroke.readOnly && this.session.status !== 'conflict';
      control.group.classList.toggle('is-interactive', editable); control.group.tabIndex = editable ? 0 : -1;
      const p = page.viewport.convertToViewportRectangle(stroke.rect);
      control.outline.setAttribute('x', String(Math.min(p[0]!, p[2]!))); control.outline.setAttribute('y', String(Math.min(p[1]!, p[3]!)));
      control.outline.setAttribute('width', String(Math.abs(p[2]! - p[0]!))); control.outline.setAttribute('height', String(Math.abs(p[3]! - p[1]!)));
      control.outline.classList.toggle('is-selected', stroke.id === this.options.selected());
    }
    if (this.svg.lastElementChild !== this.preview) this.svg.append(this.preview);
  }
  private mount(stroke: InkStroke): InkControl {
    const doc = this.layer.ownerDocument;
    const group = doc.createElementNS(namespace, 'g'); group.classList.add('pdf-form-studio-ink-control'); group.setAttribute('role', 'button');
    group.setAttribute('aria-label', `${stroke.kind === 'marker' ? 'Marker' : 'Scribble'} on page ${stroke.page}. Drag to move; Delete to remove.`);
    const visual = doc.createElementNS(namespace, 'path'); visual.classList.add('pdf-form-studio-stroke');
    const hit = doc.createElementNS(namespace, 'path'); hit.classList.add('pdf-form-studio-stroke-hit'); hit.setAttribute('fill', 'none'); hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-linecap', 'round'); hit.setAttribute('stroke-linejoin', 'round');
    const outline = doc.createElementNS(namespace, 'rect'); outline.classList.add('pdf-form-studio-stroke-outline'); group.append(visual, hit, outline); this.svg.append(group);
    let release: (() => void) | undefined;
    const focus = () => { release?.(); release = this.session.beginInteraction(); this.options.select(stroke.id); };
    const blur = () => { release?.(); release = undefined; this.options.changed(); };
    const pointer = (event: PointerEvent) => {
      if (event.button !== 0 || this.options.tool() !== 'select' || stroke.readOnly || this.session.status === 'conflict') return;
      event.preventDefault(); event.stopPropagation(); this.cancel(); this.session.beginInkAction();
      this.gesture = { pointer: event.pointerId, tool: 'select', id: stroke.id, last: this.point(event), points: [], width: 0, color: stroke.color,
        straight: false, y: 0, signature: this.signature(), release: this.session.beginInteraction() };
      this.options.start(); group.focus({ preventScroll: true }); this.options.select(stroke.id); this.layer.setPointerCapture(event.pointerId);
    };
    const key = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.options.remove(stroke.id); }
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); group.blur(); this.options.select(); }
      const direction: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const delta = direction[event.key];
      if (delta) {
        event.preventDefault(); const [x, y] = this.screen([0, 0]); const v = this.page.viewport;
        const a = v.convertToPdfPoint(x, y), b = v.convertToPdfPoint(x + delta[0] * v.scale, y - delta[1] * v.scale);
        try { this.session.moveStroke(stroke.id, [(b[0]! - a[0]!) * (event.shiftKey ? 10 : 1), (b[1]! - a[1]!) * (event.shiftKey ? 10 : 1)]); this.options.changed(); }
        catch (error) { this.options.error(error); }
      }
    };
    group.addEventListener('focus', focus); group.addEventListener('blur', blur); group.addEventListener('pointerdown', pointer); group.addEventListener('keydown', key);
    return { group, visual, hit, outline, dispose: () => { release?.(); group.removeEventListener('focus', focus); group.removeEventListener('blur', blur); group.removeEventListener('pointerdown', pointer); group.removeEventListener('keydown', key); group.remove(); } };
  }
  private collect(event: PointerEvent): void {
    const gesture = this.gesture; if (!gesture) return;
    for (const sample of [...(event.getCoalescedEvents?.() ?? []), event]) {
      if (gesture.points.length >= 12000) break;
      const point = this.point(sample, gesture.straight ? gesture.y : undefined), last = gesture.points.at(-1);
      if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) >= 0.15) gesture.points.push(point);
    }
  }
  private erase(from: Point, to: Point): void {
    for (const stroke of [...this.session.snapshot.strokes]) if (stroke.page === this.page.number && !stroke.readOnly && hitsStroke(stroke.points, from, to, stroke.width / 2 + 6 / this.page.viewport.scale)) this.session.deleteStroke(stroke.id);
  }
  private down(event: PointerEvent): void {
    const tool = this.options.tool();
    if (event.button !== 0 || event.target !== this.layer || !['marker', 'scribble', 'eraser'].includes(tool) || this.session.status === 'conflict') return;
    event.preventDefault(); event.stopPropagation(); this.cancel(); this.session.beginInkAction();
    const kind = tool === 'marker' ? 'marker' : 'scribble'; const box = this.layer.getBoundingClientRect();
    this.gesture = { pointer: event.pointerId, tool, width: this.options.width(kind), color: [...this.options.color(kind)], points: [], straight: tool === 'marker' && event.shiftKey,
      y: Math.max(0, Math.min(this.page.viewport.height, (event.clientY - box.top) * this.page.viewport.height / box.height)), signature: this.signature(), release: this.session.beginInteraction() };
    this.options.start(); this.layer.focus({ preventScroll: true }); this.collect(event); this.layer.setPointerCapture(event.pointerId);
    if (tool === 'eraser') { const p = this.gesture.points[0]!; this.erase(p, p); } else this.paintPreview();
  }
  private paintPreview(): void {
    const g = this.gesture; if (!g || (g.tool !== 'marker' && g.tool !== 'scribble')) return;
    this.preview.setAttribute('d', this.path(g.straight ? [g.points[0]!, g.points.at(-1)!] : g.points)); this.paint(this.preview, g.tool, g.width, g.color);
  }
  private move(event: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointer !== event.pointerId) return;
    if (g.signature !== this.signature()) { this.cancel(); return; }
    event.preventDefault(); event.stopPropagation();
    try {
      if (g.tool === 'select') { const p = this.point(event); this.session.moveStroke(g.id!, [p[0] - g.last![0], p[1] - g.last![1]]); g.last = p; }
      else if (g.tool === 'eraser') { const from = g.points.at(-1)!; this.collect(event); this.erase(from, g.points.at(-1)!); }
      else { this.collect(event); this.paintPreview(); }
    } catch (error) { this.options.error(error); this.cancel(); }
  }
  private up(event: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    try {
      if (g.signature !== this.signature()) return;
      if (g.tool === 'marker' || g.tool === 'scribble') { this.collect(event); this.session.addStroke(this.page.number, g.tool, g.straight ? [g.points[0]!, g.points.at(-1)!] : simplifyStroke(g.points), g.width, g.color); }
      else this.move(event);
      this.session.finishInkAction(); this.options.changed(); this.finish();
    } catch (error) { this.options.error(error); this.cancel(); }
  }
  private finish(): void {
    const g = this.gesture; this.gesture = undefined; this.preview.removeAttribute('d'); g?.release();
    if (g && this.layer.hasPointerCapture(g.pointer)) this.layer.releasePointerCapture(g.pointer);
  }
  cancel(): void { if (this.gesture) this.session.finishInkAction(true); this.finish(); }
}
