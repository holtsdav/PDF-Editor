import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { ToolPopover as Popover } from '../src/ui/tool-popover.ts';

const output = new URL('../tmp/ui-tests/styles/', import.meta.url);
await mkdir(output, { recursive: true });
const built = await build({ entryPoints: ['src/ui/overlay-label.ts', 'src/ui/tool-popover.ts'], bundle: true, write: false, outdir: 'out', format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'styles-host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'host', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
    export class Component {
      cleanups = []; register(fn) { this.cleanups.push(fn); }
      registerDomEvent(el, name, fn, options) { el.addEventListener(name, fn, options); this.register(() => el.removeEventListener(name, fn, options)); }
      unload() { this.cleanups.splice(0).reverse().forEach(fn => fn()); }
    }
    export const setIcon = () => {};
    export function setTooltip(el, text, options) { el.setAttribute('aria-label', text); el.setAttribute('data-tooltip-classes', options.classes.join(' ')); }
  ` }));
} }] });
for (const file of built.outputFiles) await writeFile(new URL(file.path.split('/').at(-1)!.replace('.js', '.mjs'), output), file.text);
const { labelOverlay, labelSvgOverlay } = await import(new URL('overlay-label.mjs', output).href) as typeof import('../src/ui/overlay-label.ts');
const { ToolPopover } = await import(new URL('tool-popover.mjs', output).href) as { ToolPopover: typeof Popover };
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

function fixture() {
  const dom = new JSDOM('<body><main class="pdf-form-studio-view pfs-surface"><div class="pfs-page"><div id="frame" class="pdf-form-studio-box"><textarea class="pdf-form-studio-field"></textarea></div></div></main></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const create = function(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const el = this.ownerDocument.createElement(tag); el.className = options.cls ?? ''; el.textContent = options.text ?? '';
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.append(el); return el;
  };
  Object.assign(dom.window.HTMLElement.prototype, { createEl: create,
    createDiv(this: HTMLElement, options: object) { return create.call(this, 'div', options); },
    createSpan(this: HTMLElement, options: object) { return create.call(this, 'span', options); }
  });
  const style = doc.createElement('style'); style.textContent = '.tooltip { display: block; } .pdf-form-studio-view textarea:focus { background: red; }\n' + css; doc.head.append(style);
  return { dom, doc, dispose: () => dom.window.close() };
}

test('overlay tooltip CSS leaves host and PDF toolbar tooltips visible in each window', () => {
  const main = fixture(), popout = fixture();
  try {
    for (const f of [main, popout]) {
      const button = f.doc.querySelector('#frame')!.createEl('button'); labelOverlay(button, 'Fill detected answer line');
      const overlay = f.doc.body.createDiv({ cls: 'tooltip ' + button.getAttribute('data-tooltip-classes') });
      const host = f.doc.body.createDiv({ cls: 'tooltip' }), toolbar = f.doc.body.createDiv({ cls: 'tooltip pdf-toolbar-tooltip' });
      assert.equal(f.dom.window.getComputedStyle(overlay).display, 'none');
      assert.equal(f.dom.window.getComputedStyle(host).display, 'block');
      assert.equal(f.dom.window.getComputedStyle(toolbar).display, 'block');
      assert.equal(css.includes('body:has('), false);
    }
  } finally { main.dispose(); popout.dispose(); }
});

test('accessible overlay names remain document-local and reuse a stable label on refresh', () => {
  const main = fixture(), popout = fixture();
  try {
    const input = popout.doc.querySelector<HTMLTextAreaElement>('textarea')!;
    labelOverlay(input, 'PDF answer'); const id = input.getAttribute('aria-labelledby')!;
    labelOverlay(input, 'Updated answer');
    assert.equal(input.getAttribute('aria-labelledby'), id);
    assert.equal(main.doc.getElementById(id), null);
    assert.equal(popout.doc.getElementById(id)?.textContent, 'Updated answer');
    assert.equal(input.hasAttribute('aria-label'), false); assert.equal(input.hasAttribute('title'), false);
    const svg = popout.doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    const remove = labelSvgOverlay(svg, input.parentElement!, 'Drawing on page 1');
    const svgId = svg.getAttribute('aria-labelledby')!; assert.equal(popout.doc.getElementById(svgId)?.textContent, 'Drawing on page 1');
    remove(); assert.equal(popout.doc.getElementById(svgId), null);
    input.focus(); assert.equal(popout.dom.window.getComputedStyle(input).backgroundColor, 'rgba(0, 0, 0, 0)');
  } finally { main.dispose(); popout.dispose(); }
});

test('a pop-out tool panel keeps the close callback receiver and disposes its portal', () => {
  const main = fixture(), popout = fixture(); let closed = 0;
  try {
    const anchor = popout.doc.body.createEl('button');
    const options = { title: 'Pen', color: [0, 0, 0] as [number, number, number], changeColor() {}, close() { assert.equal(this, options); closed++; } };
    const panel = new ToolPopover(anchor, options) as Popover & { unload(): void };
    assert.equal(panel.element.ownerDocument, popout.doc); assert.equal(main.doc.querySelector('.pfs-tool-popover'), null);
    panel.element.querySelector<HTMLButtonElement>('[aria-label="Close tool settings"]')!.click(); assert.equal(closed, 1);
    panel.unload(); assert.equal(panel.element.isConnected, false);
    popout.doc.body.dispatchEvent(new popout.dom.window.MouseEvent('pointerdown', { bubbles: true })); assert.equal(closed, 1);
  } finally { main.dispose(); popout.dispose(); }
});
