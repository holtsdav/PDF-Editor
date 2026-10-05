import { Component, loadPdfJs } from 'obsidian';
import type { NativePage } from '../compat/native-pdf';
import type { TextSession } from '../pdf/text-session';
interface Viewport { width: number; height: number }
interface RenderTask { promise: Promise<void>; cancel(): void }
interface Page { getViewport(options: { scale: number; rotation: number }): Viewport; render(options: { canvasContext: CanvasRenderingContext2D; viewport: Viewport; annotationMode: number; transform: number[] }): RenderTask }
interface Pdf { getPage(page: number): Promise<Page> }
interface LoadingTask { promise: Promise<Pdf>; destroy(): Promise<void> }
interface Library { getDocument(options: { data: Uint8Array; isEvalSupported: boolean; enableXfa: boolean; ownerDocument: Document }): LoadingTask }
interface Backdrop { page: NativePage; wrapper: HTMLElement; canvas: HTMLCanvasElement; signature: string; render?: RenderTask; generation: number }

/** Public PDF.js rendering excludes owned ink; native links, text selection and toolbar remain in place. */
export class PdfBackdrop extends Component {
  private session: TextSession;
  private ownerDocument: Document;
  private task?: LoadingTask;
  private loading?: Promise<Pdf>;
  private epoch = -1;
  private pages = new Map<HTMLElement, Backdrop>();
  private closed = false;
  private generation = 0;
  private error: (error: unknown) => void;
  constructor(session: TextSession, ownerDocument: Document, error: (error: unknown) => void) {
    super(); this.session = session; this.ownerDocument = ownerDocument; this.error = error;
    this.register(() => { this.closed = true; this.reset(); });
  }
  private reset(): void {
    this.generation++;
    for (const entry of this.pages.values()) this.remove(entry); this.pages.clear();
    if (this.task) void this.task.destroy().catch(() => {}); this.task = undefined; this.loading = undefined;
  }
  private document(): Promise<Pdf> {
    if (!this.loading) {
      const generation = this.generation;
      this.loading = Promise.all([this.session.renderBytes(), loadPdfJs()]).then(async ([bytes, raw]) => {
        if (this.closed || generation !== this.generation) throw new Error('PDF backdrop closed.');
        this.task = (raw as Library).getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, ownerDocument: this.ownerDocument }); return this.task.promise;
      });
    }
    return this.loading;
  }
  update(pages: NativePage[]): void {
    if (this.closed) return;
    if (this.epoch !== this.session.renderEpoch) { this.reset(); this.epoch = this.session.renderEpoch; }
    const alive = new Set(pages.map(page => page.div));
    for (const [div, entry] of this.pages) if (!alive.has(div)) { this.remove(entry); this.pages.delete(div); }
    for (const page of pages) {
      const signature = [page.viewport.width, page.viewport.height, page.viewport.rotation, page.div.ownerDocument.defaultView!.devicePixelRatio].join(':');
      let entry = this.pages.get(page.div);
      if (entry && !entry.wrapper.isConnected) { this.remove(entry); this.pages.delete(page.div); entry = undefined; }
      if (!entry) {
        const wrapper = page.div.ownerDocument.createElement('div'); wrapper.className = 'pdf-form-studio-backdrop';
        const canvas = page.div.ownerDocument.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); wrapper.append(canvas); page.div.prepend(wrapper);
        entry = { page, wrapper, canvas, signature: '', generation: 0 }; this.pages.set(page.div, entry);
      }
      if (entry.signature === signature) continue;
      entry.page = page; entry.signature = signature; entry.render?.cancel(); entry.generation++;
      const generation = this.generation, version = entry.generation, current = entry;
      void this.paint(current, generation, version).catch(error => {
        if (!this.closed && this.generation === generation && current.generation === version) { current.page.div.classList.remove('pdf-form-studio-clean-page'); this.error(error); }
      });
    }
  }
  private async paint(entry: Backdrop, generation: number, version: number): Promise<void> {
    const document = await this.document(); const page = await document.getPage(entry.page.number);
    if (this.closed || generation !== this.generation || version !== entry.generation) return;
    const native = entry.page.viewport, viewport = page.getViewport({ scale: native.scale, rotation: native.rotation });
    if (Math.abs(viewport.width - native.width) > 1 || Math.abs(viewport.height - native.height) > 1) throw new Error('This PDF viewport is not supported by the live drawing backdrop.');
    const ratio = entry.canvas.ownerDocument.defaultView!.devicePixelRatio;
    const canvas = entry.canvas.ownerDocument.createElement('canvas'); canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    const task = entry.render = page.render({ canvasContext: canvas.getContext('2d')!, viewport, annotationMode: 2, transform: [ratio, 0, 0, ratio, 0, 0] });
    await task.promise;
    if (this.closed || generation !== this.generation || version !== entry.generation || !entry.wrapper.isConnected) return;
    entry.canvas.width = canvas.width; entry.canvas.height = canvas.height; entry.canvas.getContext('2d')!.drawImage(canvas, 0, 0);
    entry.page.div.classList.add('pdf-form-studio-clean-page');
  }
  private remove(entry: Backdrop): void { entry.generation++; entry.render?.cancel(); entry.page.div.classList.remove('pdf-form-studio-clean-page'); entry.wrapper.remove(); }
}
