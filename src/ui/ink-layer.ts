import { Component } from 'obsidian';
import type { NativePage } from '../compat/native-pdf';
import type { InkKind, InkStroke, Point } from '../pdf/ink-engine';
import { simplifyStroke } from '../pdf/ink-geometry';
import type { TextSession } from '../pdf/text-session';

export type EditorTool = 'select' | 'text' | 'marker' | 'scribble';
interface InkOptions {
  tool(): EditorTool; width(kind: InkKind): number; selected(): string | undefined;
  select(id?: string): void; start(): void; changed(): void; remove(id: string): void; error(error: unknown): void;
}
interface InkControl { group: SVGGElement; visual: SVGPathElement; hit: SVGPathElement; outline: SVGRectElement; dispose(): void }
const namespace = 'http://www.w3.org/2000/svg';

/** Page-local ink interaction; persistence and document history stay in the shared session. */
export class InkLayer extends Component {
  private page: NativePage;
  private layer: HTMLElement;
  private svg: SVGSVGElement;
  private preview: SVGPathElement;
  private controls = new Map<string, InkControl>();
  private session: TextSession;
  private options: InkOptions;
  private gesture?: { pointer: number; kind: InkKind; width: number; points: Point[]; straight: boolean; y: number; signature: string; release(): void };

  constructor(page: NativePage, layer: HTMLElement, session: TextSession, options: InkOptions) {
    super(); this.page = page; this.layer = layer; this.session = session; this.options = options;
    const doc = layer.ownerDocument;
    this.svg = doc.createElementNS(namespace, 'svg'); this.svg.classList.add('pdf-form-studio-ink'); layer.prepend(this.svg);
    this.preview = doc.createElementNS(namespace, 'path'); this.preview.classList.add('pdf-form-studio-stroke-preview'); this.svg.append(this.preview);
    this.register(() => { this.cancel(); for (const control of this.controls.values()) control.dispose(); this.controls.clear(); this.svg.remove(); });
    this.registerDomEvent(layer, 'pointerdown', event => this.down(event));
    this.registerDomEvent(layer, 'pointermove', event => this.move(event));
    this.registerDomEvent(layer, 'pointerup', event => this.up(event));
    this.registerDomEvent(layer, 'pointercancel', () => this.cancel());
    this.registerDomEvent(layer, 'lostpointercapture', () => { if (this.gesture && !layer.hasPointerCapture(this.gesture.pointer)) this.cancel(); });
  }

  private signature(): string { const v = this.page.viewport; return [v.width, v.height, v.rotation].join(':'); }
  private screen(point: Point): Point {
    const result = this.page.viewport.convertToViewportRectangle([...point, ...point]); return [result[0]!, result[1]!];
  }
  private path(points: Point[]): string {
    if (points.every(point => Math.hypot(point[0] - points[0]![0], point[1] - points[0]![1]) < 0.001)) {
      const [x, y] = this.screen(points[0]!); return `M${x},${y} l0.001,0`;
    }
    return points.map((point, i) => { const [x, y] = this.screen(point); return `${i ? 'L' : 'M'}${x},${y}`; }).join(' ');
  }
  private paint(path: SVGPathElement, kind: InkKind, width: number, color?: InkStroke['color'], opacity?: number): void {
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color ? `rgb(${color.map(c => c * 255).join(' ')})` : kind === 'marker' ? '#ffd600' : '#161616');
    path.setAttribute('stroke-width', String(width * this.page.viewport.scale));
    path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('opacity', String(opacity ?? (kind === 'marker' ? 0.4 : 1)));
    path.style.mixBlendMode = kind === 'marker' ? 'multiply' : 'normal';
  }

  update(page: NativePage): void {
    this.page = page;
    if (this.gesture && (this.gesture.signature !== this.signature() || this.options.tool() !== this.gesture.kind)) this.cancel();
    const strokes = this.session.snapshot.strokes.filter(stroke => stroke.page === page.number);
    const ids = new Set(strokes.map(stroke => stroke.id));
    for (const [id, control] of this.controls) if (!ids.has(id)) { control.dispose(); this.controls.delete(id); }
    this.svg.setAttribute('viewBox', `0 0 ${page.viewport.width} ${page.viewport.height}`);
    for (const stroke of strokes) {
      let control = this.controls.get(stroke.id);
      if (!control) { control = this.mount(stroke); this.controls.set(stroke.id, control); }
      const path = this.path(stroke.points); control.visual.setAttribute('d', path); control.hit.setAttribute('d', path);
      // Keep the pending preview until the native annotation layer has caught up,
      // then let the saved PDF appearance supply the visible stroke exactly once.
      const rendered = stroke.annotationId && page.hasRenderedAnnotation(stroke.annotationId);
      this.paint(control.visual, stroke.kind, stroke.width, stroke.color, rendered ? 0 : stroke.opacity);
      control.hit.setAttribute('stroke-width', String(Math.max(12, stroke.width * page.viewport.scale)));
      const editable = this.options.tool() === 'select' && !stroke.readOnly && this.session.status !== 'conflict';
      control.group.classList.toggle('is-interactive', editable); control.group.tabIndex = editable ? 0 : -1;
      const points = page.viewport.convertToViewportRectangle(stroke.rect);
      const left = Math.min(points[0]!, points[2]!), top = Math.min(points[1]!, points[3]!);
      control.outline.setAttribute('x', String(left)); control.outline.setAttribute('y', String(top));
      control.outline.setAttribute('width', String(Math.abs(points[2]! - points[0]!)));
      control.outline.setAttribute('height', String(Math.abs(points[3]! - points[1]!)));
      control.outline.classList.toggle('is-selected', stroke.id === this.options.selected());
    }
    if (this.svg.lastElementChild !== this.preview) this.svg.append(this.preview);
  }

  private mount(stroke: InkStroke): InkControl {
    const doc = this.layer.ownerDocument;
    const group = doc.createElementNS(namespace, 'g'); group.classList.add('pdf-form-studio-ink-control'); group.setAttribute('role', 'button');
    group.setAttribute('aria-label', `${stroke.kind === 'marker' ? 'Marker' : 'Scribble'} on page ${stroke.page}. Delete to remove.`);
    const visual = doc.createElementNS(namespace, 'path'); visual.classList.add('pdf-form-studio-stroke');
    const hit = doc.createElementNS(namespace, 'path'); hit.classList.add('pdf-form-studio-stroke-hit'); hit.setAttribute('fill', 'none'); hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-linecap', 'round'); hit.setAttribute('stroke-linejoin', 'round');
    const outline = doc.createElementNS(namespace, 'rect'); outline.classList.add('pdf-form-studio-stroke-outline');
    group.append(visual, hit, outline); this.svg.append(group);
    let release: (() => void) | undefined;
    const focus = () => { release?.(); release = this.session.beginInteraction(); this.options.select(stroke.id); };
    const blur = () => { release?.(); release = undefined; this.options.changed(); };
    const pointer = (event: PointerEvent) => { if (this.options.tool() !== 'select') return; event.preventDefault(); event.stopPropagation(); group.focus({ preventScroll: true }); this.options.select(stroke.id); };
    const key = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.options.remove(stroke.id); }
      if (event.key === 'Escape') { event.preventDefault(); group.blur(); this.options.select(); }
    };
    group.addEventListener('focus', focus); group.addEventListener('blur', blur);
    group.addEventListener('pointerdown', pointer); group.addEventListener('keydown', key);
    return { group, visual, hit, outline, dispose: () => {
      release?.(); group.removeEventListener('focus', focus); group.removeEventListener('blur', blur);
      group.removeEventListener('pointerdown', pointer); group.removeEventListener('keydown', key); group.remove();
    } };
  }

  private collect(event: PointerEvent): void {
    const gesture = this.gesture; if (!gesture) return;
    const box = this.layer.getBoundingClientRect(), v = this.page.viewport;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of [...samples, event]) {
      if (gesture.points.length >= 12000) break;
      const x = Math.max(0, Math.min(v.width, (sample.clientX - box.left) * v.width / box.width));
      const y = gesture.straight ? gesture.y : Math.max(0, Math.min(v.height, (sample.clientY - box.top) * v.height / box.height));
      const result = v.convertToPdfPoint(x, y); const point: Point = [result[0]!, result[1]!];
      const last = gesture.points.at(-1);
      if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) >= 0.15) gesture.points.push(point);
    }
  }

  private down(event: PointerEvent): void {
    const kind = this.options.tool();
    if (event.button !== 0 || event.target !== this.layer || (kind !== 'marker' && kind !== 'scribble') || this.session.status === 'conflict') return;
    event.preventDefault(); event.stopPropagation(); this.cancel();
    const box = this.layer.getBoundingClientRect();
    this.gesture = { pointer: event.pointerId, kind, width: this.options.width(kind), points: [], straight: kind === 'marker' && event.shiftKey,
      y: Math.max(0, Math.min(this.page.viewport.height, (event.clientY - box.top) * this.page.viewport.height / box.height)),
      signature: this.signature(), release: this.session.beginInteraction() };
    this.options.start(); this.layer.focus({ preventScroll: true }); this.collect(event); this.layer.setPointerCapture(event.pointerId); this.paintPreview();
  }
  private paintPreview(): void {
    const gesture = this.gesture; if (!gesture) return;
    const points = gesture.straight ? [gesture.points[0]!, gesture.points.at(-1)!] : gesture.points;
    this.preview.setAttribute('d', this.path(points)); this.paint(this.preview, gesture.kind, gesture.width);
  }
  private move(event: PointerEvent): void {
    if (!this.gesture || this.gesture.pointer !== event.pointerId) return;
    if (this.gesture.signature !== this.signature()) { this.cancel(); return; }
    event.preventDefault(); event.stopPropagation(); this.collect(event); this.paintPreview();
  }
  private up(event: PointerEvent): void {
    const gesture = this.gesture; if (!gesture || gesture.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    try {
      if (gesture.signature !== this.signature()) return;
      this.collect(event);
      const points = gesture.straight ? [gesture.points[0]!, gesture.points.at(-1)!] : simplifyStroke(gesture.points);
      this.session.addStroke(this.page.number, gesture.kind, points, gesture.width); this.options.changed();
    } catch (error) { this.options.error(error); }
    finally { this.cancel(); }
  }
  cancel(): void {
    const gesture = this.gesture; this.gesture = undefined; this.preview.removeAttribute('d');
    gesture?.release();
    if (gesture && this.layer.hasPointerCapture(gesture.pointer)) this.layer.releasePointerCapture(gesture.pointer);
  }
}
