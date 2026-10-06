import { App, TFile } from 'obsidian';
import type { Rect } from '../pdf/text-engine';

export interface PageViewport {
  scale: number;
  rotation: number;
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportRectangle(rect: number[]): number[];
}
export interface NativePage { div: HTMLElement; viewport: PageViewport; number: number; annotationElements(id: string): HTMLElement[] }
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
  const observe = (doc: Document): void => {
    if (observers.has(doc) || !doc.body || !doc.defaultView) return;
    const observer = new doc.defaultView.MutationObserver(records => {
      // Editor rendering/typing cannot cause discovery to observe itself.
      if (records.some(mutation => !(mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement)?.closest('.pfs-surface')
        && [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType !== 1 || !(node as Element).matches('.pfs-surface')))) changed();
    });
    observer.observe(doc.body, { childList: true, subtree: true }); observers.set(doc, observer);
  };
  const refresh = (): void => {
    observe(app.workspace.rootSplit.doc);
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
