import { Component, loadPdfJs, setIcon, setTooltip } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { NativePage, NativePdf, EditorSurface } from '../compat/native-pdf';
import type { TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { TextEditor } from './text-editor';
import { renamedPdfPath } from '../pdf/file-name';
import { decorativeFooterRules, excludeDecorativeFooters } from '../compat/pdf-artifacts';
import { detectAnswerLines } from '../pdf/answer-lines';
import { MAX_AUTO_DETECT_PAGES } from '../pdf/tool-preferences';
import { labelOverlay } from './overlay-label';
import type { Rect } from '../pdf/text-engine';
import type { TextField } from '../pdf/text-engine';

interface PageEntry { native: NativePage; page: PDFPageProxy; canvas: HTMLCanvasElement; text: HTMLElement; links: HTMLElement; version: number; painted: number; queued?: number; rendering?: RenderTask; textTask?: TextLayer; suggestions?: HTMLElement; candidates?: Rect[] }
interface LineScan { generation: number; targets: PageEntry[]; task?: RenderTask }
type Library = typeof import('pdfjs-dist');
const FLOAT_EXIT_MS = 110;
const FLOAT_SCROLL_BUFFER = 6;

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
  private dismissedLines = new Set<string>();
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private editor?: TextEditor;
  private session?: TextSession;
  private library?: Library;
  private task?: PDFDocumentLoadingTask;
  private loadingTasks = new Set<PDFDocumentLoadingTask>();
  private pdf?: PDFDocumentProxy;
  private entries: PageEntry[] = [];
  private scannedEntries = new Set<PageEntry>();
  private epoch = -1;
  private generation = 0;
  private closed = false;
  private scale: number | 'width' = 'width';
  private rotation = 0;
  private frame?: number;
  private renderQueue = Promise.resolve();
  private paintedEntries = new Set<PageEntry>();
  private activeRender?: PageEntry;
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
  private floatingFrame?: number;
  private toolbarSpacer: HTMLElement;
  private floatingHost?: HTMLElement;
  private floatingExitTimer?: number;

  constructor(app: App, native: NativePdf, sessions: VaultSessions, state?: ReturnType<TextEditor['captureState']>, private autoDetectOnOpen = true) {
    super(); this.app = app; this.native = native; this.sessions = sessions; this.state = state;
    const releaseSession = sessions.retain(native.file); this.register(() => { void releaseSession(); });
    const doc = native.element.ownerDocument;
    this.root = doc.createElement('div'); this.root.className = 'pfs-surface';
    const applyToolbarOffset = () => {
      this.root.style.setProperty('--pfs-toolbar-top-offset', `${this.sessions.preferences.toolbarTopOffset}px`);
      this.layout();
      this.queueFloatingToolbar();
    };
    applyToolbarOffset();
    this.register(sessions.subscribePreferences(applyToolbarOffset));
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
    this.tools = this.root.createDiv({ cls: 'pfs-tools-host' });
    this.toolbarSpacer = this.root.createDiv({ cls: 'pfs-toolbar-spacer' }); this.toolbarSpacer.hidden = true;
    this.lineButton = this.button(doc.createElement('div'), 'Detect answer lines in PDF', 'scan-line', () => {
      this.answerLineActions().run();
    });
    this.lineButton.classList.remove('pfs-nav-button');
    this.lineButton.classList.add('pdf-form-studio-icon');
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
    // A previous hot-reloaded build can leave its own surface in this host.
    for (const child of [...native.element.children]) if (child.classList.contains('pfs-surface')) child.remove();
    native.element.append(this.root);
    // Hide native chrome synchronously, before session/PDF.js loading yields.
    native.element.classList.add('pfs-integrated');
    this.registerDomEvent(this.scroller, 'scroll', () => this.requestVisible(), { passive: true });
    this.registerDomEvent(doc, 'scroll', () => this.queueFloatingToolbar(), true);
    this.registerDomEvent(doc.defaultView!, 'resize', () => this.queueFloatingToolbar());
    this.registerDomEvent(this.root, 'keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); this.showSearch(); }
    }, true);
    const resize = new doc.defaultView!.ResizeObserver(() => { this.layout(); this.queueFloatingToolbar(); });
    resize.observe(this.scroller); resize.observe(this.root); this.register(() => resize.disconnect());
    this.queueFloatingToolbar();
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
    if (!this.editor) { this.scroller.hidden = true; this.navigation.hidden = true; this.root.classList.add('pfs-fallback'); this.native.element.classList.remove('pfs-integrated'); }
  }
  private async open(): Promise<void> {
    const [session, raw] = await Promise.all([this.sessions.get(this.file), loadPdfJs()]);
    if (this.closed) return;
    this.session = session; this.library = raw as Library;
    await this.loadDocument(); if (this.closed) return;
    const surface: EditorSurface = { identity: this.native.identity, element: this.root, file: this.file,
      pages: () => this.entries.map(entry => entry.native), toolbarHost: () => this.tools,
      answerLineButton: () => this.lineButton };
    this.editor = this.addChild(new TextEditor(this.app, surface, this.sessions, this.state));
    this.register(session.subscribeRemovedField(field => this.dismissRemovedAnswer(field)));
    this.register(session.subscribe(() => { this.refreshSuggestions(); if (this.epoch !== session.renderEpoch) void this.loadDocument().catch(error => this.fail(error)); }));
    this.layout(); this.go(this.native.initialPage ?? 1);
    if (this.autoDetectOnOpen && this.sessions.preferences.autoDetectLines) {
      const limit = this.sessions.preferences.autoDetectPageLimit;
      if (this.entries.length > limit) this.message.textContent = `Automatic answer-line detection skipped: ${this.entries.length} pages exceeds the ${limit}-page limit. Use the scan button beside Add text box to scan up to ${MAX_AUTO_DETECT_PAGES} pages at a time.`;
      else await this.detectLines();
    }
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
        if (number % 16 === 0 && number < pdf.numPages) {
          this.message.textContent = `Preparing PDF pages ${number} of ${pdf.numPages}…`;
          await new Promise<void>(resolve => this.root.ownerDocument.defaultView!.setTimeout(resolve, 0));
          if (this.closed || generation !== this.generation) return;
        }
      }
      for (const entry of this.entries) { entry.rendering?.cancel(); entry.textTask?.cancel(); }
      const oldTask = this.task; this.task = task;
      this.pdf = pdf; this.entries = entries; this.paintedEntries.clear(); this.stack.replaceChildren(fragment);
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
    this.queueFloatingToolbar();
  }
  private queueFloatingToolbar(): void {
    if (this.floatingFrame !== undefined || this.closed) return;
    this.floatingFrame = this.root.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.floatingFrame = undefined; this.updateFloatingToolbar();
    });
  }
  private updateFloatingToolbar(): void {
    const win = this.root.ownerDocument.defaultView!;
    const restore = () => {
      if (this.floatingExitTimer !== undefined) win.clearTimeout(this.floatingExitTimer);
      this.floatingExitTimer = undefined;
      if (this.floatingHost) {
        this.root.insertBefore(this.tools, this.toolbarSpacer);
        this.floatingHost.remove(); this.floatingHost = undefined;
      }
      this.root.classList.remove('is-floating-toolbar'); this.toolbarSpacer.hidden = true;
    };
    if (!this.root.isConnected || !this.sessions.preferences.floatingToolbar) { restore(); return; }
    const hide = () => {
      if (!this.floatingHost) return;
      if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { restore(); return; }
      this.floatingHost.classList.remove('is-visible');
      if (this.floatingExitTimer === undefined) this.floatingExitTimer = win.setTimeout(() => {
        this.floatingExitTimer = undefined;
        if (!this.floatingHost?.classList.contains('is-visible')) restore();
      }, FLOAT_EXIT_MS);
    };
    let clip = { top: 0, bottom: win.innerHeight, left: 0, right: win.innerWidth };
    // Dock to the pane's visible content, not an embed wrapper or a note
    // scroller whose top can sit well below the actual top of the pane.
    const pane = this.native.element.closest<HTMLElement>('.view-content');
    if (pane) {
      const bounds = pane.getBoundingClientRect();
      clip = { top: Math.max(clip.top, bounds.top), bottom: Math.min(clip.bottom, bounds.bottom),
        left: Math.max(clip.left, bounds.left), right: Math.min(clip.right, bounds.right) };
    } else {
      const noteScroller = this.native.element.closest<HTMLElement>('.cm-scroller, .markdown-preview-view');
      for (let parent = noteScroller ?? this.native.element.parentElement; parent; parent = parent.parentElement) {
        const overflow = win.getComputedStyle(parent).overflowY;
        if (!/(auto|scroll|overlay)/.test(overflow) || parent.scrollHeight <= parent.clientHeight) continue;
        const bounds = parent.getBoundingClientRect();
        clip = { top: Math.max(clip.top, bounds.top), bottom: Math.min(clip.bottom, bounds.bottom),
          left: Math.max(clip.left, bounds.left), right: Math.min(clip.right, bounds.right) };
        break;
      }
    }
    const rect = this.root.getBoundingClientRect();
    const top = clip.top;
    const height = this.tools.offsetHeight;
    const offset = this.sessions.preferences.toolbarTopOffset;
    const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
    // Keep the PDF header in its normal place. Float only the editing tools
    // once their natural position reaches the top of the note.
    // A small scroll buffer prevents a one-pixel reversal from repeatedly
    // starting and cancelling the fade at the note's top edge.
    const navThreshold = clip.top + (this.floatingHost ? FLOAT_SCROLL_BUFFER : -FLOAT_SCROLL_BUFFER);
    if (rect.top + this.navigation.offsetHeight >= navThreshold || rect.bottom <= top + offset + height || clip.bottom <= top + offset + height || right - left < 200 || height < 20) { hide(); return; }
    this.toolbarSpacer.hidden = false; this.toolbarSpacer.style.height = `${height}px`;
    this.root.classList.add('is-floating-toolbar');
    if (this.floatingExitTimer !== undefined) { win.clearTimeout(this.floatingExitTimer); this.floatingExitTimer = undefined; }
    const entering = !this.floatingHost;
    if (!this.floatingHost) {
      this.floatingHost = this.root.ownerDocument.createElement('div');
      this.floatingHost.className = 'pfs-floating-toolbar';
      this.floatingHost.append(this.tools);
      this.root.ownerDocument.body.append(this.floatingHost);
    }
    Object.assign(this.floatingHost.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, paddingTop: `${offset}px` });
    if (entering) void this.floatingHost.offsetWidth;
    this.floatingHost.classList.add('is-visible');
  }
  private zoom(delta: number): void { this.scale = Math.max(0.35, Math.min(3, (typeof this.scale === 'number' ? this.scale : this.entries[this.currentPage - 1]?.native.viewport.scale ?? 1) + delta)); this.layout(); }
  private requestVisible(): void {
    if (this.frame !== undefined || this.closed) return;
    this.frame = this.root.ownerDocument.defaultView!.requestAnimationFrame(() => { this.frame = undefined; this.paintVisible(); });
  }
  private paintVisible(): void {
    const width = this.scroller.clientWidth, height = this.scroller.clientHeight;
    if (!width || !height) return;
    const top = this.scroller.scrollTop, bottom = top + height;
    const outside = (entry: PageEntry): boolean => entry.native.div.offsetTop + entry.native.div.offsetHeight < top - 600
      || entry.native.div.offsetTop > bottom + 600;
    if (this.activeRender && outside(this.activeRender)) this.activeRender.rendering?.cancel();
    for (const entry of this.paintedEntries) {
      if (!outside(entry) || Math.abs(entry.native.div.offsetTop - top) <= height * 3) continue;
      entry.textTask?.cancel(); entry.textTask = undefined;
      entry.canvas.width = 0; entry.canvas.height = 0; entry.painted = -1;
      entry.text.replaceChildren(); entry.links.replaceChildren(); this.paintedEntries.delete(entry);
    }
    // Page shells stay in document order, so only pages near the viewport need
    // measurement or rendering on each scroll frame.
    let low = 0, high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1, div = this.entries[mid]!.native.div;
      if (div.offsetTop + div.offsetHeight < top - 600) low = mid + 1; else high = mid;
    }
    const previousPage = this.currentPage;
    let visibleHeight = 0;
    for (let index = low; index < this.entries.length; index++) {
      const entry = this.entries[index]!, div = entry.native.div;
      if (div.offsetTop > bottom + 600) break;
      const visible = Math.max(0, Math.min(div.offsetTop + div.offsetHeight, bottom) - Math.max(div.offsetTop, top));
      if (visible > visibleHeight || (visible > 0 && visible === visibleHeight && entry.native.number === this.currentPage)) { visibleHeight = visible; this.currentPage = entry.native.number; }
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
    if (this.currentPage !== previousPage) this.updateLineButton();
  }
  private nearViewport(entry: PageEntry): boolean {
    const top = this.scroller.scrollTop, div = entry.native.div;
    return this.scroller.clientWidth > 0 && this.scroller.clientHeight > 0
      && div.offsetTop + div.offsetHeight >= top - 600 && div.offsetTop <= top + this.scroller.clientHeight + 600;
  }
  private async paint(entry: PageEntry, version: number): Promise<void> {
    const doc = this.root.ownerDocument, viewport = entry.page.getViewport({ scale: entry.native.viewport.scale, rotation: entry.native.viewport.rotation });
    // Cap raster memory; geometry and PDF output retain full precision.
    const ratio = Math.min(doc.defaultView!.devicePixelRatio, 2, Math.sqrt(10_000_000 / (viewport.width * viewport.height)));
    const canvas = doc.createElement('canvas'); canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    const task = entry.rendering = entry.page.render({ canvasContext: canvas.getContext('2d')!, viewport, annotationMode: 1, transform: [ratio, 0, 0, ratio, 0, 0] });
    this.activeRender = entry;
    try { await task.promise; } finally { if (entry.rendering === task) entry.rendering = undefined; if (this.activeRender === entry) this.activeRender = undefined; }
    if (this.closed || version !== entry.version || !entry.native.div.isConnected || !this.nearViewport(entry)) return;
    entry.canvas.width = canvas.width; entry.canvas.height = canvas.height; entry.canvas.getContext('2d')!.drawImage(canvas, 0, 0);
    entry.painted = version; this.paintedEntries.add(entry);
    const content = await entry.page.getTextContent();
    if (this.closed || version !== entry.version || !this.nearViewport(entry)) return;
    entry.text.replaceChildren(); entry.textTask = new this.library!.TextLayer({ container: entry.text, viewport, textContentSource: content });
    await entry.textTask.render();
    if (this.closed || version !== entry.version || !this.nearViewport(entry)) return;
    this.highlight(); entry.links.replaceChildren();
    const annotations = await entry.page.getAnnotations();
    if (this.closed || version !== entry.version || !this.nearViewport(entry)) return;
    for (const annotation of annotations as { subtype: string; rect: number[]; url?: string; dest?: string | unknown[] }[]) {
      if (annotation.subtype !== 'Link') continue;
      const p = viewport.convertToViewportRectangle(annotation.rect);
      const link = entry.links.createEl('a', { cls: 'pfs-pdf-link', attr: { 'aria-label': annotation.url ?? 'Go to linked page', tabindex: '0' } });
      Object.assign(link.style, { left: `${Math.min(p[0]!, p[2]!)}px`, top: `${Math.min(p[1]!, p[3]!)}px`, width: `${Math.abs(p[2]! - p[0]!)}px`, height: `${Math.abs(p[3]! - p[1]!)}px` });
      if (annotation.url && /^(https?:|mailto:)/i.test(annotation.url)) { link.href = annotation.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else if (annotation.dest) { link.href = '#'; link.onclick = event => { event.preventDefault(); void this.destination(annotation.dest!).catch(error => this.fail(error)); }; }
    }
  }
  private clearSuggestions(targets: PageEntry[] = this.entries): void {
    for (const entry of targets) { entry.suggestions?.remove(); entry.suggestions = undefined; entry.candidates = undefined; this.scannedEntries.delete(entry); }
    this.refreshSuggestions();
    this.updateLineButton();
  }
  private overlapsField(page: number, rect: Rect): boolean {
    return !!this.session?.snapshot.fields.some(field => field.widgets.some(widget => widget.page === page
      && rect[0] < widget.rect[2] && rect[2] > widget.rect[0] && rect[1] < widget.rect[3] && rect[3] > widget.rect[1]));
  }
  private lineKey(page: number, rect: Rect): string { return `${page}:${JSON.stringify(rect)}`; }
  private dismissRemovedAnswer(field: TextField): void {
    for (const entry of this.scannedEntries) for (const rect of entry.candidates ?? []) {
      if (field.widgets.some(widget => widget.page === entry.native.number && rect[0] < widget.rect[2] && rect[2] > widget.rect[0]
        && rect[1] < widget.rect[3] && rect[3] > widget.rect[1])) this.dismissedLines.add(this.lineKey(entry.native.number, rect));
    }
  }
  private refreshSuggestions(page?: PageEntry): void {
    this.editor?.setAnswerLines([...this.scannedEntries].flatMap(entry => (entry.candidates ?? [])
      .filter(rect => !this.dismissedLines.has(this.lineKey(entry.native.number, rect)))
      .map(rect => ({ page: entry.native.number, rect }))));
    for (const entry of page ? [page] : this.scannedEntries) {
      if (!entry.suggestions || !entry.candidates) continue;
      const buttons = new Map([...entry.suggestions.querySelectorAll<HTMLButtonElement>('button')].map(button => [button.dataset.rect!, button]));
      for (const rect of entry.candidates) {
        if (this.overlapsField(entry.native.number, rect) || this.dismissedLines.has(this.lineKey(entry.native.number, rect))) continue;
        const p = entry.native.viewport.convertToViewportRectangle(rect), v = entry.native.viewport;
        const key = JSON.stringify(rect);
        const button = buttons.get(key) ?? entry.suggestions.createEl('button', { cls: 'pfs-answer-suggestion' });
        labelOverlay(button, 'Fill detected answer line');
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
    this.updateLineButton();
  }
  private answerLineActions(): { title: string; run(): void } {
    const start = this.entries.length <= MAX_AUTO_DETECT_PAGES ? 0 : this.currentPage - 1;
    const end = Math.min(this.entries.length, start + MAX_AUTO_DETECT_PAGES);
    const targets = this.entries.slice(start, end);
    const hideRange = targets.length > 0 && targets.every(entry => entry.candidates !== undefined);
    const title = this.lineScan ? 'Cancel answer-line scan'
      : hideRange ? 'Clear line scan on these pages'
        : start === 0 && end === this.entries.length ? 'Detect answer lines in PDF'
        : `Detect answer lines on pages ${start + 1}–${end}`;
    return {
      title,
      run: () => { void this.detectLines(targets).catch(error => this.fail(error)); }
    };
  }
  private updateLineButton(): void {
    if (!this.lineButton) return;
    const title = this.answerLineActions().title;
    setTooltip(this.lineButton, title);
    this.lineButton.setAttribute('aria-label', title);
    this.lineButton.setAttribute('aria-busy', this.lineScan ? 'true' : 'false');
    this.lineButton.setAttribute('aria-pressed', this.lineScan || this.scannedEntries.size > 0 ? 'true' : 'false');
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
      let lines = detectAnswerLines(context.getImageData(0, 0, canvas.width, canvas.height), base.width, base.height);
      if (this.library && entry.page.getOperatorList) {
        try {
          const operators = await entry.page.getOperatorList({ annotationMode: 0 });
          if (!this.scanCurrent(scan)) return [];
          lines = excludeDecorativeFooters(lines, decorativeFooterRules(operators, this.library.OPS, base));
        } catch {
          // Decorative metadata is optional. Never sacrifice line recognition
          // when a viewer version or damaged operator list cannot provide it.
          if (!this.scanCurrent(scan)) return [];
        }
      }
      return lines.map(({ rect }) => { const a = base.convertToPdfPoint(rect[0], rect[1]), b = base.convertToPdfPoint(rect[2], rect[3]);
          return [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!)] as Rect; });
    } finally { scan.task = undefined; canvas.width = 0; canvas.height = 0; }
  }
  private async detectLines(targets: PageEntry[] = this.entries): Promise<void> {
    if (this.lineScan) {
      const active = this.lineScan.targets;
      this.cancelLineScan(); this.clearSuggestions(active); this.message.textContent = ''; return;
    }
    if (!this.pdf || !this.editor || !targets.length || this.closed) return;
    if (targets.length > MAX_AUTO_DETECT_PAGES) throw new Error('Answer-line scans are limited to 100 pages at a time.');
    if (targets.every(entry => entry.candidates !== undefined)) {
      this.clearSuggestions(targets); this.message.textContent = ''; return;
    }
    this.clearSuggestions(targets);
    const targetPages = new Set(targets.map(entry => entry.native.number));
    for (const key of this.dismissedLines) if (targetPages.has(Number(key.slice(0, key.indexOf(':'))))) this.dismissedLines.delete(key);
    const scan = this.lineScan = { generation: this.generation, targets };
    this.updateLineButton();
    this.message.classList.remove('is-error');
    try {
      for (let i = 0; i < targets.length; i++) {
        if (!this.scanCurrent(scan)) return;
        const entry = targets[i]!;
        this.message.textContent = `Scanning PDF page ${entry.native.number} of ${this.entries.length} for answer lines…`;
        const candidates = await this.detectPageLines(entry, scan);
        if (!this.scanCurrent(scan)) return;
        entry.candidates = candidates; this.scannedEntries.add(entry); entry.suggestions = entry.native.div.createDiv({ cls: 'pfs-answer-suggestions' });
        this.refreshSuggestions(entry);
        // Yield between pages so navigation and the scan button remain usable.
        if (i + 1 < targets.length) await new Promise<void>(resolve => this.root.ownerDocument.defaultView!.setTimeout(resolve, 0));
      }
      this.message.textContent = '';
    } catch (error) {
      if (this.scanCurrent(scan)) { this.clearSuggestions(targets); throw error; }
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
  private go(number: number): void { const index = Math.max(1, Math.min(this.entries.length, Math.round(number) || 1)); const entry = this.entries[index - 1]; if (entry) { this.currentPage = index; this.updateLineButton(); this.scroller.scrollTop = entry.native.div.offsetTop; this.requestVisible(); } }
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
    if (this.floatingFrame !== undefined) this.root.ownerDocument.defaultView!.cancelAnimationFrame(this.floatingFrame);
    if (this.floatingExitTimer !== undefined) this.root.ownerDocument.defaultView!.clearTimeout(this.floatingExitTimer);
    this.floatingHost?.remove(); this.floatingHost = undefined;
    if (this.editor) this.removeChild(this.editor);
    for (const entry of this.entries) { entry.version++; entry.rendering?.cancel(); entry.textTask?.cancel(); }
    if (this.task) void this.task.destroy().catch(() => {});
    for (const task of this.loadingTasks) void task.destroy().catch(() => {});
    this.loadingTasks.clear();
    this.paintedEntries.clear(); this.activeRender = undefined;
    this.root.remove(); this.native.element.classList.remove('pfs-integrated');
    this.native.element.style.removeProperty('--pfs-embed-height');
  }
}
