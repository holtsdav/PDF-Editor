import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import type { App, Editor, TFile, MarkdownView } from 'obsidian';

const built = await build({ stdin: { contents: `export { observeNativePdfImports } from './src/compat/native-pdf'; export { TFile } from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'host', setup(builder) {
  builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export class App {} export class TFile { constructor(path) { this.path = path; this.extension = 'pdf'; } }` }));
} }] });
await mkdir(new URL('../tmp/native-import/', import.meta.url), { recursive: true });
const url = new URL('../tmp/native-import/host.mjs', import.meta.url); await writeFile(url, built.outputFiles[0]!.text);
const module = await import(url.href) as { observeNativePdfImports: typeof import('../src/compat/native-pdf.ts')['observeNativePdfImports']; TFile: new (path: string) => TFile };
function fixture() {
  let listener: (event: DragEvent, editor: Editor, info: MarkdownView) => void = () => {}, text = '', active = true, saved = 0, handled = 0;
  const cleanups: string[] = [], file = new module.TFile('Attachments/Imported.pdf'), note = new module.TFile('Note.md');
  const editor = { getValue: () => text } as Editor;
  const manager = { info: undefined as unknown, insertAttachmentEmbed: (file: TFile) => { text += '![[' + file.path + ']]'; handled++; },
    async insertFiles(items: { filepath: string; extension?: string; data: Promise<ArrayBuffer> }[]) { for (const item of items) { const bytes = await item.data; const result = await host.saveAttachment('Imported', 'pdf', bytes); manager.insertAttachmentEmbed(result); } }
  };
  const info = { file: note, sourceMode: { clipboardManager: manager } } as unknown as MarkdownView; manager.info = info;
  const host = { workspace: { on: (_event: string, fn: typeof listener) => { listener = fn; return {}; }, offref: () => { listener = () => {}; } },
    saveAttachment: async (_name: string, _extension: string, _bytes: ArrayBuffer) => { void _name; void _extension; void _bytes; saved++; return file; }
  };
  const original = { save: host.saveAttachment, insert: manager.insertFiles, embed: manager.insertAttachmentEmbed };
  Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
  const stop = module.observeNativePdfImports(host as unknown as App, { enabled: () => active, path: () => '/anonymous/source.pdf', prepare: async path => path,
    imported: async (source, actual, bytes) => { assert.equal(actual, file); assert.deepEqual(bytes, new Uint8Array([37, 80, 68, 70])); cleanups.push(source); }, skipped: () => {}, failed: error => { throw error; } });
  const drop = (prevented = false) => listener({ defaultPrevented: prevented, dataTransfer: { files: [{ name: 'source.pdf', size: 4 }] } } as unknown as DragEvent, editor, info);
  const insert = () => manager.insertFiles([{ filepath: '/anonymous/source.pdf', extension: 'pdf', data: Promise.resolve(new Uint8Array([37, 80, 68, 70]).buffer) }]);
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
