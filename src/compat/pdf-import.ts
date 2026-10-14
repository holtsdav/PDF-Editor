import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { shell, webUtils } from 'electron';
import { FileSystemAdapter, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { observeNativePdfImports } from './native-import';
import { trashVerifiedImport } from '../pdf/import-cleanup';
import type { ImportSource } from '../pdf/import-cleanup';

/** External reads are restricted to actual OS drop handles; PDFs in the vault still use vault APIs. */
export function watchPdfImportCleanup(app: App, enabled: () => boolean, recoveryPath = `${app.vault.configDir ?? '.obsidian'}/plugins/pdf-editor/recovery`): () => void {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter) || typeof webUtils?.getPathForFile !== 'function' || typeof shell.trashItem !== 'function') return () => {};
  let closed = false;
  const processing = new Set<string>();
  const active = () => !closed && enabled();
  const source = async (path: string): Promise<(ImportSource & { mtimeNs: bigint }) | null> => {
    if (!active() || !isAbsolute(path) || !/\.pdf$/i.test(path)) return null;
    const [canonical, vault, recovery] = await Promise.all([realpath(path), realpath(adapter.getBasePath()),
      realpath(resolve(adapter.getBasePath(), recoveryPath)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })]);
    if (canonical !== resolve(path) || [vault, recovery].some(root => {
      if (!root) return false;
      const rel = relative(root, canonical); return !rel || (!rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    })) return null;
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 100_000_000n) return null;
    const bytes = new Uint8Array(await readFile(path)), after = await lstat(path, { bigint: true });
    const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
    if (identity(before) !== identity(after) || bytes.length !== Number(before.size) || !active()) return null;
    return { path: canonical, identity: identity(after), bytes, mtimeNs: after.mtimeNs };
  };
  const skipped = () => new Notice('PDF imported. Original cleanup was skipped because it could not be verified.');
  const stop = observeNativePdfImports(app, {
    enabled: active, path: file => webUtils.getPathForFile(file),
    prepare: async (path, file) => {
      const value = await source(path);
      // An OS File's metadata must still identify the dropped version.
      if (!value || file.size !== value.bytes.length) return null;
      if (!Number.isSafeInteger(file.lastModified)) return null;
      const delta = BigInt(file.lastModified) * 1_000_000n - value.mtimeNs;
      if (delta <= -1_000_000n || delta >= 1_000_000n) return null;
      return value;
    },
    imported: async (original, file, bytes, current) => {
      const key = JSON.stringify([original.path, original.identity]);
      if (processing.has(key)) return;
      processing.add(key);
      try {
        const removed = await trashVerifiedImport(original, bytes, {
          active: () => active() && current(), source,
          attachment: async () => {
            if (app.vault.getAbstractFileByPath(file.path) !== file || file.extension.toLowerCase() !== 'pdf') return null;
            const result = new Uint8Array(await app.vault.readBinary(file));
            return app.vault.getAbstractFileByPath(file.path) === file ? result : null;
          },
          trash: path => shell.trashItem(path)
        });
        if (!removed && active()) skipped();
      } finally { processing.delete(key); }
    }, skipped,
    failed: () => { if (active()) new Notice('PDF imported, but moving the original to Trash failed. Check the source folder and Trash.'); }
  });
  return () => { closed = true; stop(); };
}
