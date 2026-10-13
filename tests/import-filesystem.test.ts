import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, link, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { App } from 'obsidian';

const built = await build({ stdin: { contents: `export {watchPdfImportCleanup} from './src/compat/pdf-import'; export {TFile, FileSystemAdapter} from 'obsidian';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'host', setup(b) {
  b.onResolve({ filter: /^(obsidian|electron)$/ }, args => ({ path: args.path, namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'obsidian' ? `
    export class App {} export class TFile {constructor(path) {this.path=path;this.extension=path.endsWith('.pdf')?'pdf':'md';}}
    export class FileSystemAdapter {constructor(root){this.root=root;} getBasePath(){return this.root;}}
    export class Notice {constructor(message) {}}
  ` : `export const webUtils={getPathForFile(file){return file.path;}}; export const shell={trashItem(path){return globalThis.fixtureTrash(path);}};` }));
} }] });
const parent = new URL('../tmp/import-filesystem/', import.meta.url); await mkdir(parent, { recursive: true });
const url = new URL('host.mjs', parent); await writeFile(url, built.outputFiles[0]!.text);
const host = await import(url.href) as { watchPdfImportCleanup: typeof import('../src/compat/pdf-import.ts')['watchPdfImportCleanup']; TFile: new (path: string) => { path: string; extension: string }; FileSystemAdapter: new (root: string) => unknown };
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(kind: 'normal' | 'vault' | 'symlink' | 'hardlink' | 'recovery' | 'changed' | 'note-change') {
  const root = await realpath(await mkdtemp(join(parent.pathname, 'case-'))), vault = join(root, 'vault'), external = join(root, 'external'), trash = join(root, 'trash');
  await Promise.all([mkdir(vault), mkdir(external), mkdir(trash)]);
  const source = join(kind === 'vault' ? vault : external, 'source.pdf'); await writeFile(source, '%PDF-anonymous fixture');
  let dropped = source;
  if (kind === 'symlink') { dropped = join(external, 'linked.pdf'); await symlink(source, dropped); }
  if (kind === 'hardlink') await link(source, join(external, 'second.pdf'));
  if (kind === 'recovery') {
    await mkdir(join(vault, '.obsidian/plugins/pdf-editor'), { recursive: true });
    await symlink(external, join(vault, '.obsidian/plugins/pdf-editor/recovery'), 'dir');
  }
  const metadata = await stat(dropped), bytes = await readFile(dropped), data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let listener: (...args: unknown[]) => void = () => {}, moved = 0, text = '';
  const file = new host.TFile('imported.pdf'), note = new host.TFile('note.md');
  const manager = { info: undefined as unknown, insertAttachmentEmbed(file: { path: string }) { void file; text += '![[imported.pdf]]'; }, async insertFiles(items: { data: Promise<ArrayBuffer> }[]) {
    const bytes = await items[0]!.data;
    const copy = await app.saveAttachment('source', 'pdf', bytes); manager.insertAttachmentEmbed(copy);
  } };
  const info = { file: note, sourceMode: { clipboardManager: manager } }; manager.info = info;
  const app = { vault: { adapter: new host.FileSystemAdapter(vault), getAbstractFileByPath: (path: string) => path === file.path ? file : null,
    readBinary: async () => { const bytes = await readFile(join(vault, file.path)); if (kind === 'note-change') info.file = new host.TFile('other.md'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } },
    workspace: { on: (_name: string, callback: typeof listener) => { void _name; listener = callback; return {}; }, offref() {} },
    saveAttachment: async (_name: string, _ext: string, bytes: ArrayBuffer) => {
      void _name; void _ext; await writeFile(join(vault, file.path), new Uint8Array(bytes));
      if (kind === 'changed') await writeFile(source, '%PDF-external change with different bytes');
      return file;
    }
  };
  Object.assign(globalThis, { window: { setTimeout, clearTimeout }, fixtureTrash: async (path: string) => { await rename(path, join(trash, 'source.pdf')); moved++; } });
  const stop = host.watchPdfImportCleanup(app as unknown as App, () => true);
  try {
    listener({ defaultPrevented: false, dataTransfer: { files: [{ name: 'source.pdf', path: dropped, size: bytes.length, lastModified: Math.floor(metadata.mtimeMs) }] } }, { getValue: () => text }, info);
    // Exact native descriptor promise and exact returned TFile, backed by real filesystem reads.
    await (manager.insertFiles as unknown as (items: object[]) => Promise<void>)([{ filepath: dropped, extension: 'pdf', data: Promise.resolve(data) }]);
    for (let i = 0; i < 60 && !moved && kind === 'normal'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 0; i < 20; i++) await pause();
    assert.deepEqual(await readFile(join(vault, file.path)), bytes);
    if (kind === 'normal') { assert.equal(moved, 1); assert.deepEqual(await readFile(join(trash, 'source.pdf')), bytes); }
    else { assert.equal(moved, 0); assert((await stat(source)).isFile()); }
  } finally { stop(); }
}
test('verified native cleanup moves a regular external fixture only after the actual vault bytes match', () => fixture('normal'));
test('vault, recovery, symbolic and hard-linked sources survive the actual filesystem cleanup guards', async () => {
  for (const kind of ['vault', 'symlink', 'hardlink', 'recovery'] as const) await fixture(kind);
});
test('an external change during native attachment creation keeps the real source file', () => fixture('changed'));
test('a note change during attachment readback prevents the actual source from being moved', () => fixture('note-change'));
