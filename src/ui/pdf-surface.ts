import { Component, loadPdfJs, setIcon, setTooltip } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { NativePage, NativePdf, EditorSurface } from '../compat/native-pdf';
import type { TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { TextEditor } from './text-editor';
import { renamedPdfPath } from '../pdf/file-name';
import { detectAnswerLines } from '../pdf/answer-lines';
import type { Rect } from '../pdf/text-engine';

interface PageEntry { native: NativePage; page: PDFPageProxy; canvas: HTMLCanvasElement; text: HTMLElement; links: HTMLElement; version: number; painted: number; queued?: number; rendering?: RenderTask; textTask?: TextLayer; suggestions?: HTMLElement; candidates?: Rect[] }
interface LineScan { generation: number; task?: RenderTask }
type Library = typeof import('pdfjs-dist');

/** Owns the visible page lifecycle. Native reloads never replace this surface. */
export class PdfSurface extends Component {
  private native: NativePdf;
  private sessions: VaultSessions;
  private app: App;
  private root: HTMLElement;
  private navigation: HTMLElement;
  private tools: HTMLElement;
  private scroller: HTMLElement;
  private stack: HTMLElement;
  private message: HTMLElement;
  private pageInput: HTMLInputElement;
  private count: HTMLElement;
  private zoomButton: HTMLButtonElement;
  private lineButton: HTMLButtonElement;
  private lineScan?: LineScan;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private editor?: TextEditor;
  private session?: TextSession;
  private library?: Library;
  private task?: PDFDocumentLoadingTask;
  private loadingTasks = new Set<PDFDocumentLoadingTask>();
  private pdf?: PDFDocumentProxy;
  private entries: PageEntry[] = [];
  private epoch = -1;
  private generation = 0;
  private closed = false;
  private scale: number | 'width' = 'width';
  private rotation = 0;
  private frame?: number;
  private renderQueue = Promise.resolve();
  private currentPage = 1;
  private search: HTMLInputElement;
  private searchRow: HTMLElement;
  private searchStatus: HTMLElement;
  private matchesFound: number[] = [];
  private matchIndex = -1;
  private searchGeneration = 0;
  private state?: ReturnType<TextEditor['captureState']>;
  private title: HTMLButtonElement;
  private titleInput: HTMLInputElement;
  private renaming = false;

  constructor(app: App, native: NativePdf, sessions: VaultSessions, state?: ReturnType<TextEditor['captureState']>) {
    super(); this.app = app; this.native = native; this.sessions = sessions; this.state = state;
    const releaseSession = sessions.retain(native.file); this.register(() => { void releaseSession(); });
    const doc = native.element.ownerDocument;
    this.root = doc.createElement('div'); this.root.className = 'pfs-surface';
    if (native.embedHeight && native.embedHeight > 0) native.element.style.setProperty('--pfs-embed-height', `${Math.max(240, native.embedHeight)}px`);
    this.root.setAttribute('aria-label', `Edit ${native.file.name}`);
    this.navigation = this.root.createDiv({ cls: 'pfs-navigation' });
    const titleArea = this.navigation.createDiv({ cls: 'pfs-title-area' });
    this.title = titleArea.createEl('button', { cls: 'pfs-document-title', text: native.file.basename, attr: { 'aria-label': 'Rename PDF' } });
    this.title.title = `Rename ${native.file.name}`;
    this.titleInput = titleArea.createEl('input', { cls: 'pfs-title-input', attr: { 'aria-label': 'PDF file name', spellcheck: 'false' } }); this.titleInput.hidden = true;
    this.registerDomEvent(this.title, 'click', () => { this.title.hidden = true; this.titleInput.hidden = false; this.titleInput.value = this.file.basename; this.titleInput.focus(); this.titleInput.select(); });
    const cancelRename = () => { if (this.renaming) return; this.titleInput.hidden = true; this.title.hidden = false; this.titleInput.removeAttribute('aria-invalid'); };
    this.registerDomEvent(this.titleInput, 'keydown', event => { event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void this.rename(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelRename(); this.title.focus(); }
    });
    this.registerDomEvent(this.titleInput, 'blur', cancelRename);
    this.registerEvent(app.vault.on('rename', file => { if (file === this.file) this.updateTitle(); }));
    this.previous = this.button(this.navigation, 'Previous page', 'chevron-up', () => this.go(this.currentPage - 1));
    this.pageInput = this.navigation.createEl('input', { type: 'number', cls: 'pfs-page-number', attr: { 'aria-label': 'Page', min: '1' } });
    this.pageInput.value = '1';
    this.registerDomEvent(this.pageInput, 'change', () => this.go(Number(this.pageInput.value)));
    this.registerDomEvent(this.pageInput, 'keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { this.go(Number(this.pageInput.value)); this.scroller.focus(); } });
    this.count = this.navigation.createSpan({ cls: 'pfs-page-count', text: '/ …' });
    this.next = this.button(this.navigation, 'Next page', 'chevron-down', () => this.go(this.currentPage + 1));
    this.navigation.createSpan({ cls: 'pfs-divider' });
    this.button(this.navigation, 'Zoom out', 'minus', () => this.zoom(-0.15));
    this.zoomButton = this.navigation.createEl('button', { cls: 'pfs-zoom', text: 'Fit width' });
    setTooltip(this.zoomButton, 'Fit page width'); this.registerDomEvent(this.zoomButton, 'click', () => { this.scale = 'width'; this.layout(); });
    this.button(this.navigation, 'Zoom in', 'plus', () => this.zoom(0.15));
    this.button(this.navigation, 'Rotate clockwise', 'rotate-cw', () => { this.rotation = (this.rotation + 90) % 360; this.layout(); });
    this.button(this.navigation, 'Find in PDF', 'search', () => this.showSearch());
    this.lineButton = this.button(this.navigation, 'Detect answer lines in PDF', 'scan-line', () => { void this.detectLines().catch(error => this.fail(error)); });
    this.tools = this.root.createDiv({ cls: 'pfs-tools-host' });
    this.searchRow = this.root.createDiv({ cls: 'pfs-search' }); this.searchRow.hidden = true;
    this.search = this.searchRow.createEl('input', { type: 'search', attr: { placeholder: 'Find in PDF', 'aria-label': 'Find in PDF' } });
    this.searchStatus = this.searchRow.createSpan({ cls: 'pfs-search-status' });
    this.button(this.searchRow, 'Previous match', 'chevron-up', () => this.nextMatch(-1));
    this.button(this.searchRow, 'Next match', 'chevron-down', () => this.nextMatch(1));
    this.button(this.searchRow, 'Close search', 'x', () => { this.searchRow.hidden = true; this.search.value = ''; this.searchGeneration++; this.highlight(); this.scroller.focus(); });
    this.registerDomEvent(this.search, 'input', () => { void this.find().catch(error => this.fail(error)); });
    this.registerDomEvent(this.search, 'keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); this.nextMatch(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { this.searchRow.hidden = true; this.scroller.focus(); } });
    this.message = this.root.createDiv({ cls: 'pfs-surface-message', text: 'Opening PDF…', attr: { role: 'status' } });
    this.scroller = this.root.createDiv({ cls: 'pfs-pages', attr: { tabindex: '0', 'aria-label': 'PDF pages' } });
    this.stack = this.scroller.createDiv({ cls: 'pfs-page-stack' });
    native.element.append(this.root);
    this.registerDomEvent(this.scroller, 'scroll', () => this.requestVisible(), { passive: true });
    this.registerDomEvent(this.root, 'keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); this.showSearch(); }
    }, true);
    const resize = new doc.defaultView!.ResizeObserver(() => this.layout()); resize.observe(this.scroller); this.register(() => resize.disconnect());
    void this.open().catch(error => this.fail(error));
  }
  get file(): TFile { return this.native.file; }
  private updateTitle(): void { this.title.textContent = this.file.basename; this.title.title = `Rename ${this.file.name}`; this.root.setAttribute('aria-label', `Edit ${this.file.name}`); }
  private async rename(): Promise<void> {
    if (this.renaming) return;
    try {
      const path = renamedPdfPath(this.file.path, this.titleInput.value);
      const existing = this.app.vault.getAllLoadedFiles().find(file => file.path.normalize('NFC').toLocaleLowerCase() === path.normalize('NFC').toLocaleLowerCase());
      if (existing && existing !== this.file) throw new Error('A file with that name already exists.');
      this.renaming = true; this.titleInput.readOnly = true;
      await this.session?.save();
      if (path !== this.file.path) await this.app.fileManager.renameFile(this.file, path);
      this.updateTitle(); this.titleInput.hidden = true; this.title.hidden = false; this.titleInput.removeAttribute('aria-invalid'); this.message.textContent = ''; this.message.classList.remove('is-error'); this.title.focus();
    } catch (error) { this.titleInput.setAttribute('aria-invalid', 'true'); this.message.textContent = error instanceof Error ? error.message : String(error); this.message.classList.add('is-error'); this.titleInput.focus(); }
    finally { this.renaming = false; this.titleInput.readOnly = false; }
  }
  matches(native: NativePdf): boolean { return this.file === native.file && this.native.element === native.element; }
  captureState(native?: NativePdf): ReturnType<TextEditor['captureState']> { return this.editor?.captureState(native); }
  refresh(): void { /* Session and ResizeObserver updates drive rendering, not discovery polls. */ }
  private button(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: 'clickable-icon pfs-nav-button', attr: { 'aria-label': label } }); setIcon(b, icon); setTooltip(b, label);
    this.registerDomEvent(b, 'click', action); return b;
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.message.textContent = error instanceof Error ? error.message : String(error);
    this.message.classList.add('is-error');
    // Unsupported documents retain the native viewer, with a useful reason.
    if (!this.editor) { this.scroller.hidden = true; this.navigation.hidden = true; this.native.element.classList.remove('pfs-integrated'); }
  }
  private async open(): Promise<void> {
    const [session, raw] = await Promise.all([this.sessions.get(this.file), loadPdfJs()]);
    if (this.closed) return;
    this.session = session; this.library = raw as Library;
    await this.loadDocument(); if (this.closed) return;
    this.native.element.classList.add('pfs-integrated');
    const surface: EditorSurface = { identity: this.native.identity, element: this.root, file: this.file,
      pages: () => this.entries.map(entry => entry.native), toolbarHost: () => this.tools };
    this.editor = this.addChild(new TextEditor(this.app, surface, this.sessions, this.state));
    this.register(session.subscribe(() => { this.refreshSuggestions(); if (this.epoch !== session.renderEpoch) void this.loadDocument().catch(error => this.fail(error)); }));
    this.layout(); this.go(this.native.initialPage ?? 1);
  }
  private async loadDocument(): Promise<void> {
    this.cancelLineScan(); this.clearSuggestions();
    const generation = ++this.generation; this.epoch = this.session!.renderEpoch;
    this.searchGeneration++;
    const bytes = await this.session!.renderBytes(); if (this.closed || generation !== this.generation) return;
    const task = this.library!.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, ownerDocument: this.root.ownerDocument });
    this.loadingTasks.add(task);
    try {
      const pdf = await task.promise; if (this.closed || generation !== this.generation) return;
      const entries: PageEntry[] = [];
      const fragment = this.root.ownerDocument.createDocumentFragment();
      // Only page metadata is loaded here. Canvas/text rendering is limited to the viewport.
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number); if (this.closed || generation !== this.generation) return;
        const div = this.root.ownerDocument.createElement('div'); div.className = 'pfs-page'; div.setAttribute('aria-label', `Page ${number}`);
        const canvas = div.createEl('canvas', { cls: 'pfs-page-canvas', attr: { 'aria-hidden': 'true' } });
        const text = div.createDiv({ cls: 'textLayer pfs-text-layer' });
        const links = div.createDiv({ cls: 'pfs-links' });
        const viewport = page.getViewport({ scale: 1 });
        entries.push({ native: { div, viewport, number, annotationElements: () => [] }, page, canvas, text, links, version: 0, painted: -1 }); fragment.append(div);
      }
      for (const entry of this.entries) { entry.rendering?.cancel(); entry.textTask?.cancel(); }
      const oldTask = this.task; this.task = task;
      this.pdf = pdf; this.entries = entries; this.stack.replaceChildren(fragment);
      if (oldTask) void oldTask.destroy().catch(() => {});
      this.count.textContent = `/ ${pdf.numPages}`; this.pageInput.max = String(pdf.numPages); this.message.textContent = '';
      this.layout();
    } finally {
      this.loadingTasks.delete(task);
      if (this.task !== task) await task.destroy().catch(() => {});
    }
  }
  private layout(): void {
    if (this.closed || !this.entries.length || this.scroller.clientWidth < 20) return;
    const old = this.entries[this.currentPage - 1];
    const fraction = old ? (this.scroller.scrollTop - old.native.div.offsetTop) / old.native.viewport.height : 0;
    const width = Math.max(120, this.scroller.clientWidth - 32);
    if (this.native.element.matches('.pdf-embed') && !this.native.embedHeight) {
      const first = this.entries[0]!.page;
      const page = first.getViewport({ scale: 1, rotation: (first.rotate + this.rotation) % 360 });
      // Let the note scroll past a complete page. Zooming inside the preview
      // must not keep growing the note, and explicit #height remains respected.
      const pageHeight = page.height * Math.min(2, width / page.width);
      const chrome = this.root.offsetHeight - this.scroller.offsetHeight;
      const height = `${Math.ceil(pageHeight + 32 + chrome + 2)}px`;
      if (this.native.element.style.getPropertyValue('--pfs-embed-height') !== height) this.native.element.style.setProperty('--pfs-embed-height', height);
    }
    let changed = false;
    for (const entry of this.entries) {
      const base = entry.page.getViewport({ scale: 1, rotation: (entry.page.rotate + this.rotation) % 360 });
      const scale = this.scale === 'width' ? Math.min(2, width / base.width) : this.scale;
      const viewport = entry.page.getViewport({ scale, rotation: base.rotation });
      if (entry.version && entry.native.viewport.width === viewport.width && entry.native.viewport.rotation === viewport.rotation) continue;
      changed = true; entry.version++; entry.rendering?.cancel(); entry.textTask?.cancel(); entry.native.viewport = viewport;
      Object.assign(entry.native.div.style, { width: `${viewport.width}px`, height: `${viewport.height}px` });
      entry.native.div.style.setProperty('--scale-factor', String(scale));
      entry.native.div.style.setProperty('--total-scale-factor', String(scale));
    }
    if (changed) { this.editor?.refresh(); if (old) this.scroller.scrollTop = old.native.div.offsetTop + fraction * old.native.viewport.height; }
    this.zoomButton.textContent = this.scale === 'width' ? 'Fit width' : `${Math.round(this.scale * 100)}%`;
    this.refreshSuggestions(); this.requestVisible();
  }
  private zoom(delta: number): void { this.scale = Math.max(0.35, Math.min(3, (typeof this.scale === 'number' ? this.scale : this.entries[this.currentPage - 1]?.native.viewport.scale ?? 1) + delta)); this.layout(); }
  private requestVisible(): void {
    if (this.frame !== undefined || this.closed) return;
    this.frame = this.root.ownerDocument.defaultView!.requestAnimationFrame(() => { this.frame = undefined; this.paintVisible(); });
  }
  private paintVisible(): void {
    const bounds = this.scroller.getBoundingClientRect(); let visibleHeight = 0;
    if (!bounds.width || !bounds.height) return;
    for (const entry of this.entries) {
      const rect = entry.native.div.getBoundingClientRect();
      const visible = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
      if (visible > visibleHeight || (visible > 0 && visible === visibleHeight && entry.native.number === this.currentPage)) { visibleHeight = visible; this.currentPage = entry.native.number; }
      if (rect.bottom < bounds.top - 600 || rect.top > bounds.bottom + 600) {
        // Release distant bitmaps, retaining page DOM and editable objects.
        if (Math.abs(rect.top - bounds.top) > bounds.height * 3 && entry.painted >= 0) { entry.canvas.width = 0; entry.canvas.height = 0; entry.painted = -1; }
        continue;
      }
      if (entry.painted === entry.version || entry.queued === entry.version) continue;
      const version = entry.version; entry.queued = version;
      this.renderQueue = this.renderQueue.catch(() => {}).then(async () => {
        try {
          if (this.closed || version !== entry.version || !entry.native.div.isConnected || !this.nearViewport(entry)) return;
          await this.paint(entry, version);
        } catch (error) {
          if (!this.closed && version === entry.version && !(error instanceof Error && error.name === 'RenderingCancelledException')) { entry.painted = -1; this.fail(error); }
        } finally { if (entry.queued === version) entry.queued = undefined; }
      });
    }
    if (this.pageInput.ownerDocument.activeElement !== this.pageInput) this.pageInput.value = String(this.currentPage);
    this.previous.disabled = this.currentPage === 1; this.next.disabled = this.currentPage === this.entries.length;
  }
  private nearViewport(entry: PageEntry): boolean {
    const bounds = this.scroller.getBoundingClientRect(), page = entry.native.div.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && page.bottom >= bounds.top - 600 && page.top <= bounds.bottom + 600;
  }
  private async paint(entry: PageEntry, version: number): Promise<void> {
    const doc = this.root.ownerDocument, viewport = entry.page.getViewport({ scale: entry.native.viewport.scale, rotation: entry.native.viewport.rotation });
    // Cap raster memory; geometry and PDF output retain full precision.
    const ratio = Math.min(doc.defaultView!.devicePixelRatio, 2, Math.sqrt(10_000_000 / (viewport.width * viewport.height)));
    const canvas = doc.createElement('canvas'); canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    const task = entry.rendering = entry.page.render({ canvasContext: canvas.getContext('2d')!, viewport, annotationMode: 1, transform: [ratio, 0, 0, ratio, 0, 0] });
    try { await task.promise; } finally { if (entry.rendering === task) entry.rendering = undefined; }
    if (this.closed || version !== entry.version || !entry.native.div.isConnected || !this.nearViewport(entry)) return;
    entry.canvas.width = canvas.width; entry.canvas.height = canvas.height; entry.canvas.getContext('2d')!.drawImage(canvas, 0, 0);
    entry.painted = version;
    const content = await entry.page.getTextContent();
    if (this.closed || version !== entry.version) return;
    entry.text.replaceChildren(); entry.textTask = new this.library!.TextLayer({ container: entry.text, viewport, textContentSource: content });
    await entry.textTask.render();
    if (this.closed || version !== entry.version) return;
    this.highlight(); entry.links.replaceChildren();
    const annotations = await entry.page.getAnnotations();
    if (this.closed || version !== entry.version) return;
    for (const annotation of annotations as { subtype: string; rect: number[]; url?: string; dest?: string | unknown[] }[]) {
      if (annotation.subtype !== 'Link') continue;
      const p = viewport.convertToViewportRectangle(annotation.rect);
      const link = entry.links.createEl('a', { cls: 'pfs-pdf-link', attr: { 'aria-label': annotation.url ?? 'Go to linked page', tabindex: '0' } });
      Object.assign(link.style, { left: `${Math.min(p[0]!, p[2]!)}px`, top: `${Math.min(p[1]!, p[3]!)}px`, width: `${Math.abs(p[2]! - p[0]!)}px`, height: `${Math.abs(p[3]! - p[1]!)}px` });
      if (annotation.url && /^(https?:|mailto:)/i.test(annotation.url)) { link.href = annotation.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else if (annotation.dest) { link.href = '#'; link.onclick = event => { event.preventDefault(); void this.destination(annotation.dest!).catch(error => this.fail(error)); }; }
    }
  }
  private clearSuggestions(): void {
    for (const entry of this.entries) { entry.suggestions?.remove(); entry.suggestions = undefined; entry.candidates = undefined; }
    this.lineButton?.setAttribute('aria-pressed', 'false'); this.editor?.setAnswerLines([]);
  }
  private overlapsField(page: number, rect: Rect): boolean {
    return !!this.session?.snapshot.fields.some(field => field.widgets.some(widget => widget.page === page
      && rect[0] < widget.rect[2] && rect[2] > widget.rect[0] && rect[1] < widget.rect[3] && rect[3] > widget.rect[1]));
  }
  private refreshSuggestions(page?: PageEntry): void {
    this.editor?.setAnswerLines(this.entries.flatMap(entry => (entry.candidates ?? []).map(rect => ({ page: entry.native.number, rect }))));
    for (const entry of page ? [page] : this.entries) {
      if (!entry.suggestions || !entry.candidates) continue;
      const buttons = new Map([...entry.suggestions.querySelectorAll<HTMLButtonElement>('button')].map(button => [button.dataset.rect!, button]));
      for (const rect of entry.candidates) {
        if (this.overlapsField(entry.native.number, rect)) continue;
        const p = entry.native.viewport.convertToViewportRectangle(rect), v = entry.native.viewport;
        const key = JSON.stringify(rect);
        const button = buttons.get(key) ?? entry.suggestions.createEl('button', { cls: 'pfs-answer-suggestion', attr: { 'aria-label': 'Fill detected answer line', title: 'Click to add an editable answer field' } });
        button.dataset.rect = key; buttons.delete(key);
        Object.assign(button.style, { left: `${Math.min(p[0]!, p[2]!) / v.width * 100}%`, top: `${Math.min(p[1]!, p[3]!) / v.height * 100}%`,
          width: `${Math.abs(p[2]! - p[0]!) / v.width * 100}%`, height: `${Math.abs(p[3]! - p[1]!) / v.height * 100}%` });
        button.disabled = !!this.session?.replacing || this.session?.status === 'conflict';
        button.onclick = () => { if (!this.overlapsField(entry.native.number, rect)) this.editor?.addSuggestedField(entry.native.number, rect); this.refreshSuggestions(); };
      }
      for (const button of buttons.values()) button.remove();
    }
  }
  private cancelLineScan(): void {
    const scan = this.lineScan; this.lineScan = undefined;
    scan?.task?.cancel();
    this.lineButton.removeAttribute('aria-busy');
    setTooltip(this.lineButton, 'Detect answer lines in PDF');
    this.lineButton.setAttribute('aria-label', 'Detect answer lines in PDF');
  }
  private scanCurrent(scan: LineScan): boolean { return !this.closed && this.lineScan === scan && scan.generation === this.generation; }
  private async detectPageLines(entry: PageEntry, scan: LineScan): Promise<Rect[]> {
    // Only one bounded raster exists at a time, including for offscreen pages.
    // Canonical geometry keeps suggestions independent of zoom and quarter turns.
    const base = entry.page.getViewport({ scale: 1, rotation: 0 });
    const scale = Math.min(1.5, Math.sqrt(1_900_000 / (base.width * base.height)));
    const viewport = entry.page.getViewport({ scale, rotation: 0 });
    const canvas = this.root.ownerDocument.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Cannot render the PDF for answer-line detection.');
      const task = scan.task = entry.page.render({ canvasContext: context, viewport, annotationMode: 0 });
      await task.promise; if (!this.scanCurrent(scan)) return [];
      return detectAnswerLines(context.getImageData(0, 0, canvas.width, canvas.height), base.width, base.height)
        .map(({ rect }) => { const a = base.convertToPdfPoint(rect[0], rect[1]), b = base.convertToPdfPoint(rect[2], rect[3]);
          return [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!)] as Rect; });
    } finally { scan.task = undefined; canvas.width = 0; canvas.height = 0; }
  }
  private async detectLines(): Promise<void> {
    if (this.lineScan) {
      this.cancelLineScan(); this.clearSuggestions(); this.message.textContent = 'Answer-line detection cancelled.'; return;
    }
    if (!this.pdf || !this.editor || !this.entries.length || this.closed) return;
    if (this.entries.some(entry => entry.candidates)) { this.clearSuggestions(); this.message.textContent = ''; return; }
    const scan = this.lineScan = { generation: this.generation };
    const entries = [...this.entries];
    this.lineButton.setAttribute('aria-busy', 'true'); this.lineButton.setAttribute('aria-pressed', 'true');
    setTooltip(this.lineButton, 'Cancel answer-line detection'); this.lineButton.setAttribute('aria-label', 'Cancel answer-line detection');
    this.message.classList.remove('is-error');
    try {
      for (let i = 0; i < entries.length; i++) {
        if (!this.scanCurrent(scan)) return;
        const entry = entries[i]!;
        this.message.textContent = `Scanning PDF page ${i + 1} of ${entries.length} for answer lines…`;
        const candidates = await this.detectPageLines(entry, scan);
        if (!this.scanCurrent(scan)) return;
        entry.candidates = candidates; entry.suggestions = entry.native.div.createDiv({ cls: 'pfs-answer-suggestions' });
        this.refreshSuggestions(entry);
        // Yield between pages so navigation and the cancel button remain usable.
        if (i + 1 < entries.length) await new Promise<void>(resolve => this.root.ownerDocument.defaultView!.setTimeout(resolve, 0));
      }
      const counts = entries.map(entry => entry.candidates!.filter(rect => !this.overlapsField(entry.native.number, rect)).length);
      const count = counts.reduce((sum, count) => sum + count, 0), pagesWithLines = counts.filter(count => count > 0).length;
      this.message.textContent = count ? `${count} suggested answer line${count === 1 ? '' : 's'} on ${pagesWithLines} of ${entries.length} PDF page${entries.length === 1 ? '' : 's'}. Click a blue outline to fill it; click Detect answer lines again to hide suggestions.`
        : `No clear blank answer lines found in this PDF (${entries.length} page${entries.length === 1 ? '' : 's'} scanned). Use Text to place a box manually.`;
    } catch (error) {
      if (this.scanCurrent(scan)) { this.clearSuggestions(); throw error; }
    } finally {
      // A cancelled older run must not reset the controls of a newer scan.
      if (this.lineScan === scan) this.cancelLineScan();
    }
  }
  private async destination(value: string | unknown[]): Promise<void> {
    const dest = typeof value === 'string' ? await this.pdf!.getDestination(value) : value;
    if (!dest?.length) return;
    const ref = dest[0]; const number = typeof ref === 'number' ? ref : await this.pdf!.getPageIndex(ref as { num: number; gen: number }); this.go(number + 1);
  }
  private go(number: number): void { const index = Math.max(1, Math.min(this.entries.length, Math.round(number) || 1)); const entry = this.entries[index - 1]; if (entry) { this.currentPage = index; this.scroller.scrollTop = entry.native.div.offsetTop; this.requestVisible(); } }
  private showSearch(): void { this.searchRow.hidden = false; this.search.focus(); this.search.select(); }
  private async find(): Promise<void> {
    const generation = ++this.searchGeneration, query = this.search.value.trim().toLocaleLowerCase();
    this.matchesFound = []; this.matchIndex = -1; this.searchStatus.textContent = query ? 'Searching…' : ''; this.highlight();
    if (!query) return;
    const matches: number[] = [];
    for (const entry of this.entries) {
      const content = await entry.page.getTextContent(); if (this.closed || generation !== this.searchGeneration) return;
      if (content.items.map(item => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase().includes(query)) matches.push(entry.native.number);
    }
    this.matchesFound = matches; this.searchStatus.textContent = matches.length ? `${matches.length} matching page${matches.length === 1 ? '' : 's'}` : 'No matches'; this.nextMatch(1);
  }
  private nextMatch(delta: number): void { if (!this.matchesFound.length) return; this.matchIndex = (this.matchIndex + delta + this.matchesFound.length) % this.matchesFound.length; this.go(this.matchesFound[this.matchIndex]!); }
  private highlight(): void { const query = this.search.value.trim().toLocaleLowerCase(); for (const entry of this.entries) for (const span of entry.text.querySelectorAll('span')) span.classList.toggle('pfs-search-hit', !!query && (span.textContent ?? '').toLocaleLowerCase().includes(query)); }
  onunload(): void {
    this.cancelLineScan(); this.clearSuggestions();
    this.closed = true; this.generation++; this.searchGeneration++;
    if (this.frame !== undefined) this.root.ownerDocument.defaultView!.cancelAnimationFrame(this.frame);
    if (this.editor) this.removeChild(this.editor);
    for (const entry of this.entries) { entry.version++; entry.rendering?.cancel(); entry.textTask?.cancel(); }
    if (this.task) void this.task.destroy().catch(() => {});
    for (const task of this.loadingTasks) void task.destroy().catch(() => {});
    this.loadingTasks.clear();
    this.root.remove(); this.native.element.classList.remove('pfs-integrated');
    this.native.element.style.removeProperty('--pfs-embed-height');
  }
}
