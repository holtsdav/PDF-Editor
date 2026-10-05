import { App, Modal, loadPdfJs, setIcon, setTooltip } from 'obsidian';
interface RenderTask { promise: Promise<void>; cancel(): void }
interface Page { getViewport(options: { scale: number }): { width: number; height: number }; render(options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): RenderTask }
interface Document { numPages: number; getPage(page: number): Promise<Page> }
interface LoadingTask { promise: Promise<Document>; destroy(): Promise<void> }
interface Library { getDocument(options: { data: Uint8Array; isEvalSupported: boolean; ownerDocument: globalThis.Document }): LoadingTask }

/** Hidden recovery files remain outside the vault's note tree and are previewed read only. */
export class RecoveryPreview extends Modal {
  private read: () => Promise<Uint8Array>;
  private task?: LoadingTask;
  private render?: RenderTask;
  private closed = false;
  private generation = 0;
  constructor(app: App, read: () => Promise<Uint8Array>) { super(app); this.read = read; }
  onOpen(): void {
    this.setTitle('Original PDF'); this.contentEl.createEl('p', { text: 'Loading recovery copy…' });
    void this.openPreview().catch(error => { if (!this.closed) { this.contentEl.empty(); this.contentEl.createEl('p', { text: String(error) }); } });
  }
  private async openPreview(): Promise<void> {
    const [bytes, raw] = await Promise.all([this.read(), loadPdfJs()]); if (this.closed) return;
    this.task = (raw as Library).getDocument({ data: bytes.slice(), isEvalSupported: false, ownerDocument: this.contentEl.ownerDocument });
    const pdf = await this.task.promise; if (this.closed) return;
    this.contentEl.empty(); const toolbar = this.contentEl.createDiv({ cls: 'pdf-form-studio-toolbar' });
    const previous = toolbar.createEl('button', { cls: 'clickable-icon' }); setIcon(previous, 'chevron-left'); setTooltip(previous, 'Previous page');
    const counter = toolbar.createSpan();
    const next = toolbar.createEl('button', { cls: 'clickable-icon' }); setIcon(next, 'chevron-right'); setTooltip(next, 'Next page');
    const canvas = this.contentEl.createEl('canvas', { cls: 'pdf-form-studio-recovery-canvas' });
    let number = 1;
    const paint = async (): Promise<void> => {
      const generation = ++this.generation; this.render?.cancel(); previous.disabled = number === 1; next.disabled = number === pdf.numPages;
      counter.textContent = `${number} of ${pdf.numPages} · read only`;
      const page = await pdf.getPage(number); if (this.closed || generation !== this.generation) return;
      const viewport = page.getViewport({ scale: 1.3 }); canvas.width = viewport.width; canvas.height = viewport.height;
      const render = this.render = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
      try { await render.promise; } catch (error) { if (!this.closed && generation === this.generation) throw error; }
    };
    const navigate = (delta: number) => { number += delta; void paint().catch(error => { if (!this.closed) counter.textContent = String(error); }); };
    previous.onclick = () => navigate(-1); next.onclick = () => navigate(1); await paint();
  }
  onClose(): void { this.closed = true; this.generation++; this.render?.cancel(); if (this.task) void this.task.destroy().catch(() => {}); this.contentEl.empty(); }
}
