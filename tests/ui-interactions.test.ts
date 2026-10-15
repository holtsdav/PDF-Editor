import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { PDFDocument, degrees } from 'pdf-lib';
import { TextSession } from '../src/pdf/text-session.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';
import type { TextEditor as Editor } from '../src/ui/text-editor.ts';
import type { EditorSurface } from '../src/compat/native-pdf.ts';
import type { VaultSessions } from '../src/pdf/vault-sessions.ts';
import type { App } from 'obsidian';
import { authoredForms, prefixBlank } from './fixtures/authored-forms.ts';
import { orphanForms } from './fixtures/orphan-forms.ts';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bindSurfaceInput } from '../src/ui/surface-input.ts';

// Exercise the actual editor and pointer handlers; only the host API/layout is mocked.
const built = await build({
  entryPoints: ['src/ui/text-editor.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'test-host',
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'host', namespace: 'test' }));
        builder.onResolve({ filter: /\/pdf-font$/ }, () => ({ path: 'font', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({
          contents:
            args.path === 'font'
              ? 'export const usePdfFont = () => () => {};'
              : `
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
    export function setTooltip(el, text, options = {}) { el.setAttribute('aria-label', text); el.setAttribute('data-tooltip-classes', (options.classes ?? []).join(' ')); }
    export function setIcon(el) { el.append(el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')); }
    export const loadPdfJs = () => { throw new Error('Not used by editor fixture'); };
    export class TFile {}
    export class App {}
  `,
        }));
      },
    },
  ],
});
// A local file URL keeps package resolution anchored in this repository.
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true });
const moduleUrl = new URL('../tmp/ui-tests/editor.mjs', import.meta.url);
await writeFile(moduleUrl, built.outputFiles[0]!.text);
const { TextEditor } = (await import(moduleUrl.href)) as { TextEditor: typeof Editor };
const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

interface MockScope {
  handlers: { key: string; modifiers: string[]; func(event: KeyboardEvent): unknown }[];
}
/** Mount the real editor on an anonymous session, mocking only host APIs, clipboard and page layout. */
async function fixture(
  pageCount = 1,
  withKeymap = false,
  rotation = 0,
  seed?: Uint8Array,
  shared?: TextSession,
  visible?: number[],
  hostFirst = false,
  initialFocus: { windowFocused?: boolean; pdfFocused?: boolean } = {},
) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    pdf.addPage([600, 800]).setRotation(degrees(rotation));
  }
  let bytes = await pdf.save();
  if (seed) {
    bytes = seed.slice();
  }
  let writes = 0;
  const session =
    shared ??
    (await TextSession.open(
      {
        read: async () => bytes,
        write: async (value) => {
          bytes = value;
          writes++;
        },
        backup: async () => 'original.pdf',
      },
      font,
    ));
  const dom = new JSDOM(
    `<body><div id="editor"><div id="tools"></div>${Array.from({ length: pageCount }, (_, i) => `<div id="${i ? 'page' + (i + 1) : 'page'}"></div>`).join('')}</div><button id="outside">Outside</button></body>`,
    { pretendToBeVisual: true },
  );
  const doc = dom.window.document;
  let windowFocused = initialFocus.windowFocused ?? true;
  Object.defineProperty(doc, 'hasFocus', { value: () => windowFocused });
  dom.window.addEventListener('focus', () => {
    windowFocused = true;
  });
  dom.window.addEventListener('blur', () => {
    windowFocused = false;
  });
  Object.assign(dom.window.Node.prototype, {
    instanceOf(this: Node, type: typeof Node) {
      return this instanceof type;
    },
  });
  let clipboardText = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardText = text;
      },
      readText: async () => clipboardText,
    },
  });
  const create = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const el = doc.createElement(tag);
    if (options.cls) {
      el.className = options.cls;
    }
    if (options.text) {
      el.textContent = options.text;
    }
    for (const [key, value] of Object.entries(options.attr ?? {})) {
      el.setAttribute(key, value);
    }
    this.append(el);
    return el;
  };
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl: create,
    createDiv(this: HTMLElement, options: object) {
      return create.call(this, 'div', options);
    },
    createSpan(this: HTMLElement, options: object) {
      return create.call(this, 'span', options);
    },
    scrollIntoView() {},
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
    }),
    setPointerCapture(this: HTMLElement, id: number) {
      this.dataset.capture = String(id);
    },
    hasPointerCapture(this: HTMLElement, id: number) {
      return this.dataset.capture === String(id);
    },
    releasePointerCapture(this: HTMLElement) {
      delete this.dataset.capture;
    },
  });
  const scanButton = doc.createElement('button');
  scanButton.setAttribute('aria-label', 'Detect answer lines in PDF');
  const viewports = Array.from({ length: pageCount }, () => ({
    width: 600,
    height: 800,
    scale: 1,
    rotation,
    convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    convertToViewportRectangle: (r: number[]) => [r[0]!, 800 - r[1]!, r[2]!, 800 - r[3]!],
  }));
  const native = {
    identity: {},
    element: doc.querySelector('#editor')!,
    file: {},
    toolbarHost: () => doc.querySelector('#tools')!,
    answerLineButton: () => scanButton,
    pages: () =>
      Array.from({ length: pageCount }, (_, i) => ({
        div: doc.querySelector(i ? '#page' + (i + 1) : '#page')!,
        number: i + 1,
        viewport: viewports[i],
      })),
  } as unknown as EditorSurface;
  if (visible) {
    Object.assign(native, {
      editablePages: () => native.pages().filter((page) => visible.includes(page.number)),
      revealPage: (number: number) => visible.splice(0, visible.length, number),
    });
  }
  const sessions = {
    get: async () => session,
    preferences: loadToolPreferences({ holdShapes: true }),
    updatePreferences: async () => {},
  } as unknown as VaultSessions;
  const scopes: MockScope[] = [];
  const app = withKeymap
    ? {
        scope: {},
        keymap: {
          pushScope(scope: MockScope) {
            scopes.push(scope);
          },
          popScope(scope: MockScope) {
            const index = scopes.lastIndexOf(scope);
            if (index >= 0) {
              scopes.splice(index, 1);
            }
          },
        },
      }
    : {};
  let noteUndos = 0;
  if (hostFirst) {
    dom.window.addEventListener(
      'keydown',
      (event) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') {
          return;
        }
        const handler = scopes
          .at(-1)
          ?.handlers.find(
            (handler) =>
              handler.key === 'z' && handler.modifiers.includes('Shift') === event.shiftKey,
          );
        // A matched public Scope handler stops parent lookup even when it permits
        // native input undo. The host capture listener predates the PDF editor.
        if (handler) {
          if (handler.func(event) === false) {
            event.preventDefault();
            event.stopPropagation();
          }
        } else {
          noteUndos++;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  if (initialFocus.pdfFocused) {
    const page = native.pages()[0]!.div;
    page.tabIndex = 0;
    page.focus();
  }
  const editor = new TextEditor(app as unknown as App, native, sessions);
  await pause(0);
  const pointer = (target: Element, name: string, x = 0, y = 0, shiftKey = false) => {
    const event = new dom.window.MouseEvent(name, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
      shiftKey,
      cancelable: true,
    });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
    return event;
  };
  const key = (key: string, options: KeyboardEventInit = {}) =>
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  const tool = (label: string) => {
    const button = doc.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
    pointer(button, 'pointerdown');
    button.focus();
    button.click();
  };
  const dispose = () => {
    (editor as Editor & { unload(): void }).unload();
    dom.window.close();
  };
  return {
    doc,
    session,
    editor,
    sessions,
    scopes,
    pointer,
    key,
    tool,
    dispose,
    native,
    viewports,
    bytes: () => bytes,
    writes: () => writes,
    noteUndos: () => noteUndos,
    clipboard: {
      get text() {
        return clipboardText;
      },
      set text(value: string) {
        clipboardText = value;
      },
    },
  };
}

test('a 450-page PDF bounds editing layers while retaining an offscreen caret and save/reopen state', async (context) => {
  const visible = [1, 2, 3];
  const started = performance.now();
  const f = await fixture(450, false, 0, undefined, undefined, visible);
  try {
    context.diagnostic(
      JSON.stringify({
        pages: 450,
        mountedLayers: f.doc.querySelectorAll('.pdf-form-studio-layer').length,
        nodes: f.doc.querySelectorAll('*').length,
        mountMilliseconds: Math.round(performance.now() - started),
      }),
    );
    assert.equal(f.doc.querySelectorAll('.pdf-form-studio-layer').length, 3);
    const field = f.session.add(1, [80, 500, 340, 540], 14, true);
    f.session.setValue(field.name, 'Unicode café');
    const input = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    input.focus();
    input.setSelectionRange(2, 6);
    visible.splice(0, visible.length, 448, 449, 450);
    f.editor.refresh();
    assert.equal(f.doc.querySelectorAll('.pdf-form-studio-layer').length, 4);
    assert.equal(f.doc.activeElement, input);
    assert(input.isConnected);
    assert.equal(input.selectionStart, 2);
    assert.equal(input.selectionEnd, 6);
    f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await pause(0);
    f.editor.refresh();
    assert.equal(f.doc.querySelectorAll('.pdf-form-studio-layer').length, 3);
    assert.equal(input.isConnected, false);
    await f.session.saveWhenIdle();
    assert.equal(
      (await readTextPdf(f.bytes())).fields.find((item) => item.name === field.name)!.value,
      'Unicode café',
    );
    visible.splice(0, visible.length, 1);
    f.editor.refresh();
    assert.equal(
      f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!.value,
      'Unicode café',
    );
    f.editor.addSuggestedField(449, [80, 600, 340, 620], true);
    assert.equal(
      (f.doc.activeElement as HTMLElement).dataset.pdfField,
      f.session.snapshot.fields.at(-1)!.name,
    );
  } finally {
    f.dispose();
  }
});

test('virtualized pages retain active placement and pen capture until cancelled, without adding history', async () => {
  for (const tool of ['Add text box', 'Pen']) {
    const visible = [1];
    const f = await fixture(450, false, 0, undefined, undefined, visible);
    try {
      f.tool(tool);
      const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
      f.pointer(layer, 'pointerdown', 80, 180);
      f.pointer(layer, 'pointermove', 240, 280);
      visible.splice(0, visible.length, 450);
      f.editor.refresh();
      assert(layer.isConnected);
      assert.equal(f.doc.querySelectorAll('.pdf-form-studio-layer').length, 2);
      f.editor.cancelInteractions();
      f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
      await pause(0);
      f.editor.refresh();
      assert.equal(layer.isConnected, false);
      assert.equal(f.doc.querySelectorAll('.pdf-form-studio-layer').length, 1);
      assert.equal(f.session.snapshot.fields.length, 0);
      assert.equal(f.session.snapshot.strokes.length, 0);
      assert.equal(f.session.canUndoStroke, false);
    } finally {
      f.dispose();
    }
  }
});

test('unfocused spacing values scrub with captured pointers, retain the PDF caret and commit one history action', async () => {
  for (const [label, distance, expected] of [
    ['Letter spacing (PDF points)', 60, 1.2],
    ['Line spacing (multiplier)', 100, 1.7],
  ] as const) {
    const f = await fixture();
    try {
      const field = f.session.add(1, [80, 400, 340, 620], 14, true);
      f.session.setValue(field.name, 'Unicode café\nSecond line');
      await f.session.save();
      const answer = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
      answer.focus();
      answer.setSelectionRange(2, 8);
      f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
      const value = f.doc.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      f.pointer(value, 'pointerdown', 100);
      assert(value.hasPointerCapture(1));
      f.pointer(value, 'pointermove', 100 + distance);
      assert.equal(f.doc.activeElement, answer);
      assert.equal(answer.selectionStart, 2);
      assert.equal(answer.selectionEnd, 8);
      assert.equal(field.letterSpacing, undefined);
      assert.equal(field.lineSpacing, undefined);
      f.pointer(value, 'pointerup', 100 + distance);
      assert.equal(value.hasPointerCapture(1), false);
      const property = label.startsWith('Letter') ? 'letterSpacing' : 'lineSpacing';
      assert.equal(field[property], expected);
      f.session.undoStroke();
      assert.equal(
        f.session.snapshot.fields.find((item) => item.name === field.name)![property],
        undefined,
      );
      f.session.redoStroke();
      assert.equal(
        f.session.snapshot.fields.find((item) => item.name === field.name)![property],
        expected,
      );
      await f.session.saveWhenIdle();
      assert.equal(
        (await readTextPdf(f.bytes())).fields.find((item) => item.name === field.name)![property],
        expected,
      );
    } finally {
      f.dispose();
    }
  }
});

test('value clicks enter editing and interrupted focused-value scrubs restore spacing and release capture', async () => {
  for (const interruption of [
    'Escape',
    'pointercancel',
    'lostpointercapture',
    'blur',
    'dispose',
    'reload',
  ]) {
    const f = await fixture();
    try {
      const field = f.session.add(1, [80, 400, 340, 620], 14, true);
      f.session.setValue(field.name, 'Kept');
      await f.session.save();
      const answer = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
      answer.focus();
      f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
      const value = f.doc.querySelector<HTMLInputElement>(
        '[aria-label="Line spacing (multiplier)"]',
      )!;
      f.pointer(value, 'pointerdown', 100);
      f.pointer(value, 'pointermove', 102);
      f.pointer(value, 'pointerup', 102);
      assert.equal(f.doc.activeElement, value);
      assert.equal(f.session.dirty, false);
      value.setSelectionRange(0, 2);
      assert.equal(f.pointer(value, 'pointerdown', 100).defaultPrevented, true);
      f.pointer(value, 'pointermove', 200);
      assert.equal(value.hasPointerCapture(1), true);
      assert.equal(f.doc.activeElement, value);
      if (interruption === 'Escape') {
        value.dispatchEvent(f.key('Escape'));
      } else if (interruption === 'blur') {
        f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
      } else if (interruption === 'dispose') {
        f.doc.querySelector<HTMLButtonElement>('[aria-label="Close tool settings"]')!.click();
      } else if (interruption === 'reload') {
        await f.session.reload();
      } else {
        f.pointer(value, interruption);
      }
      assert.equal(value.hasPointerCapture(1), false, interruption);
      assert.equal(
        f.session.snapshot.fields.find((item) => item.name === field.name)!.lineSpacing,
        undefined,
        interruption,
      );
      assert.equal(f.session.dirty, false, interruption);
      await f.session.saveWhenIdle();
    } finally {
      f.dispose();
    }
  }
});

test('spacing resets restore defaults independently, clear validation errors and each undo once', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 400, 340, 620], 14, true);
    f.session.setValue(field.name, 'Two lines\nUnicode café');
    f.session.formatField(field.name, { letterSpacing: 2, lineSpacing: 1.75 });
    await f.session.save();
    const answer = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    answer.focus();
    answer.setSelectionRange(2, 8);
    f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
    const value = f.doc.querySelector<HTMLInputElement>(
      '[aria-label="Letter spacing (PDF points)"]',
    )!;
    value.value = 'Infinity';
    value.dispatchEvent(new f.doc.defaultView!.Event('change'));
    assert.equal(value.getAttribute('aria-invalid'), 'true');
    const reset = f.doc.querySelector<HTMLButtonElement>(
      '[aria-label="Reset letter spacing to 0 pt"]',
    )!;
    f.pointer(reset, 'pointerdown');
    reset.click();
    assert.equal(field.letterSpacing, 0);
    assert.equal(field.lineSpacing, 1.75);
    assert.equal(value.getAttribute('aria-invalid'), 'false');
    assert.equal(f.doc.activeElement, answer);
    assert.equal(answer.selectionStart, 2);
    assert.equal(answer.selectionEnd, 8);
    f.session.undoStroke();
    assert.equal(
      f.session.snapshot.fields.find((item) => item.name === field.name)!.letterSpacing,
      2,
    );
    assert.equal(value.value, '2');
    f.session.redoStroke();
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Reset line spacing to 1.2 ×"]')!.click();
    assert.equal(
      f.session.snapshot.fields.find((item) => item.name === field.name)!.lineSpacing,
      1.2,
    );
    f.session.undoStroke();
    assert.equal(
      f.session.snapshot.fields.find((item) => item.name === field.name)!.lineSpacing,
      1.75,
    );
    assert.equal(
      f.session.snapshot.fields.find((item) => item.name === field.name)!.letterSpacing,
      0,
    );
    f.session.redoStroke();
    await f.session.saveWhenIdle();
    const reopened = (await readTextPdf(f.bytes())).fields.find(
      (item) => item.name === field.name,
    )!;
    assert.equal(reopened.letterSpacing, 0);
    assert.equal(reopened.lineSpacing, 1.2);
    assert.equal(reopened.value, 'Two lines\nUnicode café');
    const task = getDocument({
      data: f.bytes().slice(),
      standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    try {
      const page = await (await task.promise).getPage(1);
      const operators = await page.getOperatorList();
      const matrices = operators.fnArray.flatMap((op, index) =>
        op === OPS.setTextMatrix ? [operators.argsArray[index]![0] as number[]] : [],
      );
      const baselines = [...new Set(matrices.map((matrix) => matrix[5]!))].sort((a, b) => b - a);
      assert.equal(baselines.length, 2);
      assert(Math.abs(baselines[0]! - baselines[1]! - 14 * 1.2) < 0.01);
      assert.equal(
        (await page.getAnnotations()).find((item) => item.fieldName === field.name)!.fieldValue,
        'Two lines\nUnicode café',
      );
    } finally {
      await task.destroy();
    }
  } finally {
    f.dispose();
  }
});

test('alignment controls expose the authored selection and resize can fit a single narrow glyph below 40pt', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 400, 340, 620], 14, true);
    f.session.setValue(field.name, 'iiii');
    f.session.formatField(field.name, { alignment: 'right' });
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
    assert.equal(
      f.doc.querySelector('[aria-label="Align right"]')!.getAttribute('aria-pressed'),
      'true',
    );
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Align center"]')!.click();
    assert.equal(field.alignment, 'center');
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Close tool settings"]')!.click();
    const minimum = f.session.minimumTextBoxSize(field.name)[0];
    assert(minimum < 40);
    f.pointer(frame.querySelector('[data-resize="e"]')!, 'pointerdown', 340, 500);
    f.pointer(frame, 'pointermove', 80, 500);
    f.pointer(frame, 'pointerup', 80, 500);
    assert(Math.abs(field.widgets[0]!.rect[2] - field.widgets[0]!.rect[0] - minimum) < 0.01);
    assert.equal(field.value, 'iiii');
    await f.session.save();
    assert.equal(
      (await readTextPdf(f.bytes())).fields.find((item) => item.name === field.name)!.value,
      'iiii',
    );
  } finally {
    f.dispose();
  }
});

test('an open text popover keeps its captured document target and closes when keyboard focus moves outside', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 400, 340, 620], 14, true);
    f.session.setValue(field.name, 'Retained target');
    f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!.focus();
    f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
    const center = f.doc.querySelector<HTMLButtonElement>('[aria-label="Align center"]')!;
    center.focus();
    // Native focus changes can release the selected-object proxy while a portal owns interaction.
    Object.assign(f.editor, { selected: undefined });
    center.click();
    assert.equal(field.alignment, 'center');
    f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    assert.equal(f.doc.querySelector('.pfs-tool-popover'), null);
  } finally {
    f.dispose();
  }
});

test('authored inputs retain geometry, styles, focus and values through zoom and every page rotation', async () => {
  const seed = await authoredForms();
  const f = await fixture(1, false, 0, seed);
  const task = getDocument({
    data: seed.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const input = f.doc.querySelector<HTMLInputElement>('[data-pdf-field="Blank"]')!;
    const frame = input.parentElement!;
    const rect = [
      ...f.session.snapshot.fields.find((field) => field.name === 'Blank')!.widgets[0]!.rect,
    ];
    f.pointer(frame, 'pointerdown', 100, 200);
    input.value = 'Rotation answer';
    input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    input.setSelectionRange(3, 6);
    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.5, 2]) {
        const viewport = page.getViewport({ scale, rotation });
        f.viewports[0] = viewport;
        f.editor.refresh();
        assert.equal(input.style.fontSize, `${16 * scale}px`);
        assert.equal(frame.style.borderWidth, `${2 * scale}px`);
        assert.equal(frame.style.transform, `rotate(${rotation}deg)`);
        assert.equal(f.doc.activeElement, input);
        assert.equal(input.selectionStart, 3);
        assert.equal(input.selectionEnd, 6);
        const r = viewport.convertToViewportRectangle(rect);
        const left = Math.min(r[0]!, r[2]!);
        const right = Math.max(r[0]!, r[2]!);
        const top = Math.min(r[1]!, r[3]!);
        const bottom = Math.max(r[1]!, r[3]!);
        assert.equal(frame.style.left, `${rotation === 90 || rotation === 180 ? right : left}px`);
        assert.equal(frame.style.top, `${rotation === 180 || rotation === 270 ? bottom : top}px`);
      }
    }
    f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await f.session.saveWhenIdle();
    assert.deepEqual(
      (await readTextPdf(f.bytes())).fields.find((field) => field.name === 'Blank')!.widgets[0]!
        .rect,
      rect,
    );
  } finally {
    f.dispose();
    await task.destroy();
  }
});

test('two document windows share authored values and preserve blanks during focus handoff, autosave and undo/redo', async () => {
  const seed = await authoredForms();
  const main = await fixture(1, true, 0, seed);
  const popout = await fixture(1, true, 0, seed, main.session);
  try {
    const a = main.doc.querySelector<HTMLInputElement>(`[data-pdf-field="${prefixBlank}"]`)!;
    const b = popout.doc.querySelector<HTMLInputElement>(`[data-pdf-field="${prefixBlank}"]`)!;
    main.pointer(a.parentElement!, 'pointerdown', 100, 200);
    a.value = 'Main answer';
    a.dispatchEvent(new main.doc.defaultView!.Event('input', { bubbles: true }));
    assert.equal(b.value, 'Main answer');
    popout.pointer(b.parentElement!, 'pointerdown', 100, 200);
    b.value = '';
    b.dispatchEvent(new popout.doc.defaultView!.Event('input', { bubbles: true }));
    main.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    popout.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await pause(0);
    assert.equal(main.session.pruneEmptyBoxes(), 0);
    await main.session.saveWhenIdle();
    assert.equal((await readTextPdf(main.bytes())).fields.length, 8);
    b.parentElement!.focus();
    b.value = 'Popout answer';
    b.dispatchEvent(new popout.doc.defaultView!.Event('input', { bubbles: true }));
    popout.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await main.session.saveWhenIdle();
    assert.equal(
      (await readTextPdf(main.bytes())).fields.find((field) => field.name === prefixBlank)!.value,
      'Popout answer',
    );
    main.session.undoStroke();
    assert.equal(a.value, '');
    assert.equal(b.value, '');
    await main.session.saveWhenIdle();
    main.session.redoStroke();
    assert.equal(a.value, 'Popout answer');
    assert.equal(b.value, 'Popout answer');
    await main.session.saveWhenIdle();
  } finally {
    popout.dispose();
    main.dispose();
  }
});

test('recovered orphan inputs mount visibly without autosaving and share edits through popout focus, rotation and zoom', async () => {
  const seed = await orphanForms();
  const main = await fixture(1, true, 0, seed);
  const popout = await fixture(1, true, 0, seed, main.session);
  const task = getDocument({
    data: seed.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    await pause(1050);
    assert.equal(main.writes(), 0);
    assert.deepEqual(main.bytes(), seed);
    const a = main.doc.querySelector<HTMLTextAreaElement>('[data-pdf-field="Orphan multiline"]')!;
    const b = popout.doc.querySelector<HTMLTextAreaElement>('[data-pdf-field="Orphan multiline"]')!;
    assert.equal(a.tagName, 'TEXTAREA');
    assert.equal(a.parentElement!.style.borderWidth, '1px');
    assert.equal(a.parentElement!.style.backgroundColor, 'rgb(255, 255, 255)');
    main.pointer(a.parentElement!, 'pointerdown', 100, 200);
    assert.equal(main.doc.activeElement, a);
    a.value = 'Main row\nSecond row';
    a.dispatchEvent(new main.doc.defaultView!.Event('input', { bubbles: true }));
    assert.equal(b.value, a.value);
    const page = await (await task.promise).getPage(1);
    for (const rotation of [0, 90, 180, 270]) {
      for (const scale of [0.5, 2]) {
        main.viewports[0] = page.getViewport({ rotation, scale });
        main.editor.refresh();
        assert.equal(a.style.fontSize, `${12 * scale}px`);
        assert.equal(a.parentElement!.style.borderWidth, `${scale}px`);
        assert.equal(a.parentElement!.style.transform, `rotate(${rotation}deg)`);
        assert.equal(main.doc.activeElement, a);
      }
    }
    main.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await pause(0);
    await main.session.saveWhenIdle();
    await pause(1050); // Separate typing bursts for the session's normal text undo grouping.
    popout.pointer(b.parentElement!, 'pointerdown', 100, 200);
    b.value = '';
    b.dispatchEvent(new popout.doc.defaultView!.Event('input', { bubbles: true }));
    main.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    popout.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await pause(0);
    await main.session.saveWhenIdle();
    assert.equal(
      (await readTextPdf(main.bytes())).fields.find((field) => field.name === 'Orphan multiline')!
        .value,
      '',
    );
    main.session.undoStroke();
    assert.equal(a.value, 'Main row\nSecond row');
    assert.equal(b.value, a.value);
    await main.session.saveWhenIdle();
    main.session.redoStroke();
    assert.equal(a.value, '');
    await main.session.saveWhenIdle();
    assert.equal(main.session.snapshot.fields.length, 9);
    assert.equal(main.session.pruneEmptyBoxes(), 0);
  } finally {
    popout.dispose();
    main.dispose();
    await task.destroy();
  }
});
test('modifier-wheel zoom cancels text placement before changing its viewport and releases autosave', async () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const f = await fixture();
    const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
    const stop = bindSurfaceInput(f.doc.querySelector<HTMLElement>('#page')!, {
      interrupt: () => f.editor.cancelInteractions(),
      zoom: () => {
        assert.equal(f.doc.querySelector('.pdf-form-studio-placement'), null);
        f.viewports[0]!.scale = 2;
        f.viewports[0]!.width = 1200;
        f.viewports[0]!.height = 1600;
        f.editor.refresh();
      },
    });
    try {
      f.tool('Add text box');
      f.pointer(layer, 'pointerdown', 80, 180);
      f.pointer(layer, 'pointermove', 240, 280);
      assert(f.doc.querySelector('.pdf-form-studio-placement'));
      layer.dispatchEvent(
        new f.doc.defaultView!.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -20,
          [modifier]: true,
        }),
      );
      f.pointer(layer, 'pointerup', 240, 280);
      assert.equal(f.session.snapshot.fields.length, 0);
      assert.equal(f.session.canUndoStroke, false);
      const field = f.session.add(1, [80, 500, 340, 540], 14, true);
      f.session.setValue(field.name, 'Retained edit');
      await Promise.race([
        f.session.saveWhenIdle(),
        pause(1000).then(() => {
          throw new Error('Cancelled placement blocked autosave');
        }),
      ]);
      assert.equal(f.writes(), 1);
      assert.equal((await readTextPdf(f.bytes())).fields[0]!.value, 'Retained edit');
    } finally {
      stop();
      f.dispose();
    }
  }
});
test('click and drag Text placement each return to Select after one box', async () => {
  const f = await fixture();
  try {
    const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    for (const drag of [false, true]) {
      f.tool('Add text box');
      f.pointer(layer, 'pointerdown', drag ? 340 : 80, drag ? 250 : 180);
      if (drag) {
        f.pointer(layer, 'pointermove', 500, 300);
      }
      f.pointer(layer, 'pointerup', drag ? 500 : 80, drag ? 300 : 180);
      assert.equal(
        f.doc
          .querySelector<HTMLButtonElement>('button[aria-label^="Select"]')!
          .getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(
        f.doc
          .querySelector<HTMLButtonElement>('button[aria-label^="Add text box"]')!
          .getAttribute('aria-pressed'),
        'false',
      );
      const input = f.doc.activeElement as HTMLTextAreaElement;
      assert.equal(input.tagName, 'TEXTAREA');
      input.value = drag ? 'Dragged' : 'Clicked';
      input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
      const count = f.session.snapshot.fields.length;
      f.pointer(layer, 'pointerdown', 550, 450);
      f.pointer(layer, 'pointerup', 550, 450);
      assert.equal(f.session.snapshot.fields.length, count);
    }
    assert.deepEqual(
      f.session.snapshot.fields.map((field) => field.value),
      ['Clicked', 'Dragged'],
    );
  } finally {
    f.dispose();
  }
});

test('blank-space marquee selects mixed objects, moves as one group, cancels and undoes atomically', async () => {
  const f = await fixture();
  try {
    const text = f.session.add(1, [80, 580, 180, 610], 14, true);
    f.session.setValue(text.name, 'Group answer');
    const stroke = f.session.addStroke(
      1,
      'scribble',
      [
        [230, 580],
        [260, 620],
        [290, 580],
      ],
      2,
    );
    const page = f.doc.querySelector('#page')!;
    f.pointer(page, 'pointerdown', 60, 160);
    f.pointer(page, 'pointermove', 310, 240);
    f.pointer(page, 'pointerup', 310, 240);
    assert.equal(f.doc.querySelectorAll('.is-multi-selected').length, 2);
    const originalText = [...text.widgets[0]!.rect];
    const originalInk = structuredClone(stroke.points);
    const frame = f.doc.querySelector('.pdf-form-studio-box')!;
    f.pointer(frame, 'pointerdown', 100, 200);
    f.pointer(page, 'pointermove', 130, 220);
    assert.deepEqual(
      text.widgets[0]!.rect,
      originalText,
      'drag preview must not change persistent state',
    );
    f.pointer(page, 'pointercancel');
    assert.deepEqual(text.widgets[0]!.rect, originalText);
    f.pointer(frame, 'pointerdown', 100, 200);
    f.pointer(page, 'pointermove', 130, 220);
    f.pointer(page, 'pointerup', 130, 220);
    assert.deepEqual(text.widgets[0]!.rect, [110, 560, 210, 590]);
    assert.deepEqual(
      f.session.snapshot.strokes[0]!.points,
      originalInk.map(([x, y]) => [x + 30, y - 20]),
    );
    f.doc.body.dispatchEvent(f.key('z', { metaKey: true }));
    assert.deepEqual(f.session.snapshot.fields[0]!.widgets[0]!.rect, originalText);
    assert.deepEqual(f.session.snapshot.strokes[0]!.points, originalInk);
    f.session.redoStroke();
    await f.session.save();
    const reopened = await readTextPdf(f.bytes());
    assert.equal(reopened.fields[0]!.value, 'Group answer');
    assert.equal(reopened.strokes.length, 1);
    f.doc.body.dispatchEvent(f.key('Delete'));
    assert.equal(f.session.snapshot.fields.length, 0);
    assert.equal(f.session.snapshot.strokes.length, 0);
    f.session.undoStroke();
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.session.snapshot.strokes.length, 1);
  } finally {
    f.dispose();
  }
});

test('another view starting an ink action cancels a pending group drag without changing its geometry', async () => {
  const f = await fixture();
  try {
    const text = f.session.add(1, [80, 580, 180, 610], 14, true);
    f.session.setValue(text.name, 'Keep position');
    const page = f.doc.querySelector('#page')!;
    f.pointer(page, 'pointerdown', 60, 160);
    f.pointer(page, 'pointermove', 220, 240);
    f.pointer(page, 'pointerup', 220, 240);
    f.pointer(f.doc.querySelector('.pdf-form-studio-box')!, 'pointerdown', 100, 200);
    f.pointer(page, 'pointermove', 160, 260);
    const owner = {};
    assert(f.session.beginInkAction(owner));
    f.session.addStroke(
      1,
      'scribble',
      [
        [400, 400],
        [450, 450],
      ],
      2,
      undefined,
      owner,
    );
    f.pointer(page, 'pointerup', 160, 260);
    f.session.finishInkAction(false, owner);
    assert.deepEqual(text.widgets[0]!.rect, [80, 580, 180, 610]);
    assert.equal(f.session.snapshot.strokes.length, 1);
    assert.equal(
      (f.doc.querySelector('.pdf-form-studio-box') as HTMLElement).style.translate,
      '0px 0px',
    );
  } finally {
    f.dispose();
  }
});

test('detected answers use Select, reuse fields and never create boxes from subsequent blank-page clicks', async () => {
  const f = await fixture();
  try {
    const rect = [80, 600, 340, 620] as [number, number, number, number];
    f.tool('Pen');
    f.editor.setAnswerLines([{ page: 1, rect }]);
    f.editor.addSuggestedField(1, rect);
    const first = f.session.snapshot.fields[0]!;
    assert.equal(
      f.doc
        .querySelector<HTMLButtonElement>('button[aria-label^="Select"]')!
        .getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      f.doc
        .querySelector<HTMLButtonElement>('button[aria-label^="Add text box"]')!
        .getAttribute('aria-pressed'),
      'false',
    );
    f.editor.addSuggestedField(1, rect);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.session.snapshot.fields[0]!.name, first.name);
    const input = f.doc.activeElement as HTMLTextAreaElement;
    input.value = 'Keep this answer';
    input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    const layer = f.doc.querySelector('.pdf-form-studio-layer')!;
    f.pointer(layer, 'pointerdown', 150, 250);
    f.pointer(layer, 'pointerup', 150, 250);
    assert.equal(f.session.snapshot.fields.length, 1);
    const frame = f.doc.querySelector('.pdf-form-studio-box')!;
    for (const element of [frame, frame.querySelector('[data-resize="se"]')!, input]) {
      assert.equal(
        element.hasAttribute('aria-label'),
        false,
        'PDF objects do not trigger Obsidian hover labels',
      );
      assert.equal(element.hasAttribute('title'), false);
      const label = f.doc.getElementById(element.getAttribute('aria-labelledby')!);
      assert.equal(label?.hidden, true, 'screen-reader names remain available');
    }
    f.pointer(frame, 'pointerdown', 100, 180);
    assert.equal(f.doc.activeElement, input);
    assert.equal(input.readOnly, false);
    f.editor.addSuggestedField(1, rect);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.session.snapshot.fields[0]!.value, 'Keep this answer');
    f.editor.setAnswerLines([]);
    input.blur();
    f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
    await pause(0);
    f.pointer(frame, 'pointerdown', 100, 180);
    assert.equal(f.doc.activeElement, input);
    await f.session.save();
    const reopened = await readTextPdf(f.bytes());
    assert.equal(reopened.fields.length, 1);
    assert.equal(reopened.fields[0]!.value, 'Keep this answer');
  } finally {
    f.dispose();
  }
});
test('Tab and Shift+Tab navigate detected lines in page order without duplicates, including offscreen pages', async () => {
  const f = await fixture(2);
  try {
    const a = { page: 1, rect: [80, 600, 340, 620] as [number, number, number, number] };
    const b = { page: 1, rect: [80, 540, 340, 560] as [number, number, number, number] };
    const c = { page: 2, rect: [80, 600, 340, 620] as [number, number, number, number] };
    f.editor.setAnswerLines([c, b, a]);
    f.editor.addSuggestedField(a.page, a.rect);
    const enter = (value: string) => {
      const input = f.doc.activeElement as HTMLTextAreaElement;
      input.value = value;
      input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
      return input.dataset.pdfField;
    };
    const tab = (shiftKey = false) => {
      const event = f.key('Tab', { shiftKey });
      f.doc.activeElement!.dispatchEvent(event);
      return event;
    };
    let escaped = 0;
    f.doc.addEventListener('keydown', () => escaped++);
    const first = enter('First');
    assert.equal(tab().defaultPrevented, true);
    const second = enter('Second');
    assert.equal(tab().defaultPrevented, true);
    const third = enter('Third');
    assert.equal(f.doc.activeElement!.closest('#page2')?.id, 'page2');
    assert.equal(f.session.snapshot.fields.length, 3);
    assert.equal(escaped, 0);
    tab(true);
    assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, second);
    tab(true);
    assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, first);
    assert.equal(tab(true).defaultPrevented, false);
    tab();
    tab();
    assert.equal((f.doc.activeElement as HTMLElement).dataset.pdfField, third);
    assert.equal(tab().defaultPrevented, false);
    assert.equal(f.session.snapshot.fields.length, 3);
    await f.session.save();
    const reopened = await readTextPdf(f.bytes());
    assert.deepEqual(
      reopened.fields.map((field) => field.value),
      ['First', 'Second', 'Third'],
    );
    assert.equal(reopened.fields[2]!.widgets[0]!.page, 2);
  } finally {
    f.dispose();
  }
});

test('answer navigation skips locked fields and cannot mutate a replacing or conflicted session', async () => {
  const f = await fixture();
  try {
    const lines = [620, 560, 500].map((top) => ({
      page: 1,
      rect: [80, top - 20, 340, top] as [number, number, number, number],
    }));
    const locked = f.session.add(1, lines[1]!.rect, 14, false);
    locked.readOnly = true;
    f.editor.setAnswerLines(lines);
    f.editor.addSuggestedField(1, lines[0]!.rect);
    const tab = () => {
      const event = f.key('Tab');
      f.doc.activeElement!.dispatchEvent(event);
      return event;
    };
    assert.equal(tab().defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.deepEqual(f.session.snapshot.fields[1]!.widgets[0]!.rect, lines[2]!.rect);
    assert.equal(locked.value, '');
    f.session.status = 'conflict';
    f.editor.addSuggestedField(1, lines[0]!.rect);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(tab().defaultPrevented, false);
    f.session.status = 'unsaved';
  } finally {
    f.dispose();
  }
});

test('consecutive detected lines create one persistent ruled answer with normal typing and additional rows', async () => {
  const f = await fixture();
  try {
    const lines = [620, 596, 572, 480].map((y) => ({
      page: 1,
      rect: [80, y, 340, y + 18] as [number, number, number, number],
    }));
    f.editor.setAnswerLines(lines);
    f.editor.addSuggestedField(1, lines[1]!.rect);
    const field = f.session.snapshot.fields[0]!;
    const input = f.doc.activeElement as HTMLTextAreaElement;
    const rect = [...field.widgets[0]!.rect];
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.deepEqual(field.ruled, { spacing: 24, rows: 3 });
    assert.equal(input.style.lineHeight, '24px');
    assert.equal(field.multiline, true);
    input.value = 'First ruled answer\nSecond line\nThird line';
    input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    assert.deepEqual(field.widgets[0]!.rect, rect, 'the original rows are retained while they fit');
    f.editor.addSuggestedField(1, lines[2]!.rect);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.doc.activeElement, input);
    const enter = f.key('Enter');
    input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
    await f.session.save();
    const saved = (await readTextPdf(f.bytes())).fields[0]!;
    assert.equal(saved.value, input.value);
    assert.deepEqual(saved.ruled, field.ruled);
    assert.deepEqual(saved.widgets[0]!.rect, rect);
    input.value += '\nFourth line without a printed rule';
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new f.doc.defaultView!.Event('input', { bubbles: true }));
    assert.equal(f.doc.activeElement, input);
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(field.ruled?.rows, 4);
    assert.deepEqual(field.widgets[0]!.rect, [80, 548, 340, 638]);
    await f.session.save();
    assert.equal((await readTextPdf(f.bytes())).fields[0]!.value, input.value);
    input.dispatchEvent(f.key('Tab'));
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(
      (f.doc.activeElement as HTMLElement).dataset.pdfField,
      f.session.snapshot.fields[1]!.name,
    );
    f.doc.activeElement!.dispatchEvent(f.key('Tab', { shiftKey: true }));
    assert.equal(f.doc.activeElement, input);
  } finally {
    f.dispose();
  }
});
test('selected PDF elements copy, paste and duplicate without intercepting text editing', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Copy me');
    f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const values = new Map<string, string>();
    const clipboardData = {
      setData(type: string, value: string) {
        values.set(type, value);
      },
      getData(type: string) {
        return values.get(type) ?? '';
      },
    };
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: clipboardData });
    frame.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    const paste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData });
    frame.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.session.snapshot.fields[1]!.value, 'Copy me');
    const duplicate = f.key('d', { metaKey: true });
    frame.dispatchEvent(duplicate);
    assert.equal(duplicate.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 3);
    const input = frame.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-pdf-field]')!;
    input.setSelectionRange(0, 4);
    const nativeCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(nativeCopy, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(nativeCopy);
    assert.equal(nativeCopy.defaultPrevented, false);
  } finally {
    f.dispose();
  }
});
test('selected drawing shortcuts use a keyboard target in an embedded PDF', async () => {
  const f = await fixture(1, true);
  try {
    f.session.addStroke(
      1,
      'scribble',
      [
        [80, 500],
        [120, 520],
      ],
      2,
    );
    f.editor.refresh();
    const drawing = f.doc.querySelector<SVGGElement>('.pdf-form-studio-ink-control')!;
    f.pointer(drawing, 'pointerdown', 100, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 100, 290);
    const proxy = f.doc.activeElement as HTMLTextAreaElement;
    assert.equal(proxy.classList.contains('pdf-form-studio-shortcut-proxy'), true);
    assert.equal(proxy.getAttribute('aria-label'), 'Selected PDF drawing');
    assert.equal(f.scopes.length, 1);
    for (const key of ['c', 'v', 'd']) {
      const event = f.key(key, { metaKey: true });
      f.doc.activeElement!.dispatchEvent(event);
      assert.equal(
        event.defaultPrevented,
        true,
        `⌘${key.toUpperCase()} should be handled for a drawing`,
      );
      await pause(0);
    }
    assert.equal(f.session.snapshot.strokes.length, 3);
    const selected = f.session.snapshot.strokes.at(-1)!;
    const before = structuredClone(selected.points);
    const arrow = f.key('ArrowRight');
    f.doc.activeElement!.dispatchEvent(arrow);
    assert.equal(arrow.defaultPrevented, true);
    assert.notDeepEqual(
      f.session.snapshot.strokes.find((stroke) => stroke.id === selected.id)!.points,
      before,
    );
  } finally {
    f.dispose();
  }
});
test('deleting a selected drawing releases its keyboard interaction so autosave can finish', async () => {
  const f = await fixture();
  try {
    f.session.addStroke(
      1,
      'scribble',
      [
        [80, 500],
        [120, 520],
      ],
      2,
    );
    f.editor.refresh();
    const drawing = f.doc.querySelector<SVGGElement>('.pdf-form-studio-ink-control')!;
    f.pointer(drawing, 'pointerdown', 100, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 100, 290);
    const proxy = f.doc.activeElement as HTMLTextAreaElement;
    assert.equal(proxy.getAttribute('aria-label'), 'Selected PDF drawing');
    const remove = f.key('Delete');
    proxy.dispatchEvent(remove);
    assert.equal(remove.defaultPrevented, true);
    assert.equal(f.session.snapshot.strokes.length, 0);
    assert.notEqual(f.doc.activeElement, proxy);
    await Promise.race([
      f.session.saveWhenIdle(),
      pause(1000).then(() => {
        throw new Error('Autosave remained blocked by the drawing proxy.');
      }),
    ]);
    assert.equal(f.session.status, 'saved');
  } finally {
    f.dispose();
  }
});
test('PDF answer shortcuts work with a caret while highlighted text retains native editing', async () => {
  const f = await fixture();
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Copy me');
    f.editor.refresh();
    const input = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    input.focus();
    input.setSelectionRange(7, 7);
    const duplicate = f.key('d', { metaKey: true });
    input.dispatchEvent(duplicate);
    assert.equal(duplicate.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(f.doc.activeElement?.classList.contains('pdf-form-studio-shortcut-proxy'), true);
    const held = f.key('d', { metaKey: true, repeat: true });
    f.doc.activeElement!.dispatchEvent(held);
    assert.equal(held.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 2);

    input.focus();
    input.setSelectionRange(7, 7);
    const values = new Map<string, string>();
    const clipboardData = {
      setData(type: string, value: string) {
        values.set(type, value);
      },
      getData(type: string) {
        return values.get(type) ?? '';
      },
    };
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    const paste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 3);

    input.focus();
    input.setSelectionRange(0, 4);
    const textCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(textCopy, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(textCopy);
    assert.equal(textCopy.defaultPrevented, false);
    const textPaste = new f.doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(textPaste);
    assert.equal(textPaste.defaultPrevented, false);
  } finally {
    f.dispose();
  }
});
test('another PDF toolbar releases the first embed shortcut scope while its own popover retains it', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'First PDF');
    f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    assert.equal(f.scopes.length, 1);
    f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
    assert(f.doc.querySelector('.pfs-tool-popover'));
    assert.equal(f.scopes.length, 1, 'opening this PDF toolbar popover keeps its selection');
    f.doc
      .querySelector<HTMLButtonElement>('.pfs-tool-popover [aria-label="Close tool settings"]')!
      .click();
    frame.focus();
    assert.equal(f.scopes.length, 1);

    const otherToolbar = f.doc.createElement('div');
    otherToolbar.className = 'pdf-form-studio-toolbar';
    const otherButton = f.doc.createElement('button');
    otherToolbar.append(otherButton);
    f.doc.body.append(otherToolbar);
    f.pointer(otherButton, 'pointerdown');
    assert.equal(
      f.scopes.length,
      0,
      'pointer input in another PDF toolbar releases the first scope',
    );
    frame.focus();
    assert.equal(f.scopes.length, 1);
    otherButton.focus();
    assert.equal(
      f.scopes.length,
      0,
      'keyboard focus in another PDF toolbar releases the first scope',
    );
    assert.equal(f.session.snapshot.fields.length, 1);
  } finally {
    f.dispose();
  }
});
test('a delayed PDF paste is canceled when another object is selected', async () => {
  const f = await fixture(1, true);
  try {
    const first = f.session.add(1, [80, 580, 240, 610], 12, true);
    const second = f.session.add(1, [80, 520, 240, 550], 12, true);
    f.session.setValue(first.name, 'First');
    f.session.setValue(second.name, 'Second');
    f.editor.refresh();
    let text = '';
    let finishRead: ((value: string) => void) | undefined;
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          text = value;
        },
        readText: () =>
          new Promise<string>((resolve) => {
            finishRead = resolve;
          }),
      },
    });
    const frames = f.doc.querySelectorAll<HTMLElement>('.pdf-form-studio-box');
    frames[0]!.focus();
    const shortcut = (key: string) =>
      f.doc.activeElement!.dispatchEvent(f.key(key, { metaKey: true }));
    shortcut('c');
    await pause(0);
    shortcut('v');
    await pause(0);
    assert(finishRead);
    frames[1]!.focus();
    finishRead(text);
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 2);
  } finally {
    f.dispose();
  }
});
test('menu copy keeps token provenance for keyboard paste with identical external text', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Yes');
    f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const values = new Map<string, string>();
    const nativeCopy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(nativeCopy, 'clipboardData', {
      value: {
        setData(type: string, value: string) {
          values.set(type, value);
        },
      },
    });
    frame.dispatchEvent(nativeCopy);
    assert.equal(nativeCopy.defaultPrevented, true);
    assert.match(values.get('text/html')!, /data-pdf-editor-objects/);
    let items = [
      { types: ['text/html'], getType: async () => new Blob([values.get('text/html')!]) },
    ];
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => items,
        readText: async () => 'Yes',
      },
    });
    const paste = () => f.doc.activeElement!.dispatchEvent(f.key('v', { metaKey: true }));
    paste();
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 2);
    assert.equal(
      f.session.snapshot.fields[1]!.widgets[0]!.rect[2] -
        f.session.snapshot.fields[1]!.widgets[0]!.rect[0],
      160,
    );
    items = [{ types: ['text/plain'], getType: async () => new Blob(['Yes']) }];
    paste();
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 3);
    assert.equal(f.session.snapshot.fields[2]!.value, 'Yes');
    assert.equal(
      f.session.snapshot.fields[2]!.widgets[0]!.rect[2] -
        f.session.snapshot.fields[2]!.widgets[0]!.rect[0],
      300,
    );
  } finally {
    f.dispose();
  }
});
test('menu paste waits for a copied drawing token instead of creating a fallback text box', async () => {
  const f = await fixture(1, true);
  try {
    const view = f.doc.defaultView!;
    class FakeClipboardItem {
      readonly types: string[];
      private readonly values: Record<string, Blob>;
      constructor(values: Record<string, Blob>) {
        this.values = values;
        this.types = Object.keys(values);
      }
      async getType(type: string) {
        return this.values[type]!;
      }
    }
    Object.defineProperty(view, 'ClipboardItem', { value: FakeClipboardItem });
    let plainText = 'Earlier clipboard content';
    let items: FakeClipboardItem[] = [];
    let completeWrite: (() => Promise<void>) | undefined;
    Object.defineProperty(view.navigator, 'clipboard', {
      configurable: true,
      value: {
        write: (value: FakeClipboardItem[]) =>
          new Promise<void>((resolve) => {
            completeWrite = async () => {
              items = value;
              plainText = await value[0]!.getType('text/plain').then((blob) => blob.text());
              resolve();
            };
          }),
        read: async () => items,
        writeText: async (value: string) => {
          plainText = value;
        },
        readText: async () => plainText,
      },
    });
    f.session.addStroke(
      1,
      'scribble',
      [
        [80, 500],
        [120, 520],
      ],
      2,
    );
    f.editor.refresh();
    const drawing = f.doc.querySelector<SVGGElement>('.pdf-form-studio-ink-control')!;
    f.pointer(drawing, 'pointerdown', 100, 290);
    f.pointer(f.doc.querySelector('.pdf-form-studio-layer')!, 'pointerup', 100, 290);
    const proxy = f.doc.activeElement as HTMLTextAreaElement;
    proxy.dispatchEvent(f.key('c', { metaKey: true }));
    assert(completeWrite);
    const paste = new view.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData(type: string) {
          return type === 'text/plain' ? plainText : '';
        },
      },
    });
    proxy.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, true);
    await completeWrite();
    await pause(0);
    assert.equal(plainText, 'PDF Editor elements');
    assert.equal(f.session.snapshot.strokes.length, 2);
    assert.equal(f.session.snapshot.fields.length, 0);
    items = [new FakeClipboardItem({ 'text/plain': new Blob([plainText]) })];
    const externalPaste = new view.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(externalPaste, 'clipboardData', {
      value: {
        getData(type: string) {
          return type === 'text/plain' ? plainText : '';
        },
      },
    });
    proxy.dispatchEvent(externalPaste);
    await pause(0);
    assert.equal(f.session.snapshot.strokes.length, 2);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(f.session.snapshot.fields[0]!.value, 'PDF Editor elements');
  } finally {
    f.dispose();
  }
});
test('PDF element shortcuts still work when Obsidian has no Clipboard API', async () => {
  const f = await fixture(1, true);
  try {
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', { value: undefined });
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Internal copy');
    f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    for (const letter of ['c', 'v']) {
      const event = f.key(letter, { metaKey: true });
      frame.dispatchEvent(event);
      assert(event.defaultPrevented);
    }
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 2);
  } finally {
    f.dispose();
  }
});
test('leaving Obsidian invalidates an internal PDF copy without Clipboard API', async () => {
  const f = await fixture(1, true);
  try {
    Object.defineProperty(f.doc.defaultView!.navigator, 'clipboard', { value: undefined });
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Old PDF copy');
    f.editor.refresh();
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    const shortcut = (key: string) =>
      f.doc.activeElement!.dispatchEvent(f.key(key, { metaKey: true }));
    shortcut('c');
    f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
    shortcut('v');
    await pause(0);
    assert.equal(f.session.snapshot.fields.length, 1);
  } finally {
    f.dispose();
  }
});
test('Save shortcut remains scoped to the PDF after its toolbar floats outside the editor', async () => {
  const f = await fixture();
  try {
    const host = f.doc.createElement('div');
    host.className = 'pfs-floating-toolbar';
    const navigation = host.appendChild(f.doc.createElement('button'));
    const search = host.appendChild(f.doc.createElement('input'));
    host.append(f.doc.querySelector('#tools')!);
    f.doc.body.append(host);
    let saves = 0;
    (f.editor as unknown as { save(): Promise<void> }).save = async () => {
      saves++;
    };
    for (const target of [navigation, search]) {
      const event = f.key('s', { metaKey: true });
      target.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal(saves, 2);
    const outside = f.key('s', { metaKey: true });
    f.doc.querySelector('#outside')!.dispatchEvent(outside);
    assert.equal(outside.defaultPrevented, false);
  } finally {
    f.dispose();
  }
});

test('HTML object copies preserve whitespace safely without inline styles', async () => {
  const f = await fixture();
  try {
    const value = '\nFirst  line\n\n<b>literal & safe</b>\tend\n';
    const field = f.session.add(1, [80, 500, 300, 610], 12, true);
    f.session.setValue(field.name, value);
    f.editor.refresh();
    const frame = f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!;
    frame.focus();
    const values = new Map<string, string>();
    const copy = new f.doc.defaultView!.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', {
      value: {
        setData(type: string, text: string) {
          values.set(type, text);
        },
      },
    });
    frame.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    assert.equal(values.get('text/plain'), value);
    const parsed = new f.doc.defaultView!.DOMParser().parseFromString(
      values.get('text/html')!,
      'text/html',
    );
    assert(parsed.querySelector('pre > span[data-pdf-editor-objects]'));
    assert.equal(parsed.body.textContent, value);
    assert.equal(parsed.querySelector('[style], b, script'), null);
  } finally {
    f.dispose();
  }
});

test('host-first preview shortcuts undo unselected drawings once, retain redo after deletion and release the note', async () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    const f = await fixture(1, true, 0, undefined, undefined, undefined, true);
    try {
      f.tool('Pen');
      const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
      for (const x of [80, 180]) {
        f.pointer(layer, 'pointerdown', x, 200);
        f.pointer(layer, 'pointermove', x + 30, 220);
        f.pointer(layer, 'pointerup', x + 30, 220);
      }
      assert.equal(f.session.snapshot.strokes.length, 2);
      assert.equal(f.doc.activeElement, layer);
      assert.equal(
        f.scopes.length,
        1,
        'a focused canvas owns the host scope without an object selection',
      );
      const shortcut = (options: KeyboardEventInit = {}) => {
        const event = f.key('z', { [modifier]: true, ...options });
        f.doc.activeElement!.dispatchEvent(event);
        return event;
      };
      assert.equal(shortcut().defaultPrevented, true);
      assert.equal(f.session.snapshot.strokes.length, 1);
      assert.equal(shortcut({ repeat: true }).defaultPrevented, true);
      assert.equal(f.session.snapshot.strokes.length, 1);
      shortcut();
      assert.equal(f.session.snapshot.strokes.length, 0);
      shortcut();
      assert.equal(f.noteUndos(), 0, 'empty PDF history cannot undo the note');
      shortcut({ shiftKey: true });
      assert.equal(f.session.snapshot.strokes.length, 1);
      assert.equal(f.noteUndos(), 0);
      const outside = f.doc.querySelector<HTMLButtonElement>('#outside')!;
      f.pointer(outside, 'pointerdown');
      outside.focus();
      assert.equal(f.scopes.length, 0);
      shortcut();
      assert.equal(f.noteUndos(), 1);
      layer.focus();
      assert.equal(f.scopes.length, 1);
      f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
      assert.equal(f.scopes.length, 0);
      f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('focus'));
      assert.equal(f.scopes.length, 1);
      await f.session.saveWhenIdle();
      assert.equal((await readTextPdf(f.bytes())).strokes.length, 1);
      const task = getDocument({ data: f.bytes().slice() });
      try {
        const saved = await task.promise;
        const annotations = await (await saved.getPage(1)).getAnnotations();
        assert.equal(
          annotations.filter((annotation) => annotation.subtype === 'Ink').length,
          1,
          'PDF.js independently sees the single redone drawing',
        );
      } finally {
        await task.destroy();
      }
    } finally {
      f.dispose();
    }
  }
});

test('an editor constructed after window handoff waits for owning-window focus before pushing its scope', async () => {
  for (const windowFocused of [false, true]) {
    const f = await fixture(1, true, 0, undefined, undefined, undefined, true, {
      windowFocused,
      pdfFocused: true,
    });
    try {
      assert.equal(
        f.doc.activeElement,
        f.native.pages()[0]!.div,
        'an inactive window can retain its PDF focus target during loading',
      );
      assert.equal(f.doc.hasFocus(), windowFocused);
      assert.equal(
        f.scopes.length,
        windowFocused ? 1 : 0,
        'session synchronization must respect actual initial window focus',
      );
      f.editor.refresh();
      assert.equal(f.scopes.length, windowFocused ? 1 : 0);
      for (let i = 0; i < 2; i++) {
        f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('focus'));
      }
      assert.equal(f.scopes.length, 1, 'returning to the owner pushes one scope');
      f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
      f.editor.refresh();
      assert.equal(
        f.scopes.length,
        0,
        'handoff releases the scope even after later synchronization',
      );
    } finally {
      f.dispose();
      assert.equal(f.scopes.length, 0);
    }
  }
});

test('host-first preview routing preserves typing undo and guards toolbar, composition and disposal', async () => {
  const f = await fixture(1, true, 0, undefined, undefined, undefined, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Typing');
    const input = f.doc.querySelector<HTMLTextAreaElement>(`[data-pdf-field="${field.name}"]`)!;
    input.focus();
    const shortcut = (target: Element, options: KeyboardEventInit = {}) => {
      const event = f.key('z', { metaKey: true, ...options });
      target.dispatchEvent(event);
      return event;
    };
    assert.equal(shortcut(input).defaultPrevented, false);
    assert.equal(f.noteUndos(), 0);
    assert.equal(field.value, 'Typing');
    const pen = f.doc.querySelector<HTMLButtonElement>('[aria-label="Pen"]')!;
    pen.focus();
    assert.equal(shortcut(pen, { isComposing: true }).defaultPrevented, false);
    assert.equal(f.session.snapshot.fields.length, 1);
    assert.equal(shortcut(pen).defaultPrevented, true);
    assert.equal(f.session.snapshot.fields.length, 0);
    assert.equal(f.noteUndos(), 0);
    const toolbar = f.doc.querySelector<HTMLElement>('.pdf-form-studio-toolbar')!;
    f.doc.body.append(toolbar);
    pen.focus();
    shortcut(pen, { shiftKey: true });
    assert.equal(f.session.snapshot.fields.length, 1);
  } finally {
    f.dispose();
    assert.equal(f.scopes.length, 0);
  }
});

test('Live Preview note keyboard targets undo the selected PDF, and typing in the note releases ownership', async () => {
  const f = await fixture(1, true);
  try {
    const field = f.session.add(1, [80, 580, 240, 610], 12, true);
    f.session.setValue(field.name, 'Selected');
    f.session.moveObjects([{ kind: 'text', id: field.name }], [10, 0]);
    f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
    const note = f.doc.createElement('div');
    note.contentEditable = 'true';
    note.tabIndex = 0;
    f.doc.body.append(note);
    const undo = f.key('z', { metaKey: true });
    note.dispatchEvent(undo);
    assert.equal(undo.defaultPrevented, true);
    assert.equal(f.session.snapshot.fields[0]!.widgets[0]!.rect[0], 80);
    note.focus();
    const own = f.key('z', { metaKey: true });
    note.dispatchEvent(own);
    assert.equal(own.defaultPrevented, false);
  } finally {
    f.dispose();
  }
});

test('undoing the focused drawing or text box retains PDF focus for a real subsequent redo', async () => {
  for (const kind of ['ink', 'text'] as const) {
    const f = await fixture(1, true);
    try {
      if (kind === 'ink') {
        f.session.addStroke(
          1,
          'scribble',
          [
            [80, 500],
            [120, 520],
          ],
          2,
        );
        f.editor.refresh();
        const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
        f.pointer(f.doc.querySelector('[data-pdf-stroke]')!, 'pointerdown', 100, 290);
        f.pointer(layer, 'pointerup', 100, 290);
      } else {
        const field = f.session.add(1, [80, 580, 240, 610], 12, true);
        f.session.setValue(field.name, 'Undo creation');
        f.doc.querySelector<HTMLElement>('.pdf-form-studio-box')!.focus();
      }
      const shortcut = (redo: boolean) => {
        const event = f.key('z', { metaKey: true, shiftKey: redo });
        f.doc.activeElement!.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
      };
      shortcut(false);
      assert.equal(f.session.snapshot[kind === 'ink' ? 'strokes' : 'fields'].length, 0);
      assert.equal(f.doc.activeElement!.classList.contains('pdf-form-studio-layer'), true);
      shortcut(true);
      assert.equal(f.session.snapshot[kind === 'ink' ? 'strokes' : 'fields'].length, 1);
    } finally {
      f.dispose();
    }
  }
});

test('selected ink resize previews cancel cleanly and a completed gesture is one undoable saved edit', async () => {
  const f = await fixture();
  try {
    const stroke = f.session.addStroke(
      1,
      'scribble',
      [
        [100, 500],
        [160, 550],
        [200, 500],
      ],
      2,
    );
    await f.session.save();
    const before = structuredClone(stroke);
    const group = f.doc.querySelector<SVGGElement>('[data-pdf-stroke]')!;
    const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
    f.pointer(group, 'pointerdown', 150, 300);
    f.pointer(layer, 'pointerup', 150, 300);
    const handle = group.querySelector<SVGRectElement>('[data-ink-resize="se"]')!;
    assert(handle.classList.contains('is-selected'));
    f.pointer(handle, 'pointerdown', 201, 301);
    f.pointer(layer, 'pointermove', 250, 330);
    assert.deepEqual(
      f.session.snapshot.strokes[0]!.points,
      before.points,
      'preview never changes the document',
    );
    f.pointer(layer, 'pointercancel');
    assert.deepEqual(f.session.snapshot.strokes[0]!.points, before.points);
    f.pointer(handle, 'pointerdown', 201, 301);
    f.pointer(layer, 'pointermove', 250, 330);
    f.pointer(layer, 'pointerup', 250, 330);
    assert.notDeepEqual(f.session.snapshot.strokes[0]!.points, before.points);
    assert.equal(f.session.snapshot.strokes[0]!.width, before.width);
    assert.equal(f.session.snapshot.strokes[0]!.id, before.id);
    f.session.undoStroke();
    assert.deepEqual(f.session.snapshot.strokes[0]!.points, before.points);
    f.session.redoStroke();
    await f.session.save();
    assert.equal((await readTextPdf(f.bytes())).strokes[0]!.id, before.id);
  } finally {
    f.dispose();
  }
});

test('snap-to-text creates separate editable marks per row with one shared history entry and freehand fallback', async () => {
  const f = await fixture();
  try {
    let measurements = 0;
    const pages = f.native.pages();
    pages[0]!.getTextWords = () => {
      measurements++;
      return [
        { start: [50, 600], end: [150, 600], height: 14, order: 0 },
        { start: [50, 575], end: [150, 575], height: 14, order: 1 },
      ];
    };
    f.native.pages = () => pages;
    f.editor.refresh();
    f.tool('Highlighter');
    f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Snap to text"]')!.click();
    f.doc.querySelector<HTMLButtonElement>('[aria-label="Close tool settings"]')!.click();
    const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
    f.pointer(layer, 'pointerdown', 60, 200);
    f.pointer(layer, 'pointermove', 140, 200);
    f.pointer(layer, 'pointermove', 140, 225);
    f.pointer(layer, 'pointerup', 60, 225);
    assert.equal(measurements, 1, 'geometry is captured once for a complete gesture');
    assert.equal(f.session.snapshot.strokes.length, 2);
    assert(f.session.snapshot.strokes.every((stroke) => stroke.points.length === 2));
    f.session.undoStroke();
    assert.equal(f.session.snapshot.strokes.length, 0);
    f.session.redoStroke();
    assert.equal(f.session.snapshot.strokes.length, 2);
    f.pointer(layer, 'pointerdown', 20, 500);
    f.pointer(layer, 'pointerup', 100, 500);
    assert.equal(f.session.snapshot.strokes.length, 3);
    assert.deepEqual(f.session.snapshot.strokes[2]!.points, [
      [20, 300],
      [100, 300],
    ]);
  } finally {
    f.dispose();
  }
});

test('resize interruptions preserve redo and release autosave without partial geometry', async () => {
  const f = await fixture();
  try {
    const stroke = f.session.addStroke(
      1,
      'scribble',
      [
        [100, 500],
        [200, 550],
      ],
      2,
    );
    await f.session.save();
    f.session.moveStroke(stroke.id, [10, 0]);
    f.session.undoStroke();
    assert(f.session.canRedoStroke);
    const points = structuredClone(f.session.snapshot.strokes[0]!.points);
    const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
    const select = () => {
      const group = f.doc.querySelector<SVGGElement>('[data-pdf-stroke]')!;
      f.pointer(group, 'pointerdown', 150, 275);
      f.pointer(layer, 'pointerup', 150, 275);
      return group.querySelector<SVGRectElement>('[data-ink-resize="se"]')!;
    };
    for (const cancel of ['escape', 'blur', 'capture', 'focus', 'tool', 'viewport']) {
      const handle = select();
      f.pointer(handle, 'pointerdown', 202, 302);
      f.pointer(layer, 'pointermove', 250, 330);
      if (cancel === 'escape') {
        layer.dispatchEvent(f.key('Escape'));
      }
      if (cancel === 'blur') {
        f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('blur'));
      }
      if (cancel === 'capture') {
        layer.releasePointerCapture(1);
        layer.dispatchEvent(new f.doc.defaultView!.Event('lostpointercapture'));
      }
      if (cancel === 'focus') {
        f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
      }
      if (cancel === 'tool') {
        f.tool('Add text box');
      }
      if (cancel === 'viewport') {
        f.viewports[0]!.width += 1;
        f.pointer(layer, 'pointerup', 250, 330);
        f.viewports[0]!.width -= 1;
      }
      assert.deepEqual(f.session.snapshot.strokes[0]!.points, points, cancel);
      assert(f.session.canRedoStroke, cancel);
      f.doc.querySelector<HTMLButtonElement>('#outside')!.focus();
      f.doc.defaultView!.dispatchEvent(new f.doc.defaultView!.Event('focus'));
      await f.session.saveWhenIdle();
      f.tool('Select');
    }
  } finally {
    f.dispose();
  }
});

test('snapped marker preview and saved PDF use the selected thickness as a minimum', async () => {
  for (const width of [8, 22]) {
    const f = await fixture();
    try {
      const pages = f.native.pages();
      pages[0]!.getTextWords = () => [
        { start: [50, 600], end: [150, 600], height: 18, order: 0 },
        { start: [50, 570], end: [150, 570], height: 18, order: 1 },
      ];
      f.native.pages = () => pages;
      f.editor.refresh();
      f.tool('Highlighter');
      f.doc.querySelector<HTMLButtonElement>('.pfs-properties-button')!.click();
      f.doc.querySelector<HTMLButtonElement>(`[aria-label="${width} point line"]`)!.click();
      f.doc.querySelector<HTMLButtonElement>('[aria-label="Snap to text"]')!.click();
      f.doc.querySelector<HTMLButtonElement>('[aria-label="Close tool settings"]')!.click();
      const layer = f.doc.querySelector<HTMLElement>('.pdf-form-studio-layer')!;
      f.pointer(layer, 'pointerdown', 60, 200);
      f.pointer(layer, 'pointermove', 140, 200);
      f.pointer(layer, 'pointermove', 140, 230);
      await pause(30);
      const previews = [
        ...f.doc.querySelectorAll<SVGPathElement>('.pdf-form-studio-stroke-preview'),
      ].filter((path) => path.hasAttribute('d'));
      assert.equal(previews.length, 2);
      assert(
        previews.every((path) => Number(path.getAttribute('stroke-width')) === Math.max(18, width)),
      );
      f.pointer(layer, 'pointerup', 60, 230);
      await f.session.saveWhenIdle();
      const snapshot = await readTextPdf(f.bytes());
      assert.equal(snapshot.strokes.length, 2);
      assert(snapshot.strokes.every((stroke) => stroke.width === Math.max(18, width)));
      const task = getDocument({ data: f.bytes().slice() });
      try {
        const page = await (await task.promise).getPage(1);
        const annotations = await page.getAnnotations();
        const ink = annotations.filter((annotation) => annotation.subtype === 'Ink');
        assert.equal(ink.length, 2);
        assert(
          ink.every(
            (annotation) =>
              annotation.hasAppearance && annotation.borderStyle.width === Math.max(18, width),
          ),
        );
      } finally {
        await task.destroy();
      }
      f.session.undoStroke();
      assert.equal(f.session.snapshot.strokes.length, 0);
      f.session.redoStroke();
      assert.equal(f.session.snapshot.strokes.length, 2);
      f.pointer(layer, 'pointerdown', 20, 500);
      f.pointer(layer, 'pointerup', 100, 500);
      assert.equal(
        f.session.snapshot.strokes[2]!.width,
        width,
        'freehand fallback keeps the chosen thickness',
      );
    } finally {
      f.dispose();
    }
  }
});
