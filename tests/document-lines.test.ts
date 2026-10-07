import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OperatorList } from '../src/compat/pdf-artifacts.ts';
import type { Rect } from '../src/pdf/text-engine.ts';

// Exercise the production scan lifecycle and suggestion handlers, mocking only
// the host and raster renderer. This requires no bundled fixture dependencies.
const bundle = await build({ entryPoints: ['src/ui/pdf-surface.ts'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'scan-host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'host', namespace: 'test' }));
  builder.onResolve({ filter: /\/text-editor$/ }, () => ({ path: 'editor', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'editor' ? 'export class TextEditor {}' : `
    export class Component {} export class Scope {} export class Menu {} export class Modal {} export class Notice {}
    export class TFile {} export class App {} export const loadPdfJs = () => {};
    export const setIcon = () => {}; export const setTooltip = (el, text) => el.setAttribute('aria-label', text);
  ` }));
} }] });
const moduleUrl = new URL('../tmp/ui-tests/document-lines.mjs', import.meta.url);
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true }); await writeFile(moduleUrl, bundle.outputFiles[0]!.text);
const { PdfSurface } = await import(moduleUrl.href);
interface Entry { page: { getOperatorList?: () => Promise<OperatorList> }; native: { div: HTMLElement; number: number; viewport: object }; candidates?: Rect[]; suggestions?: HTMLElement }
interface Harness {
  detectLines(targets?: Entry[]): Promise<void>; cancelLineScan(): void; clearSuggestions(): void; refreshSuggestions(): void;
  answerLineActions(): { title: string; run(): void; clear?: () => void };
  dismissRemovedAnswer(field: { widgets: { page: number; rect: Rect }[] }): void;
  generation: number; closed: boolean; currentPage: number; entries: Entry[]; lineScan?: object; message: HTMLElement; lineButton: HTMLButtonElement;
}
function fixture(lines = [1, 2, 0, 1]) {
  const dom = new JSDOM('<body><div id="root"></div><div id="message"></div></body>');
  const doc = dom.window.document, root = doc.querySelector<HTMLElement>('#root')!;
  let active = 0, peak = 0, cancellations = 0;
  const fields: { widgets: { page: number; rect: Rect }[] }[] = [];
  const visited: number[] = [], canvases: HTMLCanvasElement[] = [], chosen: { page: number; rect: Rect }[] = [];
  const contexts = new WeakMap<object, { canvas: HTMLCanvasElement; data: Uint8ClampedArray; getImageData(): object }>();
  dom.window.HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement) {
    canvases.push(this);
    const context = { canvas: this, data: new Uint8ClampedArray(this.width * this.height * 4).fill(255), getImageData() { return { width: this.canvas.width, height: this.canvas.height, data: this.data }; } };
    contexts.set(this, context); return context;
  } as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const create = function(this: HTMLElement, tag: string, options: { cls?: string; attr?: Record<string, string> } = {}) {
    const el = doc.createElement(tag); el.className = options.cls ?? ''; for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value); this.append(el); return el;
  };
  Object.assign(dom.window.HTMLElement.prototype, { createEl: create, createDiv(this: HTMLElement, options: object) { return create.call(this, 'div', options); } });
  const starts = lines.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  });
  const gates = new Map<number, { promise: Promise<void>; release(): void }>();
  const hold = (page: number) => { let release!: () => void; gates.set(page, { promise: new Promise<void>(resolve => { release = resolve; }), release }); return release; };
  let failPage = 0;
  const entries = lines.map((count, index) => {
    const number = index + 1, div = doc.createElement('div'); root.append(div);
    const viewport = (scale: number) => ({ width: 600 * scale, height: 800 * scale, scale, rotation: 0,
      convertToPdfPoint: (x: number, y: number) => [x + index * 10, 800 - y], convertToViewportRectangle: (rect: number[]) => [rect[0]! - index * 10, 800 - rect[1]!, rect[2]! - index * 10, 800 - rect[3]!] });
    return { native: { div, number, viewport: viewport(1) }, page: {
      getViewport({ scale, rotation }: { scale: number; rotation: number }) { assert.equal(rotation, 0); return viewport(scale); },
      render({ canvasContext, annotationMode }: { canvasContext: { canvas: HTMLCanvasElement }; annotationMode: number }) {
        assert.equal(annotationMode, 0); starts[index]!.resolve(); visited.push(number); peak = Math.max(peak, ++active);
        const context = contexts.get(canvasContext.canvas)!, canvas = context.canvas, sx = canvas.width / 600, sy = canvas.height / 800;
        for (let n = 0; n < count; n++) for (let y = Math.round((150 + n * 70) * sy); y < Math.round((151 + n * 70) * sy); y++) for (let x = Math.round(80 * sx); x < Math.round(320 * sx); x++) {
          const i = (y * canvas.width + x) * 4; context.data[i] = context.data[i + 1] = context.data[i + 2] = 0;
        }
        let cancel!: () => void;
        const cancelled = new Promise<void>((_, reject) => { cancel = () => { cancellations++; reject(new Error('RenderingCancelledException')); }; });
        const work = gates.get(number)?.promise ?? Promise.resolve();
        return { promise: Promise.race([work, cancelled]).then(() => { if (number === failPage) throw new Error('Page render failed'); }).finally(() => { active--; }), cancel };
      }
    } };
  });
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root, entries, pdf: {}, editor: { setAnswerLines() {}, addSuggestedField(page: number, rect: Rect) { chosen.push({ page, rect }); } },
    session: { snapshot: { fields } }, generation: 1, closed: false, currentPage: lines.length,
    message: doc.querySelector('#message'), lineButton: doc.createElement('button'), dismissedLines: new Set<string>(), scannedEntries: new Set<Entry>() }) as Harness;
  return { surface, fields, chosen, hold, started: (page: number) => starts[page - 1]!.promise, visited, canvases, peak: () => peak, cancellations: () => cancellations, fail: (page: number) => { failPage = page; }, dispose: () => { surface.cancelLineScan(); surface.clearSuggestions(); dom.window.close(); } };
}
test('one scan detects every PDF page, including offscreen pages, with bounded sequential rasters', async () => {
  const f = fixture();
  try {
    await f.surface.detectLines(); assert.deepEqual(f.visited, [1, 2, 3, 4]); assert.equal(f.peak(), 1);
    assert.equal(f.surface.lineButton.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(f.surface.entries.map(entry => entry.candidates?.length), [1, 2, 0, 1]);
    assert.equal(f.surface.message.textContent, '');
    assert(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    const suggestion = f.surface.entries[3]!.suggestions!.querySelector<HTMLButtonElement>('button')!; suggestion.click();
    assert.equal(suggestion.hasAttribute('title'), false);
    assert.equal(suggestion.hasAttribute('aria-label'), false);
    assert.equal(suggestion.ownerDocument.getElementById(suggestion.getAttribute('aria-labelledby')!)?.textContent, 'Fill detected answer line');
    assert.equal(f.chosen[0]!.page, 4); assert.deepEqual(f.chosen[0]!.rect, [110, 650, 350, 668]);
    await f.surface.detectLines(); assert(f.surface.entries.every(entry => !entry.candidates && !entry.suggestions)); assert.equal(f.visited.length, 4);
    assert.equal(f.surface.lineButton.getAttribute('aria-pressed'), 'false');
  } finally { f.dispose(); }
});
test('floating controls stay within the visible note and leave when the PDF scrolls away', () => {
  const dom = new JSDOM('<body><div id="note"><div id="pdf"><div id="nav"></div><div id="tools"></div><div id="spacer" hidden></div></div></div></body>');
  try {
    const doc = dom.window.document, note = doc.querySelector<HTMLElement>('#note')!, root = doc.querySelector<HTMLElement>('#pdf')!;
    const navigation = doc.querySelector<HTMLElement>('#nav')!, tools = doc.querySelector<HTMLElement>('#tools')!;
    const toolbarSpacer = doc.querySelector<HTMLElement>('#spacer')!;
    note.style.overflowY = 'auto';
    Object.defineProperties(note, { scrollHeight: { value: 1600 }, clientHeight: { value: 600 } });
    Object.defineProperties(navigation, { offsetHeight: { value: 42 } });
    Object.defineProperties(tools, { offsetHeight: { value: 44 } });
    note.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 50, right: 650, width: 600, height: 600 } as DOMRect);
    let bottom = 550;
    root.getBoundingClientRect = () => ({ top: -250, bottom, left: 70, right: 630, width: 560, height: bottom + 250 } as DOMRect);
    const preferences = { floatingToolbar: true, toolbarTopOffset: 12 };
    const surface = Object.assign(Object.create(PdfSurface.prototype), { root, navigation, tools, toolbarSpacer, sessions: { preferences } }) as { updateFloatingToolbar(): void };
    surface.updateFloatingToolbar();
    assert.equal(root.classList.contains('is-floating-toolbar'), true);
    assert.equal(navigation.style.top, '112px'); assert.equal(tools.style.top, '154px');
    assert.equal(navigation.style.left, '70px'); assert.equal(navigation.style.width, '560px');
    assert.equal(toolbarSpacer.hidden, false); assert.equal(toolbarSpacer.style.height, '86px');
    bottom = 180; surface.updateFloatingToolbar();
    assert.equal(root.classList.contains('is-floating-toolbar'), false); assert.equal(toolbarSpacer.hidden, true);
  } finally { dom.window.close(); }
});
test('manual scans of a long PDF run in 100-page sections from the current page', async () => {
  const f = fixture(Array(205).fill(0));
  try {
    const realScan = f.surface.detectLines.bind(f.surface);
    await assert.rejects(realScan(f.surface.entries), /limited to 100 pages/);
    const ranges: number[][] = [];
    f.surface.detectLines = async targets => { ranges.push(targets!.map(entry => entry.native.number)); };
    f.surface.currentPage = 1; f.surface.answerLineActions().run();
    f.surface.currentPage = 101; f.surface.answerLineActions().run();
    f.surface.currentPage = 201; f.surface.answerLineActions().run();
    assert.deepEqual(ranges.map(range => [range[0], range.at(-1), range.length]), [[1, 100, 100], [101, 200, 100], [201, 205, 5]]);
  } finally { f.dispose(); }
});
test('scanning another section keeps suggestions from earlier pages', async () => {
  const f = fixture([1, 1, 0]);
  try {
    await f.surface.detectLines([f.surface.entries[0]!]);
    await f.surface.detectLines([f.surface.entries[1]!]);
    assert.equal(f.surface.entries[0]!.candidates?.length, 1);
    assert.equal(f.surface.entries[1]!.candidates?.length, 1);
  } finally { f.dispose(); }
});
test('scan progress is cancellable and partial suggestions are removed', { timeout: 5000 }, async () => {
  const f = fixture(); const releaseFirst = f.hold(1), release = f.hold(2);
  try {
    const scanning = f.surface.detectLines(); await f.started(1);
    assert.deepEqual(f.visited, [1]); assert.match(f.surface.message.textContent!, /page 1 of 4/);
    assert.equal(f.surface.lineButton.getAttribute('aria-pressed'), 'true');
    // Progress is synchronized with rendering, independent of runner speed.
    releaseFirst(); await f.started(2);
    assert.match(f.surface.message.textContent!, /page 2 of 4/); assert.equal(f.surface.answerLineActions().title, 'Cancel answer-line scan');
    assert.equal(f.surface.entries[0]!.candidates?.length, 1);
    await f.surface.detectLines(); await scanning; release();
    assert.deepEqual(f.visited, [1, 2]); assert.equal(f.cancellations(), 1);
    assert(f.surface.entries.every(entry => !entry.candidates)); assert.equal(f.surface.message.textContent, '');
    assert.equal(f.surface.lineScan, undefined);
  } finally { releaseFirst(); release(); f.dispose(); }
});
test('cancelled old scans cannot overwrite a restarted scan or its controls', async () => {
  const f = fixture([1, 1]), release = f.hold(1);
  try {
    const old = f.surface.detectLines(); await f.surface.detectLines(); const next = f.surface.detectLines();
    await old; assert.equal(f.surface.answerLineActions().title, 'Cancel answer-line scan'); release(); await next;
    assert.deepEqual(f.visited, [1, 1, 2]); assert.equal(f.surface.message.textContent, '');
  } finally { release(); f.dispose(); }
});
test('document replacement invalidates an in-flight scan and prevents suggestions on detached pages', async () => {
  const f = fixture(), release = f.hold(1);
  try {
    const old = f.surface.detectLines(); f.surface.cancelLineScan(); f.surface.clearSuggestions(); f.surface.generation++;
    f.surface.entries.forEach(entry => entry.native.div.remove()); release(); await old;
    assert(f.surface.entries.every(entry => !entry.candidates && !entry.suggestions)); assert.deepEqual(f.visited, [1]);
  } finally { release(); f.dispose(); }
});
test('a page render failure clears partial suggestions, leaves retry enabled and reports the failure', async () => {
  const f = fixture(); f.fail(2);
  try {
    await assert.rejects(f.surface.detectLines(), /Page render failed/);
    assert(f.surface.entries.every(entry => !entry.candidates)); assert.equal(f.surface.answerLineActions().title, 'Detect answer lines in PDF'); assert.equal(f.surface.lineScan, undefined);
    f.fail(0); await f.surface.detectLines(); assert.equal(f.surface.entries[3]!.candidates?.length, 1);
  } finally { f.dispose(); }
});
test('empty PDFs complete quietly without adding fields', async () => {
  const f = fixture([0, 0, 0]);
  try {
    await f.surface.detectLines(); assert.equal(f.surface.message.textContent, ''); assert.equal(f.chosen.length, 0);
    assert.equal(f.surface.lineButton.getAttribute('aria-pressed'), 'true', 'a completed automatic scan is active even without matches');
    await f.surface.detectLines(); assert.equal(f.surface.lineButton.getAttribute('aria-pressed'), 'false');
  }
  finally { f.dispose(); }
});

test('session refresh preserves other suggestion nodes through pointerdown and blank-field cleanup', async () => {
  const f = fixture([2]);
  try {
    await f.surface.detectLines(); const entry = f.surface.entries[0]!;
    const [first, next] = [...entry.suggestions!.querySelectorAll<HTMLButtonElement>('button')];
    f.fields.push({ widgets: [{ page: 1, rect: entry.candidates![0]! }] }); f.surface.refreshSuggestions();
    assert.equal(first!.isConnected, false); assert.equal(next!.isConnected, true);
    const doc = next!.ownerDocument;
    // Leaving the preceding empty answer emits a session update in capture.
    doc.addEventListener('pointerdown', () => { f.fields.splice(0); f.surface.refreshSuggestions(); }, { capture: true, once: true });
    next!.dispatchEvent(new doc.defaultView!.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(next!.isConnected, true); assert.equal(entry.suggestions!.querySelectorAll('button').length, 2);
    next!.click(); assert.equal(f.chosen.length, 1); assert.deepEqual(f.chosen[0]!.rect, entry.candidates![1]);
  } finally { f.dispose(); }
});

test('deleting a detected answer dismisses its suggestion until an explicit rescan', async () => {
  const f = fixture([2]);
  try {
    await f.surface.detectLines();
    const entry = f.surface.entries[0]!, rect = entry.candidates![0]!;
    const field = { widgets: [{ page: 1, rect }] };
    f.fields.push(field); f.surface.refreshSuggestions();
    assert.equal(entry.suggestions!.querySelectorAll('button').length, 1);
    f.surface.dismissRemovedAnswer(field);
    f.fields.splice(0); f.surface.refreshSuggestions();
    assert.equal(entry.suggestions!.querySelectorAll('button').length, 1, 'deletion does not recreate the first suggestion');
    await f.surface.detectLines(); await f.surface.detectLines();
    assert.equal(f.surface.entries[0]!.suggestions!.querySelectorAll('button').length, 2, 'a fresh scan can offer it again');
  } finally { f.dispose(); }
});

test('unavailable decorative metadata leaves all detected answers intact', async () => {
  const f = fixture();
  try {
    Object.assign(f.surface, { library: { OPS } });
    f.surface.entries[0]!.page.getOperatorList = () => Promise.reject(new Error('Unsupported operator metadata'));
    await f.surface.detectLines(); assert.deepEqual(f.surface.entries.map(entry => entry.candidates?.length), [1, 2, 0, 1]);
    assert.equal(f.surface.message.textContent, '');
  } finally { f.dispose(); }
});
test('cancelling while decorative metadata is pending cannot publish stale results', { timeout: 5000 }, async () => {
  const f = fixture([1]); let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }); const inspecting = new Promise<void>(resolve => { started = resolve; });
  try {
    Object.assign(f.surface, { library: { OPS } });
    f.surface.entries[0]!.page.getOperatorList = async () => { started(); await pending; return { fnArray: [], argsArray: [] }; };
    const scanning = f.surface.detectLines(); await inspecting; await f.surface.detectLines(); release(); await scanning;
    assert.equal(f.surface.entries[0]!.candidates, undefined); assert.equal(f.surface.message.textContent, '');
    assert(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { release(); f.dispose(); }
});
