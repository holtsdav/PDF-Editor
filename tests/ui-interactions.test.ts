import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { TextSession } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';
import type { TextEditor as Editor } from '../src/ui/text-editor.ts';
import type { EditorSurface } from '../src/compat/native-pdf.ts';
import type { VaultSessions } from '../src/pdf/vault-sessions.ts';
import type { App } from 'obsidian';

// Exercise the actual editor and pointer handlers; only the host API/layout is mocked.
const built = await build({ entryPoints: ['src/ui/text-editor.ts'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'test-host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'host', namespace: 'test' }));
  builder.onResolve({ filter: /\/pdf-font$/ }, () => ({ path: 'font', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'font' ? 'export const usePdfFont = () => () => {};' : `
    export class Component {
      cleanups = []; children = [];
      register(fn) { this.cleanups.push(fn); }
      registerDomEvent(el, name, fn, options) { el.addEventListener(name, fn, options); this.register(() => el.removeEventListener(name, fn, options)); }
      addChild(child) { this.children.push(child); return child; }
      removeChild(child) { child.unload(); this.children = this.children.filter(c => c !== child); }
      unload() { this.onunload?.(); for (const child of this.children) child.unload(); for (const fn of this.cleanups.splice(0).reverse()) fn(); }
    }
    export class Scope { register() {} }
    export class Menu { hide() {} }
    export class Modal extends Component {}
    export class Notice { constructor(text) { throw new Error(text); } }
    export function setTooltip(el, text) { el.setAttribute('aria-label', text); }
    export function setIcon(el) { el.append(el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')); }
    export const loadPdfJs = () => { throw new Error('Not used by editor fixture'); };
    export class TFile {}
    export class App {}
  ` }));
} }] });
// A local file URL keeps package resolution anchored in this repository.
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true });
const moduleUrl = new URL('../tmp/ui-tests/editor.mjs', import.meta.url);
await writeFile(moduleUrl, built.outputFiles[0]!.text);
const { TextEditor } = await import(moduleUrl.href) as { TextEditor: typeof Editor };
const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));

async function fixture(pageCount = 1) {
  const pdf = await PDFDocument.create(); for (let i = 0; i < pageCount; i++) pdf.addPage([600, 800]); let bytes = await pdf.save();
  const session = await TextSession.open({ read: async () => bytes, write: async value => { bytes = value; }, backup: async () => 'original.pdf' }, font);
  const dom = new JSDOM(`<body><div id="editor"><div id="tools"></div>${Array.from({ length: pageCount }, (_, i) => `<div id="${i ? 'page' + (i + 1) : 'page'}"></div>`).join('')}</div><button id="outside">Outside</button></body>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const create = function(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const el = doc.createElement(tag); if (options.cls) el.className = options.cls; if (options.text) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value); this.append(el); return el;
  };
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl: create,
    createDiv(this: HTMLElement, options: object) { return create.call(this, 'div', options); },
    createSpan(this: HTMLElement, options: object) { return create.call(this, 'span', options); },
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 }),
    setPointerCapture(this: HTMLElement, id: number) { this.dataset.capture = String(id); },
    hasPointerCapture(this: HTMLElement, id: number) { return this.dataset.capture === String(id); },
    releasePointerCapture(this: HTMLElement) { delete this.dataset.capture; }
  });
  const native = { identity: {}, element: doc.querySelector('#editor')!, file: {}, toolbarHost: () => doc.querySelector('#tools')!, pages: () => Array.from({ length: pageCount }, (_, i) => ({ div: doc.querySelector(i ? '#page' + (i + 1) : '#page')!, number: i + 1, annotationElements: () => [], viewport: {
    width: 600, height: 800, scale: 1, rotation: 0, convertToPdfPoint: (x: number, y: number) => [x, 800 - y], convertToViewportRectangle: (r: number[]) => [r[0]!, 800 - r[1]!, r[2]!, 800 - r[3]!]
  } })) } as unknown as EditorSurface;
  const sessions = { get: async () => session, preferences: loadToolPreferences({ holdShapes: true }), updatePreferences: async () => {} } as unknown as VaultSessions;
  const editor = new TextEditor({} as App, native, sessions);
  await pause(0);
  const pointer = (target: Element, name: string, x = 0, y = 0, shiftKey = false) => {
    const event = new dom.window.MouseEvent(name, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); return event;
  };
  const tool = (label: string) => {
    const button = doc.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
    pointer(button, 'pointerdown'); button.focus(); button.click();
  };
  const dispose = () => { (editor as Editor & { unload(): void }).unload(); dom.window.close(); };
  return { doc, session, editor, pointer, tool, dispose, bytes: () => bytes };
}

test('a newly placed empty box can move, resize and switch to Select before typing; leaving it deletes it', async () => {
  const f = await fixture();
  try {
    f.tool('Add text box'); const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    f.pointer(layer, 'pointerdown', 80, 180); f.pointer(layer, 'pointerup', 80, 180);
    const field = f.session.snapshot.fields[0]!, original = [...field.widgets[0]!.rect];
    assert.equal(f.doc.activeElement?.tagName, 'TEXTAREA');
    // Native toolbar activation can blur to body before its click/focus runs.
    (f.doc.activeElement as HTMLElement).blur(); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 1);
    f.tool('Select'); await pause(0); assert.equal(f.session.snapshot.fields.length, 1);
    const frame = f.doc.querySelector('.pdf-form-studio-box')!;
    f.pointer(frame, 'pointerdown', 100, 175); f.pointer(frame, 'pointermove', 140, 200); f.pointer(frame, 'pointerup', 140, 200);
    assert.equal(f.session.snapshot.fields.length, 1); assert.equal(field.widgets[0]!.rect[0], original[0]! + 40);
    const handle = frame.querySelector('[data-resize="e"]')!;
    const width = field.widgets[0]!.rect[2] - field.widgets[0]!.rect[0];
    f.pointer(handle, 'pointerdown', 340, 200); f.pointer(frame, 'pointermove', 380, 200); f.pointer(frame, 'pointerup', 380, 200);
    assert(field.widgets[0]!.rect[2] - field.widgets[0]!.rect[0] > width);
    assert.equal(f.session.pruneEmptyBoxes(), 0);
    const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!; f.pointer(outside, 'pointerdown'); outside.focus(); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 0);
  } finally { f.dispose(); }
});
test('keyboard unfocus removes an empty box, while typed text survives leaving and reopening', async () => {
  const f = await fixture();
  try {
    f.editor.addSuggestedField(1, [80, 600, 340, 620]);
    const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!; outside.focus(); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 0);
    f.editor.addSuggestedField(1, [80, 600, 340, 620]);
    const input = f.doc.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Filled answer'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true })); outside.focus(); await pause(0);
    await f.session.save(); assert.equal((await readTextPdf(f.bytes())).fields[0]!.value, 'Filled answer');
  } finally { f.dispose(); }
});
test('real hold timer snaps a circle and dragging while held resizes its saved geometry instead of adding freehand points', async () => {
  const f = await fixture();
  try {
    f.tool('Pen'); const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    f.pointer(layer, 'pointerdown', 250, 250);
    for (let i = 1; i <= 96; i++) f.pointer(layer, 'pointermove', 200 + 50 * Math.cos(i / 96 * Math.PI * 2), 250 + 50 * Math.sin(i / 96 * Math.PI * 2));
    await pause(800);
    const hint = f.doc.querySelector<HTMLElement>('.pfs-ink-hint')!; assert(!hint.hidden); assert.equal(hint.textContent, 'Circle');
    f.pointer(layer, 'pointermove', 300, 250); assert(!hint.hidden);
    f.pointer(layer, 'pointerup', 300, 250); await f.session.save();
    const points = (await readTextPdf(f.bytes())).strokes[0]!.points;
    assert.equal(points.length, 97); assert.deepEqual(points[0], points.at(-1));
    const width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
    assert(width > 190 && width < 210);
  } finally { f.dispose(); }
});


test('blank-space marquee selects mixed objects, moves as one group, cancels and undoes atomically', async () => {
  const f = await fixture();
  try {
    const text = f.session.add(1, [80, 580, 180, 610], 14, true); f.session.setValue(text.name, 'Group answer');
    const stroke = f.session.addStroke(1, 'scribble', [[230, 580], [260, 620], [290, 580]], 2);
    const page = f.doc.querySelector('#page')!;
    f.pointer(page, 'pointerdown', 60, 160); f.pointer(page, 'pointermove', 310, 240); f.pointer(page, 'pointerup', 310, 240);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 2);
    const originalText = [...text.widgets[0]!.rect], originalInk = structuredClone(stroke.points);
    const frame = f.doc.querySelector('.pdf-form-studio-box')!;
    f.pointer(frame, 'pointerdown', 100, 200); f.pointer(page, 'pointermove', 130, 220);
    assert.deepEqual(text.widgets[0]!.rect, originalText, 'drag preview must not change persistent state');
    f.pointer(page, 'pointercancel'); assert.deepEqual(text.widgets[0]!.rect, originalText);
    f.pointer(frame, 'pointerdown', 100, 200); f.pointer(page, 'pointermove', 130, 220); f.pointer(page, 'pointerup', 130, 220);
    assert.deepEqual(text.widgets[0]!.rect, [110, 560, 210, 590]);
    assert.deepEqual(f.session.snapshot.strokes[0]!.points, originalInk.map(([x, y]) => [x + 30, y - 20]));
    f.doc.body.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })); assert.deepEqual(f.session.snapshot.fields[0]!.widgets[0]!.rect, originalText); assert.deepEqual(f.session.snapshot.strokes[0]!.points, originalInk);
    f.session.redoStroke(); await f.session.save();
    const reopened = await readTextPdf(f.bytes()); assert.equal(reopened.fields[0]!.value, 'Group answer'); assert.equal(reopened.strokes.length, 1);
    f.doc.body.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    assert.equal(f.session.snapshot.fields.length, 0); assert.equal(f.session.snapshot.strokes.length, 0);
    f.session.undoStroke(); assert.equal(f.session.snapshot.fields.length, 1); assert.equal(f.session.snapshot.strokes.length, 1);
  } finally { f.dispose(); }
});
test('printed PDF text and editing inputs retain native drags; Shift-click adds and removes objects', async () => {
  const f = await fixture();
  try {
    const a = f.session.add(1, [80, 580, 180, 610], 14, true); f.session.setValue(a.name, 'First');
    const b = f.session.add(1, [230, 580, 330, 610], 14, true); f.session.setValue(b.name, 'Second');
    const frames = f.doc.querySelectorAll('.pdf-form-studio-box');
    f.pointer(frames[0]!, 'pointerdown', 100, 200, true); f.pointer(frames[1]!, 'pointerdown', 250, 200, true);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 2);
    f.pointer(frames[1]!, 'pointerdown', 250, 200, true); assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 1);
    const textLayer = f.doc.createElement('div'); textLayer.className = 'pfs-text-layer'; const span = f.doc.createElement('span'); span.textContent = 'Printed PDF text'; textLayer.append(span); f.doc.querySelector('#page')!.append(textLayer);
    assert.equal(f.pointer(span, 'pointerdown', 100, 400).defaultPrevented, false);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 0);
    const input = frames[0]!.querySelector<HTMLTextAreaElement>('textarea')!; input.focus();
    assert.equal(f.pointer(input, 'pointerdown', 100, 200).defaultPrevented, false);
    assert.equal(f.pointer(input, 'pointermove', 160, 200).defaultPrevented, false);
  } finally { f.dispose(); }
});


test('another view starting an ink action cancels a pending group drag without changing its geometry', async () => {
  const f = await fixture();
  try {
    const text = f.session.add(1, [80, 580, 180, 610], 14, true); f.session.setValue(text.name, 'Keep position');
    const page = f.doc.querySelector('#page')!;
    f.pointer(page, 'pointerdown', 60, 160); f.pointer(page, 'pointermove', 220, 240); f.pointer(page, 'pointerup', 220, 240);
    f.pointer(f.doc.querySelector('.pdf-form-studio-box')!, 'pointerdown', 100, 200); f.pointer(page, 'pointermove', 160, 260);
    const owner = {}; assert(f.session.beginInkAction(owner));
    f.session.addStroke(1, 'scribble', [[400, 400], [450, 450]], 2, undefined, owner);
    f.pointer(page, 'pointerup', 160, 260); f.session.finishInkAction(false, owner);
    assert.deepEqual(text.widgets[0]!.rect, [80, 580, 180, 610]); assert.equal(f.session.snapshot.strokes.length, 1);
    assert.equal((f.doc.querySelector('.pdf-form-studio-box') as HTMLElement).style.translate, '0px 0px');
  } finally { f.dispose(); }
});


test('detected answers use Select, reuse fields and never create boxes from subsequent blank-page clicks', async () => {
  const f = await fixture();
  try {
    const rect = [80, 600, 340, 620] as [number, number, number, number];
    f.tool('Pen'); f.editor.setAnswerLines([{ page: 1, rect }]); f.editor.addSuggestedField(1, rect);
    const first = f.session.snapshot.fields[0]!;
    assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Select"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Add text box"]')!.getAttribute('aria-pressed'), 'false');
    f.editor.addSuggestedField(1, rect); assert.equal(f.session.snapshot.fields.length, 1); assert.equal(f.session.snapshot.fields[0]!.name, first.name);
    const input = f.doc.activeElement as HTMLTextAreaElement; input.value = 'Keep this answer'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    f.pointer(layer, 'pointerdown', 150, 250); f.pointer(layer, 'pointerup', 150, 250);
    assert.equal(f.session.snapshot.fields.length, 1);
    const frame = f.doc.querySelector('.pdf-form-studio-box')!;
    f.pointer(frame, 'pointerdown', 100, 180); assert.equal(f.doc.activeElement, input); assert.equal(input.readOnly, false);
    f.editor.addSuggestedField(1, rect); assert.equal(f.session.snapshot.fields.length, 1); assert.equal(f.session.snapshot.fields[0]!.value, 'Keep this answer');
    f.editor.setAnswerLines([]); input.blur(); f.doc.querySelector<HTMLButtonElement>('#outside')!.focus(); await pause(0);
    f.pointer(frame, 'pointerdown', 100, 180); assert.equal(f.doc.activeElement, input);
    await f.session.save(); const reopened = await readTextPdf(f.bytes()); assert.equal(reopened.fields.length, 1); assert.equal(reopened.fields[0]!.value, 'Keep this answer');
  } finally { f.dispose(); }
});
test('Tab and Shift+Tab navigate detected lines in page order without duplicates, including offscreen pages', async () => {
  const f = await fixture(2);
  try {
    const a = { page: 1, rect: [80, 600, 340, 620] as [number, number, number, number] };
    const b = { page: 1, rect: [80, 540, 340, 560] as [number, number, number, number] };
    const c = { page: 2, rect: [80, 600, 340, 620] as [number, number, number, number] };
    f.editor.setAnswerLines([c, b, a]); f.editor.addSuggestedField(a.page, a.rect);
    const enter = (value: string) => { const input = f.doc.activeElement as HTMLTextAreaElement; input.value = value; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true })); return input.dataset.pdfField; };
    const tab = (shiftKey = false) => { const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }); f.doc.activeElement!.dispatchEvent(event); return event; };
    let escaped = 0; f.doc.addEventListener('keydown', () => escaped++);
    const first = enter('First'); assert.equal(tab().defaultPrevented, true); const second = enter('Second');
    assert.equal(tab().defaultPrevented, true); const third = enter('Third');
    assert.equal(f.doc.activeElement!.closest('#page2')?.id, 'page2'); assert.equal(f.session.snapshot.fields.length, 3); assert.equal(escaped, 0);
    tab(true); assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, second); tab(true); assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, first);
    assert.equal(tab(true).defaultPrevented, false); tab(); tab(); assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, third); assert.equal(tab().defaultPrevented, false);
    assert.equal(f.session.snapshot.fields.length, 3);
    await f.session.save(); const reopened = await readTextPdf(f.bytes()); assert.deepEqual(reopened.fields.map(field => field.value), ['First', 'Second', 'Third']); assert.equal(reopened.fields[2]!.widgets[0]!.page, 2);
  } finally { f.dispose(); }
});
test('leaving a blank detected line prunes only that blank and preserves navigation; Enter remains text editing', async () => {
  const f = await fixture();
  try {
    const lines = [{ page: 1, rect: [80, 600, 340, 620] as [number, number, number, number] }, { page: 1, rect: [80, 540, 340, 560] as [number, number, number, number] }];
    f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[0]!.rect);
    const key = (key: string, shiftKey = false) => { const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }); f.doc.activeElement!.dispatchEvent(event); return event; };
    key('Tab'); assert.equal(f.session.snapshot.fields.length, 1); assert.deepEqual(f.session.snapshot.fields[0]!.widgets[0]!.rect, lines[1]!.rect);
    const input = f.doc.activeElement as HTMLTextAreaElement; assert.equal(key('Enter').defaultPrevented, false); assert.equal(f.doc.activeElement, input);
    input.value = 'Same answer\ncontinued'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    key('Tab', true); assert.equal(f.session.snapshot.fields.length, 2); key('Tab'); assert.equal(f.session.snapshot.fields.length, 1); assert.equal(f.doc.activeElement, input);
    f.editor.setAnswerLines([]); assert.equal(key('Tab', true).defaultPrevented, false);
  } finally { f.dispose(); }
});

test('answer navigation skips locked fields and cannot mutate a replacing or conflicted session', async () => {
  const f = await fixture();
  try {
    const lines = [620, 560, 500].map(top => ({ page: 1, rect: [80, top - 20, 340, top] as [number, number, number, number] }));
    const locked = f.session.add(1, lines[1]!.rect, 14, false); locked.readOnly = true;
    f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[0]!.rect);
    const tab = () => { const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); f.doc.activeElement!.dispatchEvent(event); return event; };
    assert.equal(tab().defaultPrevented, true); assert.equal(f.session.snapshot.fields.length, 2); assert.deepEqual(f.session.snapshot.fields[1]!.widgets[0]!.rect, lines[2]!.rect); assert.equal(locked.value, '');
    f.session.status = 'conflict'; f.editor.addSuggestedField(1, lines[0]!.rect); assert.equal(f.session.snapshot.fields.length, 2); assert.equal(tab().defaultPrevented, false);
    f.session.status = 'unsaved';
  } finally { f.dispose(); }
});
