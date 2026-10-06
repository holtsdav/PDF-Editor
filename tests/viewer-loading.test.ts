import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Exercise actual discovery and startup against DOM, deferring PDF/session I/O.
const host = `
  export class Component {
    cleanups = []; registerEvent() {} register(fn) { this.cleanups.push(fn); }
    registerDomEvent(el, name, fn, options) { el.addEventListener(name, fn, options); this.register(() => el.removeEventListener(name, fn, options)); }
    unload() { this.onunload?.(); for (const fn of this.cleanups.splice(0)) fn(); }
  }
  export class TFile { extension = 'pdf'; path = 'anonymous.pdf'; name = 'anonymous.pdf'; basename = 'anonymous'; }
  export const loadPdfJs = async () => ({});
  export const setIcon = () => {}; export const setTooltip = () => {};
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
  let reject!: (error: Error) => void, released = 0;
  const pending = new Promise((_, no) => { reject = no; });
  const preferences = { toolbarTopOffset: 48 }; let preferenceChanged: () => void = () => {}, unsubscribed = false;
  const surface = new PdfSurface(f.app, { identity: f.owner, file: f.file, element: f.element }, {
    preferences, retain: () => () => { released++; }, get: () => pending,
    subscribePreferences: (listener: () => void) => { preferenceChanged = listener; return () => { unsubscribed = true; }; }
  });
  try {
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
  const entry = { native: { div: page, number: 1 }, canvas, text, links, painted: 1, version: 1,
    rendering: { cancel() { cancelled++; } }, textTask: { cancel() { textCancelled++; } } };
  const surface = Object.assign(Object.create(PdfSurface.prototype), { root: f.doc.createElement('div'), scroller, entries: [entry],
    currentPage: 1, pageInput: f.doc.createElement('input'), previous: f.doc.createElement('button'), next: f.doc.createElement('button'), closed: false,
    activeRender: entry, paintedEntries: new Set([entry]) });
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
    paintedEntries: new Set(), renderQueue: Promise.resolve(), paint: async (entry: { native: { number: number } }) => { painted.push(entry.native.number); } });
  try {
    (surface as { paintVisible(): void }).paintVisible();
    await (surface as { renderQueue: Promise<void> }).renderQueue;
    assert.equal(surface.currentPage, 100);
    assert(painted.length <= 4, 'Only the destination and adjacent pages should be queued');
    assert(painted.includes(100));
  } finally { f.dom.window.close(); }
});
