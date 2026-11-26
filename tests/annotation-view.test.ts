import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { TextSession } from '../src/pdf/text-session.ts';
import type * as ViewModule from '../src/ui/annotation-view.ts';

// Real view and export code; only Obsidian's host API is mocked (PDF.js is the real one).
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true });
const hostUrl = new URL('../tmp/ui-tests/obsidian-host.mjs', import.meta.url);
await writeFile(
  hostUrl,
  `
  import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
  export const notices = [];
  export class Notice { constructor(text) { notices.push(text); } }
  export class TFile {}
  export const loadPdfJs = async () => ({ getDocument });
  export const normalizePath = (path) => path.replace(/\\/+/g, '/');
  export function setIcon(el) { el.append(el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')); }
  export function setTooltip(el, text) { el.setAttribute('aria-label', text); }
  export class ItemView {
    constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = leaf.doc.createElement('div'); this.events = []; }
    registerEvent(ref) { this.events.push(ref); }
  }
`,
);
const built = await build({
  entryPoints: ['src/ui/annotation-view.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'host',
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({
          path: './obsidian-host.mjs',
          external: true,
        }));
      },
    },
  ],
});
const moduleUrl = new URL('../tmp/ui-tests/annotation-view.mjs', import.meta.url);
await writeFile(moduleUrl, built.outputFiles[0]!.text);
const view = (await import(moduleUrl.href)) as typeof ViewModule;
const host = (await import(hostUrl.href)) as { TFile: new () => object; notices: string[] };

const font = new Uint8Array(
  await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

async function fixture() {
  const pdf = await PDFDocument.create();
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage([400, 400])
    .drawText('Die Nullhypothese wird verworfen.', { x: 40, y: 340, size: 12, font: helvetica });
  pdf
    .addPage([400, 400])
    .drawText('Konfidenzintervall', { x: 40, y: 340, size: 12, font: helvetica });
  let bytes = await pdf.save();
  const session = await TextSession.open(
    {
      read: async () => bytes,
      write: async (value) => {
        bytes = value;
      },
      backup: async () => '',
    },
    font,
  );
  session.addMark({
    page: 1,
    kind: 'highlight',
    quads: [[40, 337, 135, 351]],
    color: [1, 0.85, 0.1],
    comment: 'Prüfung!',
  });
  session.addMark({
    page: 2,
    kind: 'highlight',
    quads: [[40, 337, 300, 351]],
    color: [0.45, 0.9, 0.45],
  });
  session.addMark({
    page: 2,
    kind: 'note',
    at: [300, 380],
    color: [1, 0.85, 0.1],
    comment: 'Frage',
  });
  await session.save();

  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  // The view schedules renders on the window, as in Obsidian.
  Object.assign(globalThis, { window: dom.window });
  // Obsidian's DOM helpers used by the view.
  const create = function (
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string } = {},
  ) {
    const el = doc.createElement(tag);
    if (options.cls) {
      el.className = options.cls;
    }
    if (options.text) {
      el.textContent = options.text;
    }
    this.append(el);
    return el;
  };
  Object.assign(dom.window.HTMLElement.prototype, {
    addClass(this: HTMLElement, cls: string) {
      this.classList.add(cls);
    },
    empty(this: HTMLElement) {
      this.replaceChildren();
    },
    createEl: create,
    createDiv(this: HTMLElement, options: object) {
      return create.call(this, 'div', options);
    },
  });
  const TFile = host.TFile;
  const makeFile = (path: string, extra: object = {}) =>
    Object.assign(new TFile(), {
      path,
      name: path.split('/').pop(),
      basename: path
        .split('/')
        .pop()!
        .replace(/\.[^.]+$/, ''),
      extension: path.split('.').pop(),
      parent: { path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/' },
      stat: { mtime: 1, size: bytes.length },
      ...extra,
    });
  const file = makeFile('Uni/Statistik.pdf');
  const notes = new Map<string, string>();
  const opened: string[] = [];
  const app = {
    vault: {
      readBinary: async () => bytes.slice().buffer,
      getAbstractFileByPath: (path: string) => (notes.has(path) ? makeFile(path) : null),
      process: async (note: { path: string }, change: (text: string) => string) => {
        notes.set(note.path, change(notes.get(note.path)!));
      },
      create: async (path: string, text: string) => {
        notes.set(path, text);
        return makeFile(path);
      },
      on: () => ({}),
    },
    metadataCache: { fileToLinktext: (target: { path: string }) => target.path },
    workspace: {
      getLeaf: () => ({ openFile: async (note: { path: string }) => void opened.push(note.path) }),
      getActiveFile: () => file,
      on: () => ({}),
    },
  };
  const sessions = { peek: () => undefined };
  return { app, file, notes, opened, doc, sessions, session };
}

test('exporting writes a note with the highlighted text, comments and page links, and refreshes it', async () => {
  const f = await fixture();
  await view.exportMarks(f.app as never, f.sessions as never, f.file as never);
  const note = f.notes.get('Uni/Statistik - Highlights.md')!;
  assert.ok(note.startsWith('# Highlights: Statistik\n'));
  assert.match(
    note,
    /- ==Die Nullhypothese== \[\[Uni\/Statistik\.pdf#page=1\|p\. 1\]\] #highlight\/yellow/,
  );
  assert.match(note, /\*\*Comment:\*\* Prüfung!/);
  assert.match(
    note,
    /- ==Konfidenzintervall== \[\[Uni\/Statistik\.pdf#page=2\|p\. 2\]\] #highlight\/green/,
  );
  assert.match(note, /- \*\*Note:\*\* Frage \[\[Uni\/Statistik\.pdf#page=2\|p\. 2\]\]/);
  assert.deepEqual(f.opened, ['Uni/Statistik - Highlights.md']);
  // User text around the block survives a second export.
  f.notes.set('Uni/Statistik - Highlights.md', `Meine Zusammenfassung\n\n${note}\nEnde`);
  await view.exportMarks(f.app as never, f.sessions as never, f.file as never);
  const again = f.notes.get('Uni/Statistik - Highlights.md')!;
  assert.ok(again.startsWith('Meine Zusammenfassung\n'));
  assert.ok(again.endsWith('Ende'));
  assert.equal(again.match(/<!-- pdf-editor:highlights -->/g)!.length, 1);
});

test('the sidebar lists highlights by page and jumps to the page on click', async () => {
  const f = await fixture();
  const revealed: number[] = [];
  const leaf = { app: f.app, doc: f.doc };
  const sidebar = new view.AnnotationView(leaf as never, {
    sessions: f.sessions as never,
    reveal: (_file, page) => revealed.push(page),
  });
  await sidebar.onOpen();
  const root = (sidebar as unknown as { contentEl: HTMLElement }).contentEl;
  for (let i = 0; i < 100 && !root.querySelector('.pfs-annotation'); i++) {
    await pause(10);
  }
  assert.deepEqual(
    [...root.querySelectorAll('.pfs-annotations-page')].map((el) => el.textContent),
    ['Page 1', 'Page 2'],
  );
  const items = [...root.querySelectorAll<HTMLButtonElement>('.pfs-annotation')];
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['Die NullhypothesePrüfung!', 'NoteFrage', 'Konfidenzintervall'],
  );
  items[2]!.click();
  assert.deepEqual(revealed, [2]);
  await sidebar.onClose();
});
