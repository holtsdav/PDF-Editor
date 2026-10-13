import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Exercise actual discovery and startup against DOM, deferring PDF/session I/O.
const host = `
  export class Component {
    cleanups = []; registerEvent() {} register(fn) { this.cleanups.push(fn); }
    registerDomEvent(el, name, fn, options) { el.addEventListener(name, fn, options); this.register(() => el.removeEventListener(name, fn, options)); }
    unload() { this.onunload?.(); for (const fn of this.cleanups.splice(0)) fn(); }
  }
  export class TFile { extension = 'pdf'; path = 'anonymous.pdf'; name = 'anonymous.pdf'; basename = 'anonymous'; }
  export const loadPdfJs = async () => ({});
  export const setIcon = () => {}; export const setTooltip = (el, text, options = {}) => { el.setAttribute('aria-label', text); el.setAttribute('data-tooltip-classes', (options.classes ?? []).join(' ')); };
`;
const output = new URL('../tmp/ui-tests/loading/', import.meta.url); await mkdir(output, { recursive: true });
// Shared host module keeps instanceof TFile consistent across both entrypoints.
await writeFile(new URL('host.mjs', output), host);
const built = await build({ entryPoints: ['src/compat/native-pdf.ts', 'src/ui/pdf-surface.ts'], bundle: true, write: false, outdir: 'out', format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'loading-host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: new URL('host.mjs', output).pathname, external: true }));
  builder.onResolve({ filter: /\/text-editor$/ }, () => ({ path: 'editor', namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class TextEditor {}' }));
} }] });
for (const file of built.outputFiles) await writeFile(new URL(file.path.split('/').at(-1)!.replace('.js', '.mjs'), output), file.text);
const { TFile } = await import(new URL('host.mjs', output).href);
const { findNativePdfs, watchNativePdfs } = await import(new URL('native-pdf.mjs', output).href);
const { PdfSurface } = await import(new URL('pdf-surface.mjs', output).href);
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('replacement PDF text explicitly permits selection outside the host native PDF container', () => {
  const f = fixture(); f.attach();
  const style = f.doc.createElement('style'); style.textContent = `body { user-select: none; } .pdf-container .textLayer { user-select: text; } ${css}`; f.doc.head.append(style);
  const layer = f.doc.createElement('div'); layer.className = 'pfs-text-layer textLayer'; layer.textContent = 'Anonymous printed PDF text'; f.element.append(layer);
  try {
    assert.equal(layer.closest('.pdf-container'), null);
    assert.equal(f.dom.window.getComputedStyle(f.doc.body).userSelect, 'none');
    assert.equal(f.dom.window.getComputedStyle(layer).userSelect, 'text');
    assert.equal(f.dom.window.getComputedStyle(layer).getPropertyValue('-webkit-user-select'), 'text');
  } finally { f.dom.window.close(); }
});

test('loaded PDF page shells retain accessible page names without page hover labels', async () => {
  const f = fixture(); const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage(); const bytes = await pdf.save();
  const surface = Object.assign(Object.create(PdfSurface.prototype), {
    root: f.doc.createElement('div'), stack: f.doc.createElement('div'), generation: 0, searchGeneration: 0,
    session: { renderEpoch: 0, renderBytes: async () => bytes.slice() }, library: { getDocument },
    loadingTasks: new Set(), entries: [], pendingRenders: new Map(), paintedEntries: new Set(),
    count: f.doc.createElement('span'), pageInput: f.doc.createElement('input'), message: f.doc.createElement('div'),
    cancelLineScan() {}, clearSuggestions() {}, layout() {}
  });
  try {
    await surface.loadDocument(); assert.equal(surface.entries.length, 2);
    for (const [index, entry] of surface.entries.entries()) {
      const page = entry.native.div as HTMLElement;
      assert.equal(page.hasAttribute('aria-label'), false); assert.equal(page.hasAttribute('title'), false);
      const label = page.querySelector<HTMLElement>(`[id="${page.getAttribute('aria-labelledby')}"]`)!;
      assert.equal(label.textContent, `Page ${index + 1}`); assert.equal(label.hidden, true);
      assert.equal(page.getAttribute('data-tooltip-classes'), 'pfs-overlay-tooltip');
    }
    const style = f.doc.createElement('style'); style.textContent = css; f.doc.head.append(style);
    const tooltip = f.doc.createElement('div'); tooltip.className = 'tooltip pfs-overlay-tooltip'; tooltip.textContent = 'Page 2'; f.doc.body.append(tooltip);
    assert.equal(f.dom.window.getComputedStyle(tooltip).display, 'none');
  } finally { await surface.task?.destroy(); f.dom.window.close(); }
});

test('gesture zoom anchors the actual PDF point through quarter turns, app scale and rapid reversals, and updates the label', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const task = getDocument({ data: await pdf.save() });
  try {
    const proxy = await (await task.promise).getPage(1);
    for (const rotation of [0, 90, 180, 270]) for (const hostScale of [1, 1.25]) {
      const f = fixture(), scroller = f.doc.createElement('div'), stack = f.doc.createElement('div'), div = f.doc.createElement('div'); stack.append(div); scroller.append(stack); f.doc.body.append(scroller);
      const entry = { page: proxy, native: { div, number: 1, viewport: proxy.getViewport({ scale: 1, rotation }) }, version: 0 };
      Object.defineProperties(scroller, { clientWidth: { value: 640 }, offsetWidth: { value: 640 }, clientHeight: { value: 400 } });
      const canvasWidth = () => Math.max(640, parseFloat(stack.style.minWidth) || 0, entry.native.viewport.width + 32);
      const topPadding = () => parseFloat(stack.style.paddingTop) || 16;
      const bottomPadding = () => parseFloat(stack.style.paddingBottom) || 16;
      let scrollX = 0, scrollY = 0;
      Object.defineProperties(scroller, {
        scrollLeft: { get: () => scrollX, set: value => { scrollX = Math.max(0, Math.min(canvasWidth() - 640, value)); } },
        scrollTop: { get: () => scrollY, set: value => { scrollY = Math.max(0, Math.min(topPadding() + entry.native.viewport.height + bottomPadding() - 400, value)); } }
      });
      scroller.getBoundingClientRect = () => ({ left: 40, top: 80, width: 640 * hostScale, height: 400 * hostScale, right: 40 + 640 * hostScale, bottom: 80 + 400 * hostScale, x: 40, y: 80, toJSON() {} });
      Object.defineProperty(div, 'offsetTop', { get: topPadding });
      div.getBoundingClientRect = () => {
        const width = parseFloat(div.style.width), height = parseFloat(div.style.height), left = 40 + ((canvasWidth() - width) / 2 - scroller.scrollLeft) * hostScale, top = 80 + (topPadding() - scroller.scrollTop) * hostScale;
        return { left, top, width: width * hostScale, height: height * hostScale, right: left + width * hostScale, bottom: top + height * hostScale, x: left, y: top, toJSON() {} };
      };
      const surface = Object.assign(Object.create(PdfSurface.prototype), { root: f.doc.createElement('div'), native: { element: f.doc.createElement('div') }, scroller, stack, entries: [entry], currentPage: 1, rotation, scale: 1, zoomButton: f.doc.createElement('button'), closed: false, refreshSuggestions() {}, requestVisible() {}, queueFloatingToolbar() {} });
      try {
        surface.layout(); scroller.scrollTop = 160; scroller.scrollLeft = 50;
        const x = 40 + 300 * hostScale, y = 80 + 200 * hostScale;
        const point = () => { const r = div.getBoundingClientRect(), v = entry.native.viewport; return v.convertToPdfPoint((x - r.left) * v.width / r.width, (y - r.top) * v.height / r.height); };
        const before = point(); surface.zoomAt(1.25, x, y); const after = point();
        assert(Math.hypot(before[0]! - after[0]!, before[1]! - after[1]!) < 1e-8); assert.equal(surface.zoomButton.textContent, '125%');
        surface.zoomAt(0.8, x, y); assert.equal(surface.zoomButton.textContent, '100%');
        surface.zoomAt(0.5, x, y); const smaller = point(); assert(Math.hypot(before[0]! - smaller[0]!, before[1]! - smaller[1]!) < 1e-8);
        // Fit width can keep the viewport unchanged while removing the gesture's anchor margins.
        const fitScale = 608 / proxy.getViewport({ scale: 1, rotation }).width;
        surface.zoomAt(fitScale / surface.scale, x, y); scroller.scrollTop = topPadding() + 32;
        const version = entry.version, fitPoint = point();
        surface.scale = 'width'; surface.layout();
        assert.equal(entry.version, version); assert.equal(surface.panSpace, false); assert.equal(scroller.scrollTop, 48);
        const verticalAxis = rotation % 180 === 90 ? 0 : 1;
        assert(Math.abs(point()[verticalAxis]! - fitPoint[verticalAxis]!) < 1e-8);
        assert.equal(surface.zoomButton.textContent, 'Fit width');
        surface.zoomAt(100, x, y); assert.equal(surface.scale, 3); surface.zoomAt(0.001, x, y); assert.equal(surface.scale, 0.35);
        surface.scale = 'width'; surface.layout(); assert.equal(surface.zoomButton.textContent, 'Fit width');
      } finally { f.dom.window.close(); }
    }
  } finally { await task.destroy(); }
});

/** Provide a disposable native-host DOM and workspace events without performing session I/O. */
function fixture() {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true }); const doc = dom.window.document;
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; type?: string; attr?: Record<string, string> } = {}) {
      const el = this.ownerDocument.createElement(tag); el.className = options.cls ?? ''; el.textContent = options.text ?? '';
      if (options.type) el.setAttribute('type', options.type);
      for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
      this.append(el); return el;
    },
    createDiv(this: HTMLElement, options: object) { return (this as HTMLElement & { createEl(tag: string, options: object): HTMLElement }).createEl('div', options); },
    createSpan(this: HTMLElement, options: object) { return (this as HTMLElement & { createEl(tag: string, options: object): HTMLElement }).createEl('span', options); }
  });
  Object.assign(dom.window, { ResizeObserver: class { observe() {} disconnect() {} } });
  const file = new TFile(), element = doc.createElement('div'); element.className = 'pdf-embed';
  element.innerHTML = '<div class="native-toolbar">Native PDF toolbar</div><div class="native-pages"></div>';
  const owner = { file, containerEl: element, _children: [{ containerEl: element, getPage() {} }] };
  const events = new Map<string, (...args: unknown[]) => void>();
  const workspace = { rootSplit: { doc }, iterateAllLeaves(callback: (leaf: object) => void) { callback({ view: { containerEl: doc.querySelector('main'), _children: [owner] } }); },
    on(name: string, callback: (...args: unknown[]) => void) { events.set(name, callback); return name; }, offref(name: string) { events.delete(name); } };
  return { dom, doc, file, element, owner, events, app: { workspace, vault: { on() {} } }, attach: () => doc.querySelector('main')!.append(element) };
}

test('early embed discovery needs no ready PDF viewer and returns a single stable host', () => {
  const f = fixture();
  try {
    assert.deepEqual(findNativePdfs(f.app), []); f.attach();
    const viewers = findNativePdfs(f.app); assert.equal(viewers.length, 1); assert.equal(viewers[0].element, f.element); assert.equal(viewers[0].identity, f.owner);
    delete (f.owner._children[0] as { getPage?: unknown }).getPage;
    assert.equal(findNativePdfs(f.app).length, 1);
  } finally { f.dom.window.close(); }
});

test('host insertion is discovered before the next paint; editor updates are ignored and disposal restores silence', async () => {
  const f = fixture(); let calls = 0;
  const stop = watchNativePdfs(f.app, () => { calls++; assert.equal(findNativePdfs(f.app).length, 1); });
  try {
    f.attach(); await Promise.resolve(); assert.equal(calls, 1);
    const surface = f.doc.createElement('div'); surface.className = 'pfs-surface'; f.element.append(surface); await Promise.resolve(); assert.equal(calls, 1);
    surface.append(f.doc.createElement('textarea')); await Promise.resolve(); assert.equal(calls, 1);
    stop(); f.element.append(f.doc.createElement('div')); await Promise.resolve(); assert.equal(calls, 1); assert.equal(f.events.size, 0);
  } finally { stop(); f.dom.window.close(); }
});

test('observer startup tolerates a vault window before its root document is ready', async () => {
  const f = fixture(); let calls = 0;
  Object.assign(f.app.workspace.rootSplit, { doc: null });
  const stop = watchNativePdfs(f.app, () => { calls++; });
  try {
    f.attach(); await Promise.resolve(); assert.equal(calls, 1);
  } finally { stop(); f.dom.window.close(); }
});

test('new pop-out documents are observed and closing one disconnects its observer', async () => {
  const f = fixture(), popout = new JSDOM('<body></body>'); let calls = 0;
  const stop = watchNativePdfs(f.app, () => { calls++; });
  try {
    f.events.get('window-open')!({}, popout.window); assert.equal(calls, 1);
    popout.window.document.body.append(popout.window.document.createElement('div')); await Promise.resolve(); assert.equal(calls, 2);
    f.events.get('window-close')!({}, popout.window);
    popout.window.document.body.append(popout.window.document.createElement('div')); await Promise.resolve(); assert.equal(calls, 2);
  } finally { stop(); f.dom.window.close(); popout.window.close(); }
});

test('opening hides native chrome immediately and a failed session restores the native viewer', async () => {
  const f = fixture(); f.attach(); const style = f.doc.createElement('style'); style.textContent = css; f.doc.head.append(style);
  const stale = f.doc.createElement('div'); stale.className = 'pfs-surface'; f.element.append(stale);
  let reject!: (error: Error) => void, released = 0;
  const pending = new Promise((_, no) => { reject = no; });
  const preferences = { toolbarTopOffset: 48 }; let preferenceChanged: () => void = () => {}, unsubscribed = false;
  const surface = new PdfSurface(f.app, { identity: f.owner, file: f.file, element: f.element }, {
    preferences, retain: () => () => { released++; }, get: () => pending,
    subscribePreferences: (listener: () => void) => { preferenceChanged = listener; return () => { unsubscribed = true; }; }
  });
  try {
    assert.equal(stale.isConnected, false); assert.equal(f.element.querySelectorAll('.pfs-surface').length, 1);
    assert.equal(f.element.querySelector<HTMLElement>('.pfs-surface')?.style.getPropertyValue('--pfs-toolbar-top-offset'), '48px');
    preferences.toolbarTopOffset = 96; preferenceChanged();
    assert.equal(f.element.querySelector<HTMLElement>('.pfs-surface')?.style.getPropertyValue('--pfs-toolbar-top-offset'), '96px');
    assert(f.element.classList.contains('pfs-integrated'));
    assert.equal(f.dom.window.getComputedStyle(f.element.querySelector('.native-toolbar')!).display, 'none');
    assert.equal(f.element.querySelector('[role=status]')?.textContent, 'Opening PDF…');
    reject(new Error('Unsupported test document')); await pending.catch(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.element.classList.contains('pfs-integrated'), false);
    assert.notEqual(f.dom.window.getComputedStyle(f.element.querySelector('.native-toolbar')!).display, 'none');
    assert.equal(f.dom.window.getComputedStyle(f.element.querySelector('.pfs-navigation')!).display, 'none');
    assert.equal(f.dom.window.getComputedStyle(f.element.querySelector('.pfs-surface')!).height, 'auto');
    assert.equal(f.element.querySelector('[role=status]')?.textContent, 'Unsupported test document');
  } finally { surface.unload(); assert.equal(released, 1); assert.equal(unsubscribed, true); assert.equal(f.element.querySelector('.pfs-surface'), null); f.dom.window.close(); }
});

test('fast scrolling cancels distant rendering and releases its bitmap and text layer', () => {
  const f = fixture(); let cancelled = 0, textCancelled = 0;
  const page = f.doc.createElement('div'), canvas = f.doc.createElement('canvas'), text = f.doc.createElement('div'), links = f.doc.createElement('div');
  canvas.width = 500; canvas.height = 700; text.textContent = 'Previous page text'; links.textContent = 'Previous link';
  Object.defineProperties(page, { offsetTop: { value: 0 }, offsetHeight: { value: 700 } });
  const scroller = f.doc.createElement('div'); scroller.scrollTop = 4000;
  Object.defineProperties(scroller, { clientWidth: { value: 500 }, clientHeight: { value: 800 } });
  const entry = { native: { div: page, number: 1 }, page: { cleanup() {} }, canvas, text, links, painted: 1, version: 1,
    rendering: { cancel() { cancelled++; } }, textTask: { cancel() { textCancelled++; } } };
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root: f.doc.createElement('div'), scroller, entries: [entry],
    currentPage: 1, pageInput: f.doc.createElement('input'), previous: f.doc.createElement('button'), next: f.doc.createElement('button'), closed: false,
    activeRender: entry, paintedEntries: new Set([entry]), pendingRenders: new Map() });
  try {
    (surface as { paintVisible(): void }).paintVisible();
    assert.equal(cancelled, 1); assert.equal(textCancelled, 1);
    assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(entry.painted, -1);
    assert.equal(text.childElementCount, 0); assert.equal(text.textContent, ''); assert.equal(links.textContent, '');
  } finally { f.dom.window.close(); }
});

test('a long PDF queues only pages near a fast-scroll destination', async () => {
  const f = fixture(), scroller = f.doc.createElement('div'); scroller.scrollTop = 99 * 700;
  Object.defineProperties(scroller, { clientWidth: { value: 500 }, clientHeight: { value: 700 } });
  const entries = Array.from({ length: 200 }, (_, index) => {
    const div = f.doc.createElement('div'); f.doc.body.append(div);
    Object.defineProperties(div, { offsetTop: { value: index * 700 }, offsetHeight: { value: 700 } });
    return { native: { div, number: index + 1 }, version: 1, painted: -1 };
  });
  const painted: number[] = [];
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root: f.doc.createElement('div'), scroller, entries,
    currentPage: 1, pageInput: f.doc.createElement('input'), previous: f.doc.createElement('button'), next: f.doc.createElement('button'), closed: false,
    paintedEntries: new Set(), pendingRenders: new Map(), renderQueue: Promise.resolve(), paint: async (entry: { native: { number: number } }) => { painted.push(entry.native.number); } });
  try {
    (surface as { paintVisible(): void }).paintVisible();
    await (surface as { renderQueue: Promise<void> }).renderQueue;
    assert.equal(surface.currentPage, 100);
    assert(painted.length <= 4, 'Only the destination and adjacent pages should be queued');
    assert(painted.includes(100));
  } finally { f.dom.window.close(); }
});

test('distant printed text stays copyable across pages until its selection ends, without retaining note selections', () => {
  const f = fixture(), root = f.doc.createElement('div'), scroller = f.doc.createElement('div'); root.append(scroller); f.doc.body.append(root);
  scroller.scrollTop = 4000; Object.defineProperties(scroller, { clientWidth: { value: 500 }, clientHeight: { value: 700 } });
  let cleaned = 0;
  const entries = Array.from({ length: 2 }, (_, index) => {
    const div = f.doc.createElement('div'), canvas = f.doc.createElement('canvas'), text = f.doc.createElement('div'), links = f.doc.createElement('div');
    text.className = 'pfs-text-layer'; text.textContent = `Copy page ${index + 1}`; canvas.width = 500; canvas.height = 700;
    div.append(canvas, text, links); scroller.append(div); Object.defineProperties(div, { offsetTop: { value: index * 700 }, offsetHeight: { value: 700 } });
    return { native: { div, number: index + 1 }, canvas, text, links, page: { cleanup() { cleaned++; } }, version: 1, painted: 1 };
  });
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root, scroller, entries, currentPage: 1, pageInput: f.doc.createElement('input'),
    previous: f.doc.createElement('button'), next: f.doc.createElement('button'), closed: false, paintedEntries: new Set(entries), pendingRenders: new Map() });
  const selection = f.doc.getSelection()!, range = f.doc.createRange();
  try {
    range.setStart(entries[0]!.text.firstChild!, 0); range.setEnd(entries[1]!.text.firstChild!, 11); selection.addRange(range);
    const value = selection.toString(); surface.paintVisible();
    assert.equal(cleaned, 0); assert.equal(surface.retainedSelection, true); assert.equal(selection.toString(), value);
    for (const entry of entries) assert.equal(entry.canvas.width, 500);
    selection.removeAllRanges();
    const note = f.doc.createElement('p'); note.textContent = 'Note selection'; f.doc.body.append(note); range.selectNodeContents(note); selection.addRange(range);
    surface.paintVisible(); assert.equal(cleaned, 2); assert.equal(surface.retainedSelection, false); assert.equal(selection.toString(), 'Note selection');
    for (const entry of entries) { assert.equal(entry.canvas.width, 0); assert.equal(entry.text.textContent, ''); }
    const other = f.doc.createElement('div'); other.className = 'pfs-text-layer'; other.textContent = 'Another PDF'; f.doc.body.append(other);
    selection.removeAllRanges(); range.selectNodeContents(other); selection.addRange(range);
    assert.equal(surface.selectedTextRange(), undefined, 'another editor owns its printed-text selection');
  } finally { f.dom.window.close(); }
});

test('selection changes release retained pages through a disposed viewer-owned listener', () => {
  const f = fixture(); f.attach();
  const surface = new PdfSurface(f.app, { identity: f.owner, file: f.file, element: f.element }, {
    preferences: { toolbarTopOffset: 0 }, retain: () => () => {}, get: () => new Promise(() => {}), subscribePreferences: () => () => {}
  });
  try {
    let calls = 0; surface.requestVisible = () => { calls++; };
    f.doc.dispatchEvent(new f.dom.window.Event('selectionchange')); assert.equal(calls, 0);
    surface.retainedSelection = true; f.doc.dispatchEvent(new f.dom.window.Event('selectionchange')); assert.equal(calls, 1);
    surface.unload(); f.doc.dispatchEvent(new f.dom.window.Event('selectionchange')); assert.equal(calls, 1);
  } finally { surface.unload(); f.dom.window.close(); }
});

test('450-page rapid scroll bursts replace stale jobs, cancel raster and text work, and retain only nearby resources', async () => {
  const f = fixture(), scroller = f.doc.createElement('div');
  Object.defineProperties(scroller, { clientWidth: { value: 500 }, clientHeight: { value: 700 } });
  const rastered: number[] = [], cleaned: number[] = [], canvases: HTMLCanvasElement[] = [];
  let rasterStarted!: () => void, textStarted!: () => void;
  const firstRaster = new Promise<void>(resolve => { rasterStarted = resolve; }), firstText = new Promise<void>(resolve => { textStarted = resolve; });
  f.dom.window.HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement) { canvases.push(this); return {}; } as unknown as typeof f.dom.window.HTMLCanvasElement.prototype.getContext;
  const entries = Array.from({ length: 450 }, (_, index) => {
    let renders = 0;
    const div = f.doc.createElement('div'), canvas = f.doc.createElement('canvas'), text = f.doc.createElement('div'), links = f.doc.createElement('div'); div.append(canvas, text, links); f.doc.body.append(div);
    Object.defineProperties(div, { offsetTop: { value: index * 700 }, offsetHeight: { value: 700 } });
    return { native: { div, number: index + 1, viewport: { scale: 1, rotation: 0 } }, canvas, text, links, version: 1, painted: -1,
      page: {
        getViewport: () => ({ width: 500, height: 700 }), cleanup: () => { cleaned.push(index + 1); return true; },
        render: () => {
          rastered.push(index + 1); let reject!: (error: Error) => void;
          const promise = index === 0 && ++renders === 1 ? new Promise<void>((_, no) => { reject = no; rasterStarted(); }) : Promise.resolve();
          return { promise, cancel() { const error = new Error('Cancelled raster'); error.name = 'RenderingCancelledException'; reject?.(error); } };
        },
        streamTextContent: () => ({ number: index + 1 }), getAnnotations: async () => []
      } };
  });
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root: f.doc.createElement('div'), scroller, entries, search: f.doc.createElement('input'),
    currentPage: 1, pageInput: f.doc.createElement('input'), previous: f.doc.createElement('button'), next: f.doc.createElement('button'), closed: false,
    paintedEntries: new Set(), pendingRenders: new Map(), renderQueue: Promise.resolve(), fail(error: unknown) { throw error; },
    library: { TextLayer: class {
      private reject?: (error: Error) => void;
      private options: { container: HTMLElement; textContentSource: { number: number } };
      constructor(options: { container: HTMLElement; textContentSource: { number: number } }) { this.options = options; }
      async render() { if (this.options.textContentSource.number === 449) await new Promise<void>((_, no) => { this.reject = no; textStarted(); }); this.options.container.textContent = 'Anonymous page text'; }
      cancel() { const error = new Error('Cancelled text'); error.name = 'AbortException'; this.reject?.(error); }
    } } });
  try {
    surface.paintVisible(); await firstRaster;
    for (const number of [225, 450, 20, 360, 449]) { scroller.scrollTop = (number - 1) * 700; surface.paintVisible(); assert(surface.pendingRenders.size <= 3); }
    await firstText;
    assert.equal(canvases[0]!.width, 0, 'cancelled offscreen raster is released');
    for (const number of [450, 180, 2]) { scroller.scrollTop = (number - 1) * 700; surface.paintVisible(); assert(surface.pendingRenders.size <= 3); }
    await surface.renderQueue;
    assert.equal(surface.currentPage, 2); assert.equal(surface.pageInput.value, '2');
    assert.deepEqual(rastered.slice(0, 2), [1, 449], 'the latest visible destination precedes every prefetch job');
    assert(rastered.length <= 5, 'intermediate scroll destinations never reach the renderer');
    assert(cleaned.includes(1) && cleaned.includes(449)); assert(surface.paintedEntries.size <= 3);
    assert.equal(entries[448]!.canvas.width, 0); assert.equal(entries[448]!.text.textContent, '');
    assert(entries[1]!.canvas.width > 0); assert.equal(entries[1]!.text.textContent, 'Anonymous page text');
    assert.equal(surface.pendingRenders.size, 0);
  } finally { f.dom.window.close(); }
});

test('internal PDF scroll bursts never relocate the page controls; note scrolling still schedules docking', () => {
  const f = fixture(); f.attach();
  const surface = new PdfSurface(f.app, { identity: f.owner, file: f.file, element: f.element }, {
    preferences: { toolbarTopOffset: 0 }, retain: () => () => {}, get: () => new Promise(() => {}), subscribePreferences: () => () => {}
  });
  try {
    let dockChecks = 0; surface.queueFloatingToolbar = () => { dockChecks++; };
    const pages = f.element.querySelector<HTMLElement>('.pfs-pages')!, input = f.element.querySelector('input[aria-label="Page"]')!, parent = input.parentElement;
    for (let i = 0; i < 200; i++) pages.dispatchEvent(new f.dom.window.Event('scroll'));
    assert.equal(dockChecks, 0); assert.equal(input.parentElement, parent);
    f.doc.querySelector('main')!.dispatchEvent(new f.dom.window.Event('scroll'));
    assert.equal(dockChecks, 1);
  } finally { surface.unload(); f.dom.window.close(); }
});

test('unloading a viewer releases every retained bitmap and page resource', () => {
  const f = fixture(); f.attach(); let cleaned = 0;
  const surface = new PdfSurface(f.app, { identity: f.owner, file: f.file, element: f.element }, {
    preferences: { toolbarTopOffset: 0 }, retain: () => () => {}, get: () => new Promise(() => {}), subscribePreferences: () => () => {}
  });
  const entries = Array.from({ length: 3 }, (_, index) => {
    const canvas = f.doc.createElement('canvas'), text = f.doc.createElement('div'), links = f.doc.createElement('div'); canvas.width = 1200; canvas.height = 1600; text.textContent = 'Anonymous text';
    return { native: { div: f.doc.createElement('div'), number: index + 1 }, page: { cleanup() { cleaned++; } }, canvas, text, links, version: 1, painted: 1 };
  });
  try {
    surface.entries = entries; surface.paintedEntries = new Set(entries); surface.unload();
    assert.equal(cleaned, 3);
    for (const entry of entries) { assert.equal(entry.canvas.width, 0); assert.equal(entry.canvas.height, 0); assert.equal(entry.text.textContent, ''); }
    assert.equal(f.element.querySelector('.pfs-surface'), null);
  } finally { f.dom.window.close(); }
});
