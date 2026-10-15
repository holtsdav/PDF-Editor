import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
  link,
  symlink,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { App } from 'obsidian';

const built = await build({
  stdin: {
    contents: `export {watchPdfImportCleanup} from './src/compat/pdf-import'; export {TFile, FileSystemAdapter} from 'obsidian';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'host',
      setup(b) {
        b.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
          args.namespace === 'test-fs'
            ? { path: args.path, external: true }
            : { path: 'fs', namespace: 'test-fs' },
        );
        b.onLoad({ filter: /.*/, namespace: 'test-fs' }, () => ({
          contents: `
    import * as fs from 'node:fs/promises';
    export const readFile=fs.readFile, realpath=fs.realpath;
    export async function lstat(path, options) {const stats=await fs.lstat(path, options); return globalThis.fixtureStat?.(path, options, stats) ?? stats;}
  `,
        }));
        b.onResolve({ filter: /^(obsidian|electron)$/ }, (args) => ({
          path: args.path,
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({
          contents:
            args.path === 'obsidian'
              ? `
    export class App {} export class TFile {constructor(path) {this.path=path;this.extension=path.endsWith('.pdf')?'pdf':'md';}}
    export class FileSystemAdapter {constructor(root){this.root=root;} getBasePath(){return this.root;}}
    export class Notice {constructor(message) {globalThis.fixtureNotice?.(message);}}
  `
              : `export const webUtils={getPathForFile(file){return file.path;}}; export const shell={trashItem(path){return globalThis.fixtureTrash(path);}};`,
        }));
      },
    },
  ],
});
const parent = new URL('../tmp/import-filesystem/', import.meta.url);
await mkdir(parent, { recursive: true });
const url = new URL('host.mjs', parent);
await writeFile(url, built.outputFiles[0]!.text);
const host = (await import(url.href)) as {
  watchPdfImportCleanup: (typeof import('../src/compat/pdf-import.ts'))['watchPdfImportCleanup'];
  TFile: new (path: string) => { path: string; extension: string };
  FileSystemAdapter: new (root: string) => unknown;
};
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(
  kind:
    | 'normal'
    | 'vault'
    | 'symlink'
    | 'hardlink'
    | 'recovery'
    | 'changed'
    | 'note-change'
    | 'large-identity'
    | 'metadata-race',
) {
  const root = await realpath(await mkdtemp(join(parent.pathname, 'case-')));
  const vault = join(root, 'vault');
  const external = join(root, 'external');
  const trash = join(root, 'trash');
  await Promise.all([mkdir(vault), mkdir(external), mkdir(trash)]);
  const source = join(kind === 'vault' ? vault : external, 'source.pdf');
  await writeFile(source, '%PDF-anonymous fixture');
  let dropped = source;
  if (kind === 'symlink') {
    dropped = join(external, 'linked.pdf');
    await symlink(source, dropped);
  }
  if (kind === 'hardlink') {
    await link(source, join(external, 'second.pdf'));
  }
  if (kind === 'recovery') {
    await mkdir(join(vault, '.obsidian/plugins/pdf-editor'), { recursive: true });
    await symlink(external, join(vault, '.obsidian/plugins/pdf-editor/recovery'), 'dir');
  }
  const metadata = await stat(dropped);
  const bytes = await readFile(dropped);
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  let listener: (...args: unknown[]) => void = () => {};
  let moved = 0;
  let text = '';
  let replaced = false;
  let sourceStats = 0;
  const notices: string[] = [];
  const file = new host.TFile('imported.pdf');
  const note = new host.TFile('note.md');
  const manager = {
    info: undefined as unknown,
    insertAttachmentEmbed(file: { path: string }) {
      void file;
      text += '![[imported.pdf]]';
    },
    async insertFiles(items: { data: Promise<ArrayBuffer> }[]) {
      const bytes = await items[0]!.data;
      const copy = await app.saveAttachment('source', 'pdf', bytes);
      manager.insertAttachmentEmbed(copy);
    },
  };
  const info = { file: note, sourceMode: { clipboardManager: manager } };
  manager.info = info;
  const app = {
    vault: {
      adapter: new host.FileSystemAdapter(vault),
      getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
      readBinary: async () => {
        const bytes = await readFile(join(vault, file.path));
        if (kind === 'note-change') {
          info.file = new host.TFile('other.md');
        }
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    },
    workspace: {
      on: (_name: string, callback: typeof listener) => {
        void _name;
        listener = callback;
        return {};
      },
      offref() {},
    },
    saveAttachment: async (_name: string, _ext: string, bytes: ArrayBuffer) => {
      void _name;
      void _ext;
      await writeFile(join(vault, file.path), new Uint8Array(bytes));
      if (kind === 'changed') {
        await writeFile(source, '%PDF-external change with different bytes');
      }
      if (kind === 'large-identity') {
        replaced = true;
      }
      return file;
    },
  };
  Object.assign(globalThis, {
    window: { setTimeout, clearTimeout },
    fixtureNotice: (message: string) => notices.push(message),
    fixtureStat: (path: string, options: { bigint?: boolean } | undefined, stats: object) => {
      if (kind === 'metadata-race' && path === source) {
        sourceStats++;
        // The verified read has a newer timestamp than the dropped OS File.
        // A redundant third stat returns the old timestamp, hiding that mismatch.
        if (sourceStats !== 3) {
          (stats as { mtimeNs: bigint }).mtimeNs += 2_000_000n;
        }
      }
      if (kind === 'large-identity' && path === source) {
        const inode = 9_007_199_254_740_992n + (replaced ? 1n : 0n);
        // These distinct identifiers collapse to the same Number. Keep real bytes and timestamps identical.
        Object.assign(stats, {
          dev: options?.bigint ? 9_007_199_254_740_993n : Number(9_007_199_254_740_993n),
          ino: options?.bigint ? inode : Number(inode),
        });
      }
      return stats;
    },
    fixtureTrash: async (path: string) => {
      await rename(path, join(trash, 'source.pdf'));
      moved++;
    },
  });
  const stop = host.watchPdfImportCleanup(app as unknown as App, () => true);
  try {
    listener(
      {
        defaultPrevented: false,
        dataTransfer: {
          files: [
            {
              name: 'source.pdf',
              path: dropped,
              size: bytes.length,
              lastModified: Math.floor(metadata.mtimeMs),
            },
          ],
        },
      },
      { getValue: () => text },
      info,
    );
    // Exact native descriptor promise and exact returned TFile, backed by real filesystem reads.
    await (manager.insertFiles as unknown as (items: object[]) => Promise<void>)([
      { filepath: dropped, extension: 'pdf', data: Promise.resolve(data) },
    ]);
    for (
      let i = 0;
      i < 60 &&
      !moved &&
      !notices.length &&
      (kind === 'normal' || kind === 'large-identity' || kind === 'metadata-race');
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let i = 0; i < 20; i++) {
      await pause();
    }
    assert.deepEqual(await readFile(join(vault, file.path)), bytes);
    if (kind === 'normal') {
      assert.equal(moved, 1);
      assert.deepEqual(await readFile(join(trash, 'source.pdf')), bytes);
    } else {
      assert.equal(moved, 0);
      assert((await stat(source)).isFile());
    }
    if (kind === 'metadata-race') {
      assert.equal(
        sourceStats,
        2,
        'metadata validation uses the exact verified read, without another stat',
      );
    }
  } finally {
    stop();
  }
}
test('verified native cleanup moves a regular external fixture only after the actual vault bytes match', () =>
  fixture('normal'));
test('vault, recovery, symbolic and hard-linked sources survive the actual filesystem cleanup guards', async () => {
  for (const kind of ['vault', 'symlink', 'hardlink', 'recovery'] as const) {
    await fixture(kind);
  }
});
test('an external change during native attachment creation keeps the real source file', () =>
  fixture('changed'));
test('a note change during attachment readback prevents the actual source from being moved', () =>
  fixture('note-change'));
test('large device and inode identities remain distinct when identical bytes replace the dropped source', () =>
  fixture('large-identity'));

test('OS File timestamps are checked against the verified source snapshot, without a later inconsistent stat', () =>
  fixture('metadata-race'));
