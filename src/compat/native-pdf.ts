import { App, TFile } from 'obsidian';
import type { Rect } from '../pdf/text-engine';
import type { TextWord } from '../pdf/marker-text';
import type { Editor, MarkdownView, MarkdownFileInfo } from 'obsidian';

export interface PageViewport {
  scale: number;
  rotation: number;
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportRectangle(rect: number[]): number[];
}
export interface NativePage { div: HTMLElement; viewport: PageViewport; number: number; textWords?: TextWord[]; annotationElements(id: string): HTMLElement[] }
export interface NativePdf {
  identity: object;
  element: HTMLElement;
  file: TFile;
  initialPage?: number;
  embedHeight?: number;
}
export interface EditorSurface extends NativePdf {
  pages(): NativePage[];
  toolbarHost(): HTMLElement;
  answerLineButton(): HTMLButtonElement;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}
function element(value: unknown): value is HTMLElement {
  const object = record(value);
  return object?.nodeType === 1 && typeof object.querySelectorAll === 'function';
}

/** All access to Obsidian's undocumented PDF/component internals is confined here. */
export function findNativePdfs(app: App): NativePdf[] {
  const found: NativePdf[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number, owner?: object): void => {
    const object = record(value);
    if (!object || seen.has(object) || depth > 12) return;
    seen.add(object);
    const anchor = owner ?? (object.file instanceof TFile && object.file.extension.toLowerCase() === 'pdf' ? object : undefined);
    // The native child temporarily clears file while reopening after a vault
    // write. Its owner still identifies the document during that interval.
    const file = object.file instanceof TFile ? object.file : record(anchor)?.file;
    if (file instanceof TFile && file.extension.toLowerCase() === 'pdf' && element(object.containerEl)
      && object.containerEl.isConnected && (typeof object.getPage === 'function' || object.containerEl.matches('.pdf-embed'))) {
      const container = object.containerEl;
      const subpath = record(anchor)?.subpath;
      const params = typeof subpath === 'string' ? new URLSearchParams(subpath.replace(/^#/, '')) : undefined;
      const initialPage = Number(params?.get('page')) || 1;
      const embedHeight = Number(params?.get('height')) || undefined;
      const identity = anchor ?? object;
      if (!found.some(viewer => viewer.identity === identity || viewer.element === container)) found.push({ identity, element: container, file, initialPage, embedHeight });
    }
    if (Array.isArray(object._children)) for (const child of object._children) visit(child, depth + 1, anchor);
    // Reading mode owns embed components separately from the view's _children.
    for (const key of ['viewer', 'child', 'previewMode']) visit(object[key], depth + 1, anchor);
  };
  app.workspace.iterateAllLeaves(leaf => visit(leaf.view, 0));
  return found;
}

/** Discover inserted/replaced hosts before the next paint, including pop-outs. */
export function watchNativePdfs(app: App, changed: () => void): () => void {
  const observers = new Map<Document, MutationObserver>();
  const observe = (doc: Document | null | undefined): void => {
    if (!doc || observers.has(doc) || !doc.body || !doc.defaultView) return;
    const observer = new doc.defaultView.MutationObserver(records => {
      // Editor rendering/typing cannot cause discovery to observe itself.
      if (records.some(mutation => !(mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement)?.closest('.pfs-surface')
        && [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType !== 1 || !(node as Element).matches('.pfs-surface')))) changed();
    });
    observer.observe(doc.body, { childList: true, subtree: true }); observers.set(doc, observer);
  };
  const refresh = (): void => {
    observe(app.workspace.rootSplit?.doc);
    app.workspace.iterateAllLeaves(leaf => observe(leaf.view.containerEl.ownerDocument));
  };
  const events = [
    app.workspace.on('layout-change', refresh),
    app.workspace.on('window-open', (_win, window) => { observe(window.document); changed(); }),
    app.workspace.on('window-close', (_win, window) => { observers.get(window.document)?.disconnect(); observers.delete(window.document); })
  ];
  refresh();
  return () => { for (const event of events) app.workspace.offref(event); for (const observer of observers.values()) observer.disconnect(); observers.clear(); };
}

export function screenRectangle(viewport: PageViewport, rect: Rect): Rect {
  const converted = viewport.convertToViewportRectangle(rect);
  return [Math.min(converted[0]!, converted[2]!), Math.min(converted[1]!, converted[3]!),
    Math.max(converted[0]!, converted[2]!), Math.max(converted[1]!, converted[3]!)];
}

export function pdfRectangle(viewport: PageViewport, start: [number, number], end: [number, number]): Rect {
  const a = viewport.convertToPdfPoint(...start);
  const b = viewport.convertToPdfPoint(...end);
  return [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[0]!, b[0]!), Math.max(a[1]!, b[1]!)];
}

interface NativeImportOptions<S> {
  enabled(): boolean;
  path(file: File): string;
  prepare(path: string, file: File): Promise<S | null>;
  imported(source: S, file: TFile, bytes: Uint8Array): Promise<void>;
  skipped(): void;
  failed(error: unknown): void;
}
interface NativeAttachment { filepath?: string; extension?: string; data?: Promise<ArrayBuffer> }
interface ClipboardManager {
  info: MarkdownView | MarkdownFileInfo;
  insertFiles(items: NativeAttachment[]): Promise<void>;
  insertAttachmentEmbed(file: TFile, trailing?: boolean): void;
}
type AttachmentSaver = (name: string, extension: string, bytes: ArrayBuffer) => Promise<TFile>;

/** Observe exact native buffers/results; never take over the drop or guess a source by its filename. */
export function observeNativePdfImports<S>(app: App, options: NativeImportOptions<S>): () => void {
  const host = app as App & { saveAttachment?: AttachmentSaver };
  const originalSave = host.saveAttachment;
  if (typeof originalSave !== 'function') return () => {};
  type Ticket = { source: Promise<S | null>; info: MarkdownView | MarkdownFileInfo; note: TFile | null; editor: Editor; bytes: Uint8Array; claimed: boolean; cancelled: boolean };
  const buffers = new WeakMap<ArrayBuffer, Ticket>(), destinations = new Map<TFile, Ticket>();
  const contexts = new Set<() => void>(); let closed = false;
  const active = () => !closed && options.enabled();
  const save: AttachmentSaver = function(this: App, name, extension, bytes) {
    const result = originalSave.call(this, name, extension, bytes), ticket = buffers.get(bytes);
    if (ticket && !ticket.claimed && !ticket.cancelled && active()) {
      ticket.claimed = true;
      if (!result || typeof result.then !== 'function') { ticket.cancelled = true; options.skipped(); return result; }
      void result.then(file => { if (file instanceof TFile && !ticket.cancelled && active()) destinations.set(file, ticket); }, () => { ticket.cancelled = true; });
    }
    return result;
  };
  host.saveAttachment = save;
  const drop = app.workspace.on('editor-drop', (event, editor, info) => {
    if (!active() || event.defaultPrevented || !event.dataTransfer || contexts.size >= 8) return;
    const note = info.file;
    const files = new Map<string, File>();
    for (const file of Array.from(event.dataTransfer.files)) if (/\.pdf$/i.test(file.name)) {
      try { const path = options.path(file); if (path) { if (files.has(path)) return; files.set(path, file); } } catch { /* Unsupported OS handle: native import still proceeds. */ }
    }
    if (!files.size) return;
    if (files.size > 32 || [...files.values()].reduce((sum, file) => sum + file.size, 0) > 100_000_000) { options.skipped(); return; }
    const manager = record(record(info)?.sourceMode)?.clipboardManager as ClipboardManager | undefined;
    if (!manager || manager.info !== info || typeof manager.insertFiles !== 'function' || typeof manager.insertAttachmentEmbed !== 'function') { options.skipped(); return; }
    const insertFiles = manager.insertFiles, insertEmbed = manager.insertAttachmentEmbed;
    const tickets = new Set<Ticket>(); let ended = false;
    const container = record(info)?.containerEl;
    const view = (element(container) ? container.ownerDocument.defaultView : undefined) ?? window;
    const dispose = () => {
      if (ended) return; ended = true; contexts.delete(dispose); view.clearTimeout(timer);
      for (const ticket of tickets) ticket.cancelled = true;
      for (const [file, ticket] of destinations) if (tickets.has(ticket)) destinations.delete(file);
      if (manager.insertFiles === insert) manager.insertFiles = insertFiles;
      if (manager.insertAttachmentEmbed === embed) manager.insertAttachmentEmbed = insertEmbed;
    };
    const embed: ClipboardManager['insertAttachmentEmbed'] = function(this: ClipboardManager, file, trailing) {
      const before = editor.getValue(); insertEmbed.call(this, file, trailing);
      const ticket = destinations.get(file);
      if (!ticket || !tickets.has(ticket)) return;
      destinations.delete(file);
      if (ticket.cancelled || !active() || info.file !== ticket.note || editor.getValue() === before) return;
      // Begin verification after the native embed insertion succeeded, before releasing this context.
      void ticket.source.then(async source => {
        if (source && active()) await options.imported(source, file, ticket.bytes);
        else if (active()) options.skipped();
      }).catch(error => { if (active()) options.failed(error); });
    };
    const insert: ClipboardManager['insertFiles'] = function(this: ClipboardManager, items) {
      // Only the insertFiles call made synchronously by this drop owns these descriptors.
      if (ended || manager.insertFiles !== insert) return insertFiles.call(this, items);
      manager.insertFiles = insertFiles;
      for (const item of items) {
        const file = item.filepath ? files.get(item.filepath) : undefined;
        if (!file || item.extension?.toLowerCase() !== 'pdf' || !item.data) continue;
        const source = options.prepare(item.filepath!, file).catch(() => null);
        void item.data.then(bytes => {
          if (ended || !active() || Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]') return;
          if (buffers.has(bytes)) { buffers.get(bytes)!.cancelled = true; return; }
          const ticket: Ticket = { source, info, note, editor, bytes: new Uint8Array(bytes.slice(0)), claimed: false, cancelled: false };
          tickets.add(ticket); buffers.set(bytes, ticket);
        }, () => {});
      }
      const result = insertFiles.call(this, items);
      if (result && typeof result.then === 'function') void result.then(dispose, dispose); else dispose();
      return result;
    };
    manager.insertFiles = insert; manager.insertAttachmentEmbed = embed;
    const timer = view.setTimeout(dispose, 60_000); contexts.add(dispose);
    // Cancelled, modifier-link and handled HTML drops never call native insertFiles.
    queueMicrotask(() => { if (manager.insertFiles === insert) dispose(); });
  });
  return () => { closed = true; app.workspace.offref(drop); for (const dispose of [...contexts]) dispose(); destinations.clear(); if (host.saveAttachment === save) host.saveAttachment = originalSave; };
}
