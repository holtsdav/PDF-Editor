import { Component, Scope } from 'obsidian';
import type { App } from 'obsidian';
import { labelOverlay } from './overlay-label';
import type { NativePage } from '../compat/native-pdf';
import { pdfRectangle, screenRectangle } from '../compat/native-pdf';
import type { Point } from '../pdf/ink-engine';
import { hitsStroke } from '../pdf/ink-geometry';
import type { Rect } from '../pdf/text-engine';
import type { PdfObject, TextSession } from '../pdf/text-session';

interface Options {
  enabled(): boolean; changed(): void; save(): void; error(error: unknown): void; endTyping(): void;
  floatingToolbar(): HTMLElement | undefined;
  shortcut(key: string, event: KeyboardEvent): boolean;
}
interface PageSelection { page: NativePage; layer: HTMLElement; overlay: HTMLElement; dispose(): void }
interface Gesture {
  entry: PageSelection; pointer: number; start: Point; end: Point; move: boolean; additive: boolean;
  signature: string; model: string; release(): void;
}
const key = (object: PdfObject) => object.kind + ':' + object.id;
const intersects = (a: Rect, b: Rect) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Page background captures never cover the PDF text layer or editable inputs. */
export class ObjectSelection extends Component {
  objects: PdfObject[] = [];
  private pages = new Map<HTMLElement, PageSelection>();
  private gesture?: Gesture;
  private scope?: Scope;
  private scopeActive = false;
  private claims: (() => void)[] = [];
  constructor(private session: TextSession, private root: HTMLElement, private options: Options, private app?: App) {
    super();
    const doc = root.ownerDocument;
    if (app?.keymap) {
      const scope = this.scope = new Scope(app.scope);
      for (const redo of [false, true]) scope.register(redo ? ['Mod', 'Shift'] : ['Mod'], 'z', event => {
        try { if (redo) this.session.redoStroke(); else this.session.undoStroke(); this.options.save(); }
        catch (error) { this.options.error(error); }
        event.preventDefault(); event.stopImmediatePropagation(); return false;
      });
      for (const key of ['c', 'v', 'd']) scope.register(['Mod'], key, event => {
        if (this.options.shortcut(key, event)) return false;
        return undefined;
      });
    }
    this.registerDomEvent(doc, 'pointerdown', event => {
      const target = event.target;
      if (target instanceof doc.defaultView!.Element && !this.withinEditor(target) && !target.closest('.pfs-tool-popover')) this.clear();
    }, true);
    this.registerDomEvent(doc, 'focusin', event => {
      const target = event.target;
      if (target instanceof doc.defaultView!.Element && (!this.withinEditor(target) || target.matches('input, textarea'))) this.clear();
    });
    this.registerDomEvent(doc.defaultView!, 'keydown', event => this.keyDown(event), true);
    this.register(() => { this.cancel(); this.clear(); for (const entry of this.pages.values()) entry.dispose(); this.pages.clear(); });
  }
  get active(): boolean { return !!this.gesture || this.objects.length > 0; }
  private withinEditor(target: Element): boolean { return this.root.contains(target) || !!this.options.floatingToolbar()?.contains(target); }
  has(kind: PdfObject['kind'], id: string): boolean { return this.objects.some(object => object.kind === kind && object.id === id); }
  clear(): void { if (this.objects.length) this.set([]); }
  selectObjects(objects: PdfObject[]): void { this.cancel(); this.set(objects); }
  private set(objects: PdfObject[]): void {
    const unique = [...new Map(objects.map(object => [key(object), object])).values()];
    const claims = unique.filter(object => object.kind === 'text').map(object => this.session.beginTextEdit(object.id));
    const old = this.objects; this.objects = unique;
    if (this.scope && !!unique.length !== this.scopeActive) {
      this.scopeActive = !!unique.length;
      if (this.scopeActive) this.app!.keymap.pushScope(this.scope); else this.app!.keymap.popScope(this.scope);
    }
    for (const release of this.claims) release(); this.claims = claims;
    for (const object of old) if (object.kind === 'text' && !this.has('text', object.id)) this.session.pruneEmptyBoxes(object.id);
    if (unique.length) this.options.endTyping();
    this.options.changed(); this.paint();
  }
  private items(page: number): { object: PdfObject; rect: Rect }[] {
    const text = this.session.snapshot.fields.filter(field => field.owned && !field.readOnly && field.widgets.length === 1 && field.widgets[0]!.page === page)
      .map(field => ({ object: { kind: 'text' as const, id: field.name }, rect: field.widgets[0]!.rect }));
    const ink = this.session.snapshot.strokes.filter(stroke => stroke.page === page && !stroke.readOnly && !stroke.hidden)
      .map(stroke => ({ object: { kind: 'ink' as const, id: stroke.id }, rect: stroke.rect }));
    return [...text, ...ink];
  }
  private model(): string { return JSON.stringify(this.session.snapshot.pages.map((_, i) => this.items(i + 1).filter(item => this.has(item.object.kind, item.object.id)))); }
  private signature(entry: PageSelection): string { const v = entry.page.viewport; return [v.width, v.height, v.rotation, this.session.renderEpoch].join(':'); }
  private point(entry: PageSelection, event: PointerEvent): Point {
    const b = entry.page.div.getBoundingClientRect(), v = entry.page.viewport;
    return [Math.max(0, Math.min(v.width, (event.clientX - b.left) * v.width / b.width)), Math.max(0, Math.min(v.height, (event.clientY - b.top) * v.height / b.height))];
  }
  update(pages: NativePage[]): void {
    const alive = new Set(pages.map(page => page.div));
    for (const [div, entry] of this.pages) if (!alive.has(div)) { if (this.gesture?.entry === entry) this.cancel(); entry.dispose(); this.pages.delete(div); }
    for (const page of pages) {
      let entry = this.pages.get(page.div);
      if (!entry) { entry = this.bind(page); this.pages.set(page.div, entry); } else entry.page = page;
    }
    if (this.gesture && (!this.options.enabled() || !this.session.canEditObjects || this.gesture.signature !== this.signature(this.gesture.entry) || this.gesture.model !== this.model())) this.cancel();
    const ids = new Set(this.session.snapshot.pages.flatMap((_, i) => this.items(i + 1).map(item => key(item.object))));
    const next = this.objects.filter(object => ids.has(key(object)));
    if (next.length !== this.objects.length) this.set(next);
    this.paint();
  }
  private bind(page: NativePage): PageSelection {
    const doc = page.div.ownerDocument, overlay = doc.createElement('div');
    overlay.className = 'pfs-object-selection'; overlay.hidden = true; overlay.setAttribute('aria-hidden', 'true'); page.div.append(overlay);
    const layer = page.div.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
    const entry: PageSelection = { page, layer, overlay, dispose: () => {} };
    const down = (event: PointerEvent) => {
      if (!this.options.enabled() || event.button !== 0 || !this.session.canEditObjects) return;
      const target = event.target as Element;
      if (target.closest('a, button, .pfs-text-layer span, .textLayer span, .annotationLayer, .pfs-answer-suggestions') || target.closest('.is-editing')) { this.clear(); return; }
      if (!event.shiftKey && target.closest('.is-answer-field') && !target.closest('[data-resize], [data-edge]')) { this.clear(); return; }
      const field = target.closest('.pdf-form-studio-box')?.querySelector<HTMLElement>('[data-pdf-field]')?.dataset.pdfField;
      const stroke = target.closest<SVGElement>('[data-pdf-stroke]')?.dataset.pdfStroke;
      const object: PdfObject | undefined = field ? { kind: 'text', id: field } : stroke ? { kind: 'ink', id: stroke } : undefined;
      if (object && !this.items(page.number).some(item => key(item.object) === key(object))) { this.clear(); return; }
      if (object && event.shiftKey) {
        event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); doc.defaultView!.getSelection()?.removeAllRanges();
        this.set(this.has(object.kind, object.id) ? this.objects.filter(item => key(item) !== key(object)) : [...this.objects, object]);
        layer.focus({ preventScroll: true }); return;
      }
      if (object && !this.has(object.kind, object.id)) { this.clear(); return; }
      if (!object && target.closest('.pdf-form-studio-box, .pdf-form-studio-ink-control')) return;
      // A blank-space drag starts a marquee. Native printed text remains untouched.
      event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); doc.defaultView!.getSelection()?.removeAllRanges();
      const start = this.point(entry, event);
      this.gesture = { entry, pointer: event.pointerId, start, end: start, move: !!object, additive: event.shiftKey, signature: this.signature(entry), model: this.model(), release: this.session.beginInteraction() };
      layer.focus({ preventScroll: true }); page.div.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      const g = this.gesture; if (!g || g.entry !== entry || g.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (g.signature !== this.signature(entry) || g.model !== this.model() || !this.options.enabled() || !this.session.canEditObjects) { this.cancel(); return; }
      g.end = this.point(entry, event); this.paint();
    };
    const up = (event: PointerEvent) => {
      const g = this.gesture; if (!g || g.entry !== entry || g.pointer !== event.pointerId) return;
      move(event); if (this.gesture !== g) return;
      try {
        if (g.move) { const delta = this.delta(g); this.cancel(); this.session.moveObjects(this.objects, delta); this.options.save(); }
        else {
          const rect = pdfRectangle(entry.page.viewport, g.start, g.end);
          const dragged = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]) >= 3;
          const hits = dragged ? this.items(entry.page.number).filter(item => intersects(item.rect, rect) && (item.object.kind === 'text' || this.hitsInk(item.object.id, rect))).map(item => item.object) : [];
          this.cancel(); this.set(g.additive ? [...this.objects, ...hits] : hits);
        }
      } catch (error) { this.cancel(); this.options.error(error); }
    };
    const cancel = () => { if (this.gesture?.entry === entry) this.cancel(); };
    const lost = () => { if (this.gesture?.entry === entry && !page.div.hasPointerCapture(this.gesture.pointer)) this.cancel(); };
    page.div.addEventListener('pointerdown', down, true); page.div.addEventListener('pointermove', move, true); page.div.addEventListener('pointerup', up, true);
    page.div.addEventListener('pointercancel', cancel); page.div.addEventListener('lostpointercapture', lost);
    entry.dispose = () => {
      page.div.removeEventListener('pointerdown', down, true); page.div.removeEventListener('pointermove', move, true); page.div.removeEventListener('pointerup', up, true);
      page.div.removeEventListener('pointercancel', cancel); page.div.removeEventListener('lostpointercapture', lost); overlay.remove();
    };
    return entry;
  }
  private hitsInk(id: string, rect: Rect): boolean {
    const stroke = this.session.snapshot.strokes.find(stroke => stroke.id === id)!;
    return stroke.points.some(([x, y]) => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3])
      || [[[rect[0], rect[1]], [rect[2], rect[1]]], [[rect[2], rect[1]], [rect[2], rect[3]]], [[rect[2], rect[3]], [rect[0], rect[3]]], [[rect[0], rect[3]], [rect[0], rect[1]]]]
        .some(edge => hitsStroke(stroke.points, edge[0] as Point, edge[1] as Point, stroke.width / 2));
  }
  private delta(g: Gesture): Point {
    const v = g.entry.page.viewport, a = v.convertToPdfPoint(...g.start), b = v.convertToPdfPoint(...g.end);
    return this.session.objectDelta(this.objects, [b[0]! - a[0]!, b[1]! - a[1]!]);
  }
  private paint(): void {
    for (const entry of this.pages.values()) {
      const g = this.gesture?.entry === entry ? this.gesture : undefined;
      let rect: Rect | undefined;
      if (g && !g.move) rect = [Math.min(g.start[0], g.end[0]), Math.min(g.start[1], g.end[1]), Math.max(g.start[0], g.end[0]), Math.max(g.start[1], g.end[1])];
      else for (const item of this.items(entry.page.number).filter(item => this.has(item.object.kind, item.object.id))) {
        const box = screenRectangle(entry.page.viewport, item.rect);
        rect = rect ? [Math.min(rect[0], box[0]), Math.min(rect[1], box[1]), Math.max(rect[2], box[2]), Math.max(rect[3], box[3])] : box;
      }
      let dx = 0, dy = 0;
      if (g?.move) {
        const delta = this.delta(g), v = entry.page.viewport, a = v.convertToViewportRectangle([0, 0, ...delta]); dx = a[2]! - a[0]!; dy = a[3]! - a[1]!;
      }
      for (const frame of entry.layer.querySelectorAll<HTMLElement>('.pdf-form-studio-box')) {
        const selected = this.has('text', frame.querySelector<HTMLElement>('[data-pdf-field]')?.dataset.pdfField ?? '');
        frame.classList.toggle('is-multi-selected', selected); frame.style.translate = selected ? `${dx}px ${dy}px` : '';
      }
      for (const group of entry.layer.querySelectorAll<SVGElement>('[data-pdf-stroke]')) {
        const selected = this.has('ink', group.dataset.pdfStroke!); group.classList.toggle('is-multi-selected', selected);
        if (selected && g?.move) group.setAttribute('transform', `translate(${dx} ${dy})`); else group.removeAttribute('transform');
      }
      entry.overlay.hidden = !rect; entry.overlay.classList.toggle('is-marquee', !!g && !g.move);
      if (rect) Object.assign(entry.overlay.style, { left: `${rect[0] + dx}px`, top: `${rect[1] + dy}px`, width: `${rect[2] - rect[0]}px`, height: `${rect[3] - rect[1]}px` });
      labelOverlay(entry.layer, this.objects.length ? `${this.objects.length} PDF objects selected. Drag a selected object to move the group; Delete removes it.` : 'PDF editing layer');
    }
  }
  cancel(): void {
    const g = this.gesture; this.gesture = undefined; g?.release();
    if (g?.entry.page.div.hasPointerCapture(g.pointer)) g.entry.page.div.releasePointerCapture(g.pointer);
    this.paint();
  }
  remove(): void { if (!this.objects.length) return; this.cancel(); this.session.deleteObjects(this.objects); this.clear(); this.options.save(); }
  private keyDown(event: KeyboardEvent): void {
    const doc = this.root.ownerDocument, target = event.target;
    if (!(target instanceof doc.defaultView!.Element) || (!this.withinEditor(target) && target !== doc.body && target !== doc.documentElement) || target.matches('input, textarea') || !this.objects.length) return;
    try {
      if (event.key === 'Escape') { this.cancel(); this.clear(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); this.remove(); return; }
      const directions: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key]; if (!direction || event.metaKey || event.ctrlKey || event.altKey) return;
      const entry = [...this.pages.values()].find(entry => entry.layer.contains(target)) ?? [...this.pages.values()].find(entry => this.items(entry.page.number).some(item => this.has(item.object.kind, item.object.id))); if (!entry) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const v = entry.page.viewport, a = v.convertToPdfPoint(0, 0), step = v.scale * (event.shiftKey ? 10 : 1), b = v.convertToPdfPoint(direction[0] * step, direction[1] * step);
      this.session.moveObjects(this.objects, [b[0]! - a[0]!, b[1]! - a[1]!]); this.options.save();
    } catch (error) { this.cancel(); this.options.error(error); }
  }
}
