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
    export class Scope { constructor(parent) { this.parent = parent; this.handlers = []; } register(modifiers, key, func) { const handler = { modifiers, key, func }; this.handlers.push(handler); return handler; } }
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

interface MockScope { handlers: { key: string; func(event: KeyboardEvent): unknown }[] }
async function fixture(pageCount = 1, withKeymap = false) {
  const pdf = await PDFDocument.create(); for (let i = 0; i < pageCount; i++) pdf.addPage([600, 800]); let bytes = await pdf.save();
  const session = await TextSession.open({ read: async () => bytes, write: async value => { bytes = value; }, backup: async () => 'original.pdf' }, font);
  const dom = new JSDOM(`<body><div id="editor"><div id="tools"></div>${Array.from({ length: pageCount }, (_, i) => `<div id="${i ? 'page' + (i + 1) : 'page'}"></div>`).join('')}</div><button id="outside">Outside</button></body>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  let clipboardText = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { clipboardText = text; },
    readText: async () => clipboardText
  } });
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
  const scanButton = doc.createElement('button'); scanButton.setAttribute('aria-label', 'Detect answer lines in PDF');
  const native = { identity: {}, element: doc.querySelector('#editor')!, file: {}, toolbarHost: () => doc.querySelector('#tools')!, answerLineButton: () => scanButton, pages: () => Array.from({ length: pageCount }, (_, i) => ({ div: doc.querySelector(i ? '#page' + (i + 1) : '#page')!, number: i + 1, annotationElements: () => [], viewport: {
    width: 600, height: 800, scale: 1, rotation: 0, convertToPdfPoint: (x: number, y: number) => [x, 800 - y], convertToViewportRectangle: (r: number[]) => [r[0]!, 800 - r[1]!, r[2]!, 800 - r[3]!]
  } })) } as unknown as EditorSurface;
  const sessions = { get: async () => session, preferences: loadToolPreferences({ holdShapes: true }), updatePreferences: async () => {} } as unknown as VaultSessions;
  const scopes: MockScope[] = [];
  const app = withKeymap ? { scope: {}, keymap: {
    pushScope(scope: MockScope) { scopes.push(scope); },
    popScope(scope: MockScope) { const index = scopes.lastIndexOf(scope); if (index >= 0) scopes.splice(index, 1); }
  } } : {};
  const editor = new TextEditor(app as unknown as App, native, sessions);
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
  return { doc, session, editor, sessions, scopes, pointer, tool, dispose, bytes: () => bytes,
    clipboard: { get text() { return clipboardText; }, set text(value: string) { clipboardText = value; } } };
}

test('answer-line scan button sits beside Add text box in the editing toolbar', async () => {
  const f = await fixture();
  try {
    const labels = [...f.doc.querySelectorAll<HTMLButtonElement>('.pdf-form-studio-toolbar > button')].map(button => button.getAttribute('aria-label'));
    const text = labels.findIndex(label => label?.startsWith('Add text box'));
    assert.equal(labels[text + 1], 'Detect answer lines in PDF');
    assert(labels[text + 2]?.startsWith('Highlighter'));
  } finally { f.dispose(); }
});

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
test('click and drag Text placement each return to Select after one box', async () => {
  const f = await fixture();
  try {
    const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    for (const drag of [false, true]) {
      f.tool('Add text box');
      f.pointer(layer, 'pointerdown', drag ? 340 : 80, drag ? 250 : 180);
      if (drag) f.pointer(layer, 'pointermove', 500, 300);
      f.pointer(layer, 'pointerup', drag ? 500 : 80, drag ? 300 : 180);
      assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Select"]')!.getAttribute('aria-pressed'), 'true');
      assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Add text box"]')!.getAttribute('aria-pressed'), 'false');
      const input = f.doc.activeElement as HTMLTextAreaElement;
      assert.equal(input.tagName, 'TEXTAREA');
      input.value = drag ? 'Dragged' : 'Clicked'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
      const count = f.session.snapshot.fields.length;
      f.pointer(layer, 'pointerdown', 550, 450); f.pointer(layer, 'pointerup', 550, 450);
      assert.equal(f.session.snapshot.fields.length, count);
    }
    assert.deepEqual(f.session.snapshot.fields.map(field => field.value), ['Clicked', 'Dragged']);
  } finally { f.dispose(); }
});
test('keyboard unfocus removes an empty box, while typed text survives leaving and reopening', async () => {
  const f = await fixture();
  try {
    f.editor.addSuggestedField(1, [80, 600, 340, 620]);
    const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!; outside.focus(); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 0);
    f.editor.addSuggestedField(1, [80, 600, 340, 620]);
    const input = f.doc.querySelector<HTMLTextAreaElement>('textarea[data-pdf-field]')!;
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
    for (const element of [frame, frame.querySelector('[data-resize="se"]')!, input]) {
      assert.equal(element.hasAttribute('aria-label'), false, 'PDF objects do not trigger Obsidian hover labels');
      assert.equal(element.hasAttribute('title'), false);
      const label = f.doc.getElementById(element.getAttribute('aria-labelledby')!);
      assert.equal(label?.hidden, true, 'screen-reader names remain available');
    }
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

test('consecutive detected lines create one persistent ruled answer with normal typing and additional rows', async () => {
  const f = await fixture();
  try {
    const lines = [620, 596, 572, 480].map(y => ({ page: 1, rect: [80, y, 340, y + 18] as [number, number, number, number] }));
    f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[1]!.rect);
    const field = f.session.snapshot.fields[0]!, input = f.doc.activeElement as HTMLTextAreaElement, rect = [...field.widgets[0]!.rect];
    assert.equal(f.session.snapshot.fields.length, 1); assert.deepEqual(field.ruled, { spacing: 24, rows: 3 });
    assert.equal(input.style.lineHeight, '24px'); assert.equal(field.multiline, true);
    input.value = 'First ruled answer\nSecond line\nThird line'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    assert.deepEqual(field.widgets[0]!.rect, rect, 'the original rows are retained while they fit');
    f.editor.addSuggestedField(1, lines[2]!.rect); assert.equal(f.session.snapshot.fields.length, 1); assert.equal(f.doc.activeElement, input);
    const enter = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); input.dispatchEvent(enter); assert.equal(enter.defaultPrevented, false);
    await f.session.save(); const saved = (await readTextPdf(f.bytes())).fields[0]!;
    assert.equal(saved.value, input.value); assert.deepEqual(saved.ruled, field.ruled); assert.deepEqual(saved.widgets[0]!.rect, rect);
    input.value += '\nFourth line without a printed rule'; input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    assert.equal(f.doc.activeElement, input); assert.equal(input.selectionStart, input.value.length);
    assert.equal(field.ruled?.rows, 4); assert.deepEqual(field.widgets[0]!.rect, [80, 548, 340, 638]);
    await f.session.save(); assert.equal((await readTextPdf(f.bytes())).fields[0]!.value, input.value);
    input.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.session.snapshot.fields.length, 2); assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, f.session.snapshot.fields[1]!.name);
    f.doc.activeElement!.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.doc.activeElement, input);
  } finally { f.dispose(); }
});
test('clicking an adjacent suggestion turns an existing detected answer into one ruled block', async () => {
  const f = await fixture();
  try {
    const lines = [600, 572, 543].map((y, i) => ({ page: 1, rect: [70 - i, y, 460 - i, y + 18] as [number, number, number, number] }));
    f.editor.setAnswerLines([lines[0]!]); f.editor.addSuggestedField(1, lines[0]!.rect);
    const first = f.session.snapshot.fields[0]!;
    const originalRect = [...first.widgets[0]!.rect];
    f.session.setValue(first.name, 'Existing answer');
    f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[1]!.rect);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(first.value, 'Existing answer');
    assert.equal(first.ruled?.rows, 3);
    assert.equal(first.multiline, true);
    f.session.undoStroke();
    const undone = f.session.snapshot.fields.find(field => field.name === first.name)!;
    assert.equal(undone.value, 'Existing answer');
    assert.equal(undone.ruled, undefined);
    assert.deepEqual(undone.widgets[0]!.rect, originalRect);
    f.session.redoStroke();
    assert.equal(f.session.snapshot.fields.find(field => field.name === first.name)?.ruled?.rows, 3);
    await f.session.save();
    const saved = (await readTextPdf(f.bytes())).fields[0]!;
    assert.equal(saved.value, 'Existing answer');
    assert.equal(saved.ruled?.rows, 3);
  } finally { f.dispose(); }
});
test('a saved two-row answer extends onto the next detected dotted line', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [76.66, 677.27, 469.99, 722.6], 12, true, 0, { spacing: 27.33, rows: 2 });
    f.session.setValue(field.name, 'Existing answer');
    const remaining = [
      { page: 1, rect: [77.33, 677.27, 470.66, 695.27] as [number, number, number, number] },
      { page: 1, rect: [76.66, 647.94, 467.32, 665.94] as [number, number, number, number] }
    ];
    f.editor.setAnswerLines(remaining); f.editor.addSuggestedField(1, remaining[1]!.rect);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(field.value, 'Existing answer');
    assert.equal(field.ruled?.rows, 3);
    assert.equal(field.widgets[0]!.rect[3], 722.6);
    f.session.undoStroke(); assert.equal(f.session.snapshot.fields[0]!.ruled?.rows, 2);
    f.session.redoStroke(); await f.session.save();
    assert.equal((await readTextPdf(f.bytes())).fields[0]!.ruled?.rows, 3);
  } finally { f.dispose(); }
});
test('selected PDF elements copy, paste and duplicate without intercepting text editing', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true); f.session.setValue(field.name, 'Copy me'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!; frame.focus();
    const values = new Map<string, string>();
    const clipboardData = { setData(type: string, value: string) { values.set(type, value); }, getData(type: string) { return values.get(type) ?? ''; } };
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: clipboardData }); frame.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    const paste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData }); frame.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true); assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.session.snapshot.fields[1]!.value, 'Copy me');
    const duplicate = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true });
    frame.dispatchEvent(duplicate); assert.equal(duplicate.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 3);
    const input = frame.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-pdf-field]')!;
    input.setSelectionRange(0, 4);
    const nativeCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(nativeCopy, 'clipboardData', { value: clipboardData }); input.dispatchEvent(nativeCopy);
    assert.equal(nativeCopy.defaultPrevented, false);
  } finally { f.dispose(); }
});
test('a selected box focuses a read-only shortcut target without entering text editing', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Keep this'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const proxy = frame.querySelector<HTMLTextAreaElement>('.pdf-form-studio-shortcut-proxy')!;
    assert.equal(f.doc.activeElement, proxy);
    assert.equal(proxy.readOnly, true);
    assert.equal(frame.classList.contains('is-editing'), false);
    const duplicate = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true });
    proxy.dispatchEvent(duplicate);
    assert.equal(duplicate.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.session.snapshot.fields[0]!.value, 'Keep this');
    const selectedProxy = f.doc.activeElement!;
    assert.equal(selectedProxy.classList.contains('pdf-form-studio-shortcut-proxy'), true);
    const printed = f.doc.createElement('span'); printed.textContent = 'Old selection'; f.doc.body.append(printed);
    const range = f.doc.createRange(); range.selectNodeContents(printed); f.doc.getSelection()!.addRange(range);
    const copy = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
    selectedProxy.dispatchEvent(copy); assert.equal(copy.defaultPrevented, true);
    const paste = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true });
    selectedProxy.dispatchEvent(paste); assert.equal(paste.defaultPrevented, true);
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 3);
  } finally { f.dispose(); }
});
test('selected drawing shortcuts use a keyboard target in an embedded PDF', async () => {
  const f = await fixture(1, true);
  try {
    f.session.addStroke(1, 'scribble', [[80, 500], [120, 520]], 2); f.editor.refresh();
    const drawing = f.doc.querySelector<SVGGElement>('.pdf-form-studio-ink-control')!;
    f.pointer(drawing, 'pointerdown', 100, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 100, 290);
    const proxy = f.doc.activeElement as HTMLTextAreaElement;
    assert.equal(proxy.classList.contains('pdf-form-studio-shortcut-proxy'), true);
    assert.equal(proxy.getAttribute('aria-label'), 'Selected PDF drawing');
    assert.equal(f.scopes.length, 1);
    for (const key of ['c', 'v', 'd']) {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
      f.doc.activeElement!.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, `⌘${key.toUpperCase()} should be handled for a drawing`);
      await pause(0);
    }
    assert.equal(f.session.snapshot.strokes.length, 3);
    const selected = f.session.snapshot.strokes.at(-1)!;
    const before = structuredClone(selected.points);
    const arrow = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    f.doc.activeElement!.dispatchEvent(arrow);
    assert.equal(arrow.defaultPrevented, true);
    assert.notDeepEqual(f.session.snapshot.strokes.find(stroke => stroke.id === selected.id)!.points, before);
  } finally { f.dispose(); }
});
test('selected text and drawing proxies keep Undo, Redo and tool shortcuts', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Undo me');
    const before = [...field.widgets[0]!.rect];
    f.session.moveObjects([{ kind: 'text', id: field.name }], [10, 0]); f.editor.refresh();
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    const shortcut = (target: Element, key: string, metaKey = false, shiftKey = false) => {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key, metaKey, shiftKey, bubbles: true, cancelable: true });
      target.dispatchEvent(event); assert.equal(event.defaultPrevented, true, `${key} should work on the selected object`);
    };
    const textProxy = f.doc.activeElement!;
    shortcut(textProxy, 'z', true);
    assert.deepEqual(f.session.snapshot.fields.find(item => item.name === field.name)?.widgets[0]?.rect, before);
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    shortcut(f.doc.activeElement!, 'z', true, true);
    assert.equal(f.session.snapshot.fields.find(item => item.name === field.name)?.widgets[0]?.rect[0], before[0]! + 10);
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    shortcut(f.doc.activeElement!, 'p');
    assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Pen"]')!.getAttribute('aria-pressed'), 'true');

    f.tool('Select');
    f.session.addStroke(1, 'scribble', [[80, 500], [120, 520]], 2); f.editor.refresh();
    const drawing = f.doc.querySelector<SVGGElement>('.pdf-form-studio-ink-control')!;
    f.pointer(drawing, 'pointerdown', 100, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 100, 290);
    const drawingProxy = f.doc.activeElement!;
    assert.equal(drawingProxy.getAttribute('aria-label'), 'Selected PDF drawing');
    shortcut(drawingProxy, 'z', true);
    assert.equal(f.session.snapshot.strokes.length, 0);
    shortcut(drawingProxy, 'z', true, true);
    assert.equal(f.session.snapshot.strokes.length, 1);
    shortcut(drawingProxy, 'h');
    assert.equal(f.doc.querySelector<HTMLButtonElement>('button[aria-label^="Highlighter"]')!.getAttribute('aria-pressed'), 'true');
  } finally { f.dispose(); }
});
test('PDF answer shortcuts work with a caret while highlighted text retains native editing', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Copy me'); f.editor.refresh();
    const input = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    input.focus(); input.setSelectionRange(7, 7);
    const duplicate = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(duplicate);
    assert.equal(duplicate.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.doc.activeElement?.classList.contains('pdf-form-studio-shortcut-proxy'), true);
    const held = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, repeat: true, bubbles: true, cancelable: true });
    f.doc.activeElement!.dispatchEvent(held);
    assert.equal(held.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);

    input.focus(); input.setSelectionRange(7, 7);
    const values = new Map<string, string>();
    const clipboardData = { setData(type: string, value: string) { values.set(type, value); }, getData(type: string) { return values.get(type) ?? ''; } };
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: clipboardData }); input.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    const paste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData }); input.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 3);

    input.focus(); input.setSelectionRange(0, 4);
    const textCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(textCopy, 'clipboardData', { value: clipboardData }); input.dispatchEvent(textCopy);
    assert.equal(textCopy.defaultPrevented, false);
    const textPaste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', { value: clipboardData }); input.dispatchEvent(textPaste);
    assert.equal(textPaste.defaultPrevented, false);
  } finally { f.dispose(); }
});
test('selected PDF owns Obsidian shortcut scope until focus leaves the embed', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'In a note'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    assert.equal(f.scopes.length, 1);
    const handler = f.scopes[0]!.handlers.find(item => item.key === 'd')!;
    const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: frame });
    assert.equal(handler.func(event), false);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.scopes.length, 1);
    f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    assert.equal(f.scopes.length, 0);
  } finally { f.dispose(); }
});
test('a selected PDF never claims shortcuts from another Obsidian window', async () => {
  const f = await fixture(1, true);
  const foreign = new JSDOM('<body><div id="note"></div></body>', { pretendToBeVisual: true });
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Original'); f.editor.refresh();
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    assert.equal(f.scopes.length, 1);
    for (const key of ['c', 'v', 'd']) {
      const handler = f.scopes[0]!.handlers.find(item => item.key === key)!;
      const event = new foreign.window.KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: foreign.window.document.querySelector('#note') });
      assert.equal(handler.func(event as unknown as KeyboardEvent), undefined);
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(f.session.snapshot.fields.length, 1);
    f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
    assert.equal(f.scopes.length, 0);
  } finally { foreign.window.close(); f.dispose(); }
});
test('Live Preview scope copies and pastes a selected PDF box through the system clipboard', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Copy me'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const copy = f.scopes[0]!.handlers.find(item => item.key === 'c')!;
    const paste = f.scopes[0]!.handlers.find(item => item.key === 'v')!;
    const key = (letter: string) => {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: letter, metaKey: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: frame });
      return event;
    };
    const copyEvent = key('c'); assert.equal(copy.func(copyEvent), false); assert(copyEvent.defaultPrevented);
    await pause(0); assert.equal(f.clipboard.text, 'Copy me');
    const pasteEvent = key('v'); assert.equal(paste.func(pasteEvent), false); assert(pasteEvent.defaultPrevented);
    await pause(0); assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.clipboard.text, 'Copy me');
  } finally { f.dispose(); }
});
test('a changed system clipboard cannot paste a stale PDF object', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Old PDF copy'); f.editor.refresh();
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    const shortcut = (key: string) => f.doc.activeElement!.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true
    }));
    shortcut('c'); await pause(0);
    f.clipboard.text = 'Copied from another source';
    shortcut('v'); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.clipboard.text, 'Copied from another source');
  } finally { f.dispose(); }
});
test('changed clipboard text pastes into an active PDF answer instead of a stale object', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Start'); f.editor.refresh();
    const input = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    input.focus(); input.setSelectionRange(5, 5);
    const shortcut = (key: string) => {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event;
    };
    assert.equal(shortcut('c').defaultPrevented, true);
    await pause(0); f.clipboard.text = ' from elsewhere';
    assert.equal(shortcut('v').defaultPrevented, true);
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.session.snapshot.fields[0]!.value, 'Start from elsewhere');
  } finally { f.dispose(); }
});
test('copying highlighted PDF answer text clears the previous object copy', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Answer text'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    f.doc.activeElement!.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }));
    const input = frame.querySelector<HTMLTextAreaElement>('[data-pdf-field]')!;
    input.focus(); input.setSelectionRange(0, 6);
    const nativeCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(nativeCopy, 'clipboardData', { value: { setData() {} } });
    input.dispatchEvent(nativeCopy);
    assert.equal(nativeCopy.defaultPrevented, false);
    input.setSelectionRange(6, 6);
    const paste = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, false);
    assert.equal(f.session.snapshot.fields.length, 1);
  } finally { f.dispose(); }
});
test('Live Preview note keyboard target still uses the selected PDF box', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Selected PDF'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    const note = f.doc.createElement('div'); note.contentEditable = 'true'; note.tabIndex = 0;
    f.doc.body.append(note);
    frame.focus();
    for (const letter of ['c', 'v', 'd']) {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: letter, metaKey: true, bubbles: true, cancelable: true });
      note.dispatchEvent(event);
      assert(event.defaultPrevented, `${letter} belongs to the selected PDF box`);
      await pause(0);
    }
    assert.equal(f.session.snapshot.fields.length, 3);
    assert.equal(f.clipboard.text, 'Selected PDF');
    note.focus();
    const unrelated = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true });
    note.dispatchEvent(unrelated);
    assert.equal(unrelated.defaultPrevented, false);
    assert.equal(f.session.snapshot.fields.length, 3);
  } finally { f.dispose(); }
});
test('embedded PDF captures copy and paste before Live Preview handles the keydown', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'From PDF'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const key = (letter: string) => new f.doc.defaultView!.KeyboardEvent('keydown', { key: letter, metaKey: true, bubbles: true, cancelable: true });
    const copy = key('c'); frame.dispatchEvent(copy);
    assert(copy.defaultPrevented); await pause(0); assert.equal(f.clipboard.text, 'From PDF');
    const paste = key('v'); frame.dispatchEvent(paste);
    assert(paste.defaultPrevented); await pause(0); assert.equal(f.session.snapshot.fields.length, 2);
  } finally { f.dispose(); }
});
test('PDF element shortcuts still work when Obsidian has no Clipboard API', async () => {
  const f = await fixture(1, true);
  try {
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', { value: undefined });
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Internal copy'); f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    for (const letter of ['c', 'v']) {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: letter, metaKey: true, bubbles: true, cancelable: true });
      frame.dispatchEvent(event); assert(event.defaultPrevented);
    }
    await pause(0); assert.equal(f.session.snapshot.fields.length, 2);
  } finally { f.dispose(); }
});
test('leaving Obsidian invalidates an internal PDF copy without Clipboard API', async () => {
  const f = await fixture(1, true);
  try {
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', { value: undefined });
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Old PDF copy'); f.editor.refresh();
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    const shortcut = (key: string) => f.doc.activeElement!.dispatchEvent(new f.doc.defaultView!.KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true
    }));
    shortcut('c');
    f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
    shortcut('v'); await pause(0);
    assert.equal(f.session.snapshot.fields.length, 1);
  } finally { f.dispose(); }
});
test('selecting an ink mark clears old printed-text selection before object copy', async () => {
  const f = await fixture();
  try {
    const printed = f.doc.createElement('span'); printed.textContent = 'Old printed text'; f.doc.querySelector('#page')!.append(printed);
    const range = f.doc.createRange(); range.selectNodeContents(printed); f.doc.getSelection()!.addRange(range);
    assert.equal(f.doc.getSelection()!.toString(), 'Old printed text');
    const stroke = f.session.addStroke(1, 'scribble', [[80, 500], [120, 520]], 2); f.editor.refresh();
    const mark = f.doc.querySelector<SVGElement>(`[data-pdf-stroke="${stroke.id}"]`)!;
    f.pointer(mark, 'pointerdown', 90, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 90, 290);
    assert.equal(f.doc.getSelection()!.toString(), '');
    const values = new Map<string, string>();
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: { setData(type: string, value: string) { values.set(type, value); } } });
    mark.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    assert([...values.keys()].some(type => type !== 'text/plain'), 'the selected ink mark is copied as a PDF element');
  } finally { f.dispose(); }
});
test('Save shortcut remains scoped to the PDF after its toolbar floats outside the editor', async () => {
  const f = await fixture();
  try {
    const host = f.doc.createElement('div'); host.className = 'pfs-floating-toolbar';
    const navigation = host.appendChild(f.doc.createElement('button'));
    const search = host.appendChild(f.doc.createElement('input'));
    host.append(f.doc.querySelector('#tools')!); f.doc.body.append(host);
    let saves = 0;
    (f.editor as unknown as { save(): Promise<void> }).save = async () => { saves++; };
    for (const target of [navigation, search]) {
      const event = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal(saves, 2);
    const outside = new f.doc.defaultView!.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    f.doc.querySelector('#outside')!.dispatchEvent(outside);
    assert.equal(outside.defaultPrevented, false);
  } finally { f.dispose(); }
});
test('floating toolbar actions retain a selected group until the action runs', async () => {
  const f = await fixture();
  try {
    const first = f.session.add(1, [80, 580, 180, 610], 12, true); f.session.setValue(first.name, 'First');
    const second = f.session.add(1, [220, 580, 320, 610], 12, true); f.session.setValue(second.name, 'Second');
    f.editor.refresh();
    const frames = f.doc.querySelectorAll('.pdf-form-studio-box');
    f.pointer(frames[0]!, 'pointerdown', 100, 200, true);
    f.pointer(frames[1]!, 'pointerdown', 250, 200, true);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 2);
    const host = f.doc.createElement('div'); host.className = 'pfs-floating-toolbar';
    host.append(f.doc.querySelector('#tools')!); f.doc.body.append(host);
    const search = host.appendChild(f.doc.createElement('input')); search.focus();
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 0, 'a floated input releases the PDF group scope');
    f.pointer(frames[0]!, 'pointerdown', 100, 200, true);
    f.pointer(frames[1]!, 'pointerdown', 250, 200, true);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 2);
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label^="Remove 2 selected objects"]')!;
    f.pointer(remove, 'pointerdown'); remove.focus(); remove.click();
    assert.equal(f.session.snapshot.fields.length, 0);
  } finally { f.dispose(); }
});
test('rounded browser scroll measurements do not append an unnecessary ruled row', async () => {
  const f = await fixture();
  try {
    const lines = [620, 596, 572].map(y => ({ page: 1, rect: [80, y, 340, y + 18] as [number, number, number, number] }));
    f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[0]!.rect);
    Object.defineProperty(f.doc.defaultView!.HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get() { return 74; } });
    const field = f.session.snapshot.fields[0]!, input = f.doc.activeElement as HTMLTextAreaElement;
    input.value = 'First\nSecond\nThird'; input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    assert.equal(field.ruled?.rows, 3); assert.deepEqual(field.widgets[0]!.rect, [80, 572, 340, 638]);
    assert.equal(input.parentElement!.classList.contains('is-overflow'), false);
  } finally { f.dispose(); }
});
test('line flow stays off until enabled; clicking an adjacent line then joins the existing answer', async () => {
  const f = await fixture();
  try {
    const lines = [620, 596, 572].map(y => ({ page: 1, rect: [80, y, 340, y + 18] as [number, number, number, number] }));
    f.sessions.preferences.flowAnswerLines = false; f.editor.setAnswerLines(lines); f.editor.addSuggestedField(1, lines[0]!.rect);
    const first = f.session.snapshot.fields[0]!; assert.equal(first.ruled, undefined);
    f.session.setValue(first.name, 'Keep separate'); f.sessions.preferences.flowAnswerLines = true;
    assert.equal(first.ruled, undefined, 'changing the setting alone does not alter existing answers');
    f.editor.addSuggestedField(1, lines[1]!.rect); assert.equal(f.session.snapshot.fields.length, 1);
    assert.deepEqual(first.ruled, { spacing: 24, rows: 3 }); assert.equal(first.value, 'Keep separate');
  } finally { f.dispose(); }
});
