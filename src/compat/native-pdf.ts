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
  source: object;
  element: HTMLElement;
  file: TFile;
  pages(): NativePage[];
  textInputs(): (HTMLInputElement | HTMLTextAreaElement)[];
  toolbarHost(): HTMLElement | null;
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
    if (object.file instanceof TFile && object.file.extension.toLowerCase() === 'pdf' && element(object.containerEl)
      && object.containerEl.isConnected && typeof object.getPage === 'function' && record(object.pdfViewer)) {
      const container = object.containerEl;
      const getPage = object.getPage as (page: number) => unknown;
      found.push({
        identity: anchor ?? object, source: object, element: container, file: object.file,
        textInputs: () => [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.annotationLayer input[type="text"], .annotationLayer textarea')],
        toolbarHost: () => container.querySelector<HTMLElement>('.pdf-toolbar:not(.pdf-findbar)'),
        pages: () => {
          const pages: NativePage[] = [];
          for (const div of container.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
            const number = Number(div.dataset.pageNumber);
            try {
              const view = record(getPage.call(object, number));
              const viewport = record(view?.viewport);
              if (viewport && typeof viewport.convertToPdfPoint === 'function' && typeof viewport.convertToViewportRectangle === 'function') {
                pages.push({ div, viewport: viewport as unknown as PageViewport, number,
                  annotationElements: id => [...div.querySelectorAll<HTMLElement>('.annotationLayer [data-annotation-id]')].filter(element => element.dataset.annotationId === id) });
              }
            } catch { /* Page not yet rendered; next scan retries. */ }
          }
          return pages;
        }
      });
    }
    if (Array.isArray(object._children)) for (const child of object._children) visit(child, depth + 1, anchor);
    // Reading mode owns embed components separately from the view's _children.
    for (const key of ['viewer', 'child', 'previewMode']) visit(object[key], depth + 1, anchor);
  };
  app.workspace.iterateAllLeaves(leaf => visit(leaf.view, 0));
  return found;
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
