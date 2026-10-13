import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import type { App, Editor, TFile, MarkdownView } from 'obsidian';

const built = await build({ stdin: { contents: `export { observeNativePdfImports } from './src/compat/native-import'; export { TFile } from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export class App {} export class TFile { constructor(path) { this.path = path; this.extension = 'pdf'; } }` }));
} }] });
await mkdir(new URL('../tmp/native-import/', import.meta.url), { recursive: true });
const url = new URL('../tmp/native-import/host.mjs', import.meta.url); await writeFile(url, built.outputFiles[0]!.text);
const module = await import(url.href) as { observeNativePdfImports: typeof import('../src/compat/native-import.ts')['observeNativePdfImports']; TFile: new (path: string) => TFile };
function fixture(options: { prepare?: () => Promise<string | null>; beforeSave?: () => Promise<void> } = {}) {
  let listener: (event: DragEvent, editor: Editor, info: MarkdownView) => void = () => {}, text = '', active = true, saved = 0, handled = 0;
  const cleanups: string[] = [], file = new module.TFile('Attachments/Imported.pdf'), note = new module.TFile('Note.md');
  const editor = { getValue: () => text } as Editor;
  const manager = { info: undefined as unknown, insertAttachmentEmbed: (file: TFile) => { text += '![[' + file.path + ']]'; handled++; },
    async insertFiles(items: { filepath: string; extension?: string; data: Promise<ArrayBuffer> }[]) { for (const item of items) { const bytes = await item.data; const result = await host.saveAttachment('Imported', 'pdf', bytes); manager.insertAttachmentEmbed(result); } }
  };
  const info = { file: note, sourceMode: { clipboardManager: manager } } as unknown as MarkdownView; manager.info = info;
  const host = { workspace: { on: (_event: string, fn: typeof listener) => { listener = fn; return {}; }, offref: () => { listener = () => {}; } },
    saveAttachment: async (_name: string, _extension: string, _bytes: ArrayBuffer) => { void _name; void _extension; void _bytes; saved++; await options.beforeSave?.(); return file; }
  };
  const original = { save: host.saveAttachment, insert: manager.insertFiles, embed: manager.insertAttachmentEmbed };
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  const stop = module.observeNativePdfImports(host as unknown as App, { enabled: () => active, path: () => '/anonymous/source.pdf', prepare: options.prepare ?? (async path => path),
    imported: async (source, actual, bytes) => { assert.equal(actual, file); assert.deepEqual(bytes, new Uint8Array([37, 80, 68, 70])); cleanups.push(source); }, skipped: () => {}, failed: error => { throw error; } });
  const drop = (prevented = false) => listener({ defaultPrevented: prevented, dataTransfer: { files: [{ name: 'source.pdf', size: 4 }] } } as unknown as DragEvent, editor, info);
  const insert = (bytes = new Uint8Array([37, 80, 68, 70])) => manager.insertFiles([{ filepath: '/anonymous/source.pdf', extension: 'pdf', data: Promise.resolve(bytes.buffer as ArrayBuffer) }]);
  return { host, manager, original, cleanups, drop, insert, stop, editor, info, file, saved: () => saved, handled: () => handled, disable: () => { active = false; } };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('native cleanup observes the exact buffer, returned attachment and successful embed without taking over import', async () => {
  const f = fixture(); try {
    f.drop(); await f.insert(); await flush(); assert.equal(f.saved(), 1); assert.equal(f.handled(), 1); assert.deepEqual(f.cleanups, ['/anonymous/source.pdf']);
    assert.equal(f.manager.insertFiles, f.original.insert); assert.equal(f.manager.insertAttachmentEmbed, f.original.embed);
  } finally { f.stop(); }
  assert.equal(f.host.saveAttachment, f.original.save);
});
test('cancelled and already-handled drops do not clean up and release temporary wrappers', async () => {
  const f = fixture(); try {
    f.drop(); await flush(); assert.equal(f.manager.insertFiles, f.original.insert); assert.deepEqual(f.cleanups, []);
    f.drop(true); await f.insert(); await flush(); assert.deepEqual(f.cleanups, []);
  } finally { f.stop(); }
});
test('unrelated attachments with equal bytes cannot be mistaken for the dropped source', async () => {
  const f = fixture(); try {
    f.drop(); await f.host.saveAttachment('Other', 'pdf', new Uint8Array([37, 80, 68, 70]).buffer); await flush();
    assert.deepEqual(f.cleanups, []);
  } finally { f.stop(); }
});
test('disabling or unloading during an import prevents cleanup and retains native behavior', async () => {
  for (const unload of [false, true]) {
    const f = fixture(); try {
      f.drop(); if (unload) f.stop(); else f.disable(); await f.insert(); await flush(); assert.equal(f.handled(), 1); assert.deepEqual(f.cleanups, []);
    } finally { f.stop(); }
  }
});

test('changing the target note before native import finishes keeps the source', async () => {
  const f = fixture(); try {
    f.drop(); f.info.file = new module.TFile('Other note.md'); await f.insert(); await flush();
    assert.equal(f.handled(), 1); assert.deepEqual(f.cleanups, []);
  } finally { f.stop(); }
});

test('overlapping drops into one note preserve native imports and restore every temporary wrapper', async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, count = 0;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; }), second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const f = fixture({ beforeSave: () => ++count === 1 ? first : second });
  try {
    f.drop(); const one = f.insert(); await flush();
    f.drop(); const two = f.insert(); await flush();
    releaseFirst(); await one; await flush(); releaseSecond(); await two; await flush();
    assert.equal(f.saved(), 2); assert.equal(f.handled(), 2);
    assert.equal(f.manager.insertFiles, f.original.insert);
    assert.equal(f.manager.insertAttachmentEmbed, f.original.embed);
    assert.equal(f.cleanups.length, 1, 'the overlapping ambiguous drop must keep its source');
  } finally { releaseFirst(); releaseSecond(); f.stop(); }
});

test('changing the target note after embed insertion but before source verification keeps the source', async () => {
  let release!: (source: string) => void;
  const prepared = new Promise<string>(resolve => { release = resolve; });
  const f = fixture({ prepare: () => prepared });
  try {
    f.drop(); await f.insert(); assert.equal(f.handled(), 1);
    f.info.file = new module.TFile('Other note.md'); release('/anonymous/source.pdf'); await flush();
    assert.deepEqual(f.cleanups, []);
  } finally { release('/anonymous/source.pdf'); f.stop(); }
});

test('native import failure retains its rejection, keeps the source and restores wrappers', async () => {
  const f = fixture({ beforeSave: async () => { throw new Error('Native attachment failure'); } });
  try {
    f.drop(); await assert.rejects(f.insert(), /Native attachment failure/); await flush();
    assert.equal(f.handled(), 0); assert.deepEqual(f.cleanups, []);
    assert.equal(f.manager.insertFiles, f.original.insert); assert.equal(f.manager.insertAttachmentEmbed, f.original.embed);
  } finally { f.stop(); }
});

test('a native buffer that no longer matches the dropped file size is imported without cleanup', async () => {
  const f = fixture();
  try {
    f.drop(); await f.insert(new Uint8Array([37, 80, 68, 70, 1])); await flush();
    assert.equal(f.saved(), 1); assert.equal(f.handled(), 1); assert.deepEqual(f.cleanups, []);
  } finally { f.stop(); }
});

test('duplicate filenames are associated by dropped paths and buffers and each batch file is verified independently', async () => {
  const paths = ['/anonymous/a/Same.pdf', '/anonymous/b/Same.pdf', '/anonymous/c/Same.pdf'];
  const items = paths.map((filepath, i) => ({ filepath, extension: 'pdf', name: 'Same', data: Promise.resolve(new Uint8Array([37, 80, 68, i]).buffer) }));
  const copies = new Map<TFile, ArrayBuffer>(), cleaned: string[] = []; let text = '', listener: (...args: unknown[]) => void = () => {};
  const note = new module.TFile('Note.md');
  const manager = { info: undefined as unknown, insertAttachmentEmbed(file: TFile) { text += `![[${file.path}]]`; },
    async insertFiles(items: { data: Promise<ArrayBuffer> }[]) {
      for (const item of items) { const bytes = await item.data; manager.insertAttachmentEmbed(await host.saveAttachment('Same', 'pdf', bytes)); }
    }
  };
  const info = { file: note, sourceMode: { clipboardManager: manager } }; manager.info = info;
  const host = { workspace: { on: (_name: string, callback: typeof listener) => { void _name; listener = callback; return {}; }, offref() {} },
    saveAttachment: async (_name: string, _extension: string, bytes: ArrayBuffer) => {
      void _name; void _extension; const file = new module.TFile(`Attachments/Same ${copies.size}.pdf`); copies.set(file, bytes); return file;
    }
  };
  const original = { insert: manager.insertFiles, embed: manager.insertAttachmentEmbed, save: host.saveAttachment };
  const stop = module.observeNativePdfImports(host as unknown as App, { enabled: () => true, path: file => (file as File & { path: string }).path,
    prepare: async path => path === paths[1] ? null : path,
    imported: async (path, file, bytes, current) => { assert(current()); assert.deepEqual(bytes, new Uint8Array(copies.get(file)!)); assert.equal(bytes[3], paths.indexOf(path)); cleaned.push(path); },
    skipped() {}, failed(error) { throw error; }
  });
  try {
    listener({ defaultPrevented: false, dataTransfer: { files: paths.map(path => ({ name: 'Same.pdf', path, size: 4 })) } }, { getValue: () => text }, info);
    await manager.insertFiles(items); await flush();
    assert.equal(copies.size, 3); assert.deepEqual(cleaned, [paths[0], paths[2]]);
    assert.equal(manager.insertFiles, original.insert); assert.equal(manager.insertAttachmentEmbed, original.embed);
  } finally { stop(); assert.equal(host.saveAttachment, original.save); }
});
