import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { App, TFile } from 'obsidian';
import { VaultSessions } from '../src/pdf/vault-sessions.ts';
import { hash } from '../src/pdf/recovery.ts';
import type { BackupRecord } from '../src/pdf/recovery.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';

const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
async function vault() {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const field = pdf.getForm().createTextField('Answer'); field.setText('Original'); field.addToPage(pdf.getPages()[0]!);
  const files = new Map<string, Uint8Array>([['Folder/Worksheet.pdf', await pdf.save()]]), folders = new Set<string>();
  const file = { path: 'Folder/Worksheet.pdf', name: 'Worksheet.pdf', basename: 'Worksheet' } as TFile;
  const loaded = new Map<string, TFile>([[file.path, file]]);
  const encoder = new TextEncoder(), decoder = new TextDecoder(); let interrupted: string | undefined;
  let deletionFailure: 'before' | 'after' | undefined, persistenceFailure = false, corruptExport = false, exportDeleteFailure = false;
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => { if (!files.has(path)) throw new Error('Missing file'); return decoder.decode(files.get(path)); },
    write: async (path: string, text: string) => {
      if (path === interrupted || (interrupted === '*' && path.includes('/drafts/'))) { files.set(path, encoder.encode('{interrupted')); throw new Error('Interrupted journal write'); }
      files.set(path, encoder.encode(text));
    },
    readBinary: async (path: string) => { if (!files.has(path)) throw new Error('Missing file'); return files.get(path)!.slice().buffer; },
    writeBinary: async (path: string, bytes: ArrayBuffer) => { files.set(path, new Uint8Array(bytes).slice()); },
    mkdir: async (path: string) => { folders.add(path); }, remove: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => { if (files.has(to)) throw new Error('Destination exists'); files.set(to, files.get(from)!); files.delete(from); },
    stat: async (path: string) => files.has(path) ? { size: files.get(path)!.length } : null,
    list: async (path: string) => ({ files: [...files.keys()].filter(item => item.startsWith(path + '/') && !item.slice(path.length + 1).includes('/')),
      folders: [...folders].filter(item => item.startsWith(path + '/') && !item.slice(path.length + 1).includes('/')) }),
    rmdir: async (path: string) => { if (deletionFailure === 'before') throw new Error('Deletion failed');
      for (const name of files.keys()) if (name.startsWith(path + '/')) files.delete(name);
      for (const name of folders) if (name === path || name.startsWith(path + '/')) folders.delete(name);
      if (deletionFailure === 'after') throw new Error('Deletion failed after removing files'); }
  };
  const app = { vault: { configDir: '.obsidian', adapter, getAbstractFileByPath: (path: string) => loaded.get(path),
    readBinary: async (file: TFile) => {
      const bytes = new Uint8Array(await adapter.readBinary(file.path));
      return corruptExport && file.path.includes(' recovered ') ? bytes.slice(0, -1).buffer : bytes.buffer;
    }, modifyBinary: (file: TFile, bytes: ArrayBuffer) => adapter.writeBinary(file.path, bytes),
    createBinary: async (path: string, bytes: ArrayBuffer) => { if (files.has(path)) throw new Error('Already exists');
      const created = { path, name: path.split('/').at(-1)!, basename: path.split('/').at(-1)!.replace(/\.pdf$/i, '') } as TFile;
      await adapter.writeBinary(path, bytes); loaded.set(path, created); return created; },
    delete: async (file: TFile) => { if (exportDeleteFailure) throw new Error('Delete failed'); loaded.delete(file.path); files.delete(file.path); } } } as unknown as App;
  const records: Record<string, BackupRecord> = {};
  const create = () => new VaultSessions(app, font, records, async () => { if (persistenceFailure) throw new Error('Index write failed'); });
  const sessions = create(); await sessions.initialize();
  const draft = `${sessions.root}/drafts/${await hash(encoder.encode(file.path))}.json`;
  return { app, sessions, file, files, loaded, records, draft, create, interrupt: (path: string) => { interrupted = path; },
    failDeletion: (phase?: 'before' | 'after') => { deletionFailure = phase; }, failPersistence: (fail: boolean) => { persistenceFailure = fail; },
    corruptExports: (corrupt: boolean) => { corruptExport = corrupt; }, failExportDelete: (fail: boolean) => { exportDeleteFailure = fail; } };
}

test('a second interrupted journal write cannot destroy the only valid fallback', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'First durable draft'); await session.checkpoint();
  session.setValue('Answer', 'Second durable draft'); await session.checkpoint();
  // Simulate the newest slot being torn. The older verified slot must survive
  // another failed write during recovery.
  v.files.set(v.draft, new TextEncoder().encode('{broken'));
  const resumed = await v.create().get(v.file); assert.equal(resumed.dirty, true);
  const recovered = resumed.snapshot.fields[0]!.value;
  resumed.setValue('Answer', 'Retry interrupted again');
  v.interrupt('*');
  await resumed.checkpoint().catch(() => {});
  const reopened = await v.create().get(v.file);
  assert(['Retry interrupted again', recovered].includes(reopened.snapshot.fields[0]!.value));
});

test('renaming a parent folder keeps one document session and its original recovery mapping', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Saved before folder move'); await session.save();
  const backup = v.sessions.backupFor(v.file), old = v.file.path;
  v.file.path = 'Moved/Worksheet.pdf'; v.loaded.delete(old); v.loaded.set(v.file.path, v.file);
  v.files.set(v.file.path, v.files.get(old)!); v.files.delete(old);
  await v.sessions.renamed({ path: 'Moved' } as TFile, 'Folder');
  assert((await v.sessions.get(v.file)) === session, 'A folder move must retain the same writer');
  assert.equal(v.sessions.backupFor(v.file), backup);
});

test('a deleted and recreated path never reuses the obsolete TFile session or lets it overwrite the replacement', async () => {
  const v = await vault(), first = await v.sessions.get(v.file);
  first.setValue('Answer', 'Old pending answer');
  const replacement = { ...v.file } as TFile; v.loaded.set(replacement.path, replacement);
  const reopened = await v.sessions.get(replacement);
  assert(reopened !== first, 'A replacement file needs a new session');
  await assert.rejects(first.save(), /removed|replaced|longer/);
  assert.equal((await readTextPdf(v.files.get(v.file.path)!)).fields[0]!.value, 'Original');
});

test('a pending journal follows a file rename and recovers after restarting the registry', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Recover after renaming'); await session.checkpoint();
  const old = v.file.path; v.file.path = 'Folder/Renamed.pdf'; v.loaded.delete(old); v.loaded.set(v.file.path, v.file);
  v.files.set(v.file.path, v.files.get(old)!); v.files.delete(old);
  await v.sessions.renamed(v.file, old);
  const reopened = await v.create().get(v.file); assert.equal(reopened.snapshot.fields[0]!.value, 'Recover after renaming');
  assert.equal(reopened.status, 'unsaved');
});

test('the last closing view flushes and evicts clean sessions while other views and failed saves remain retained', async () => {
  const v = await vault(), releaseA = v.sessions.retain(v.file), releaseB = v.sessions.retain(v.file);
  const session = await v.sessions.get(v.file); session.setValue('Answer', 'Last close');
  await releaseA(); assert((await v.sessions.get(v.file)) === session);
  await releaseB(); const reopened = await v.sessions.get(v.file); assert(reopened !== session);
  assert.equal(reopened.snapshot.fields[0]!.value, 'Last close');
  const releaseFailed = v.sessions.retain(v.file); reopened.setValue('Answer', 'Unsupported 😀');
  await releaseFailed(); assert((await v.sessions.get(v.file)) === reopened); assert.equal(reopened.dirty, true);
});

test('a verified pending draft exports beside a damaged source without replacing it', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Recovered answer'); await session.checkpoint();
  const damaged = new Uint8Array([1, 2, 3]); v.files.set(v.file.path, damaged);
  const exported = await v.sessions.exportPendingDraft(v.file);
  assert.match(exported.path, /^Folder\/Worksheet recovered [a-f0-9]{8}\.pdf$/);
  assert.deepEqual(v.files.get(v.file.path), damaged);
  assert.equal((await readTextPdf(v.files.get(exported.path)!)).fields[0]!.value, 'Recovered answer');
  assert(v.files.has(v.draft), 'Export must retain the original recovery journal');
});

test('failed recovery export verification removes the unverified file and retains the draft', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Recovered answer'); await session.checkpoint();
  v.corruptExports(true);
  await assert.rejects(v.sessions.exportPendingDraft(v.file), /could not be verified and was removed/);
  assert(![...v.files.keys()].some(path => path.includes(' recovered ')));
  assert(v.files.has(v.draft));
  v.failExportDelete(true);
  await assert.rejects(v.sessions.exportPendingDraft(v.file), /unverified file.*could not be removed/);
  assert([...v.files.keys()].some(path => path.includes(' recovered ')), 'a failed cleanup reports the remaining artifact');
});

test('clearing recovery storage requires closed clean sessions and resets the backup index', async () => {
  const v = await vault(), release = v.sessions.retain(v.file), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Saved answer'); await session.save();
  await assert.rejects(v.sessions.clearRecoveryStorage(), /Close all/);
  await release();
  const before = await v.sessions.recoveryUsage();
  assert.equal(before.indexedPdfs, 1); assert(before.files > 0 && before.bytes > 0);
  await v.sessions.clearRecoveryStorage();
  const after = await v.sessions.recoveryUsage();
  assert.deepEqual(after, { files: 0, bytes: 0, indexedPdfs: 0 });
  const reopened = await v.sessions.get(v.file); reopened.setValue('Answer', 'Another answer'); await reopened.save();
  assert(v.sessions.backupFor(v.file), 'The next save must establish a new original copy');
});

test('interrupted backup deletion retains the index and cannot silently replace an original', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Saved answer'); await session.save();
  const original = v.sessions.backupFor(v.file)!;
  v.failDeletion('before');
  await assert.rejects(v.sessions.clearRecoveryStorage(), /Deletion failed/);
  assert.equal(v.sessions.backupFor(v.file), original);
  assert(v.files.has(original), 'a failed delete leaves the original reachable');
  v.failDeletion('after');
  await assert.rejects(v.sessions.clearRecoveryStorage(), /Deletion failed/);
  assert.equal(v.sessions.backupFor(v.file), original, 'even a partial delete cannot drop the original record');
  assert.equal(v.files.has(original), false);
  session.setValue('Answer', 'Later answer');
  await assert.rejects(session.save(), /original recovery copy was removed/);
  assert.equal((await readTextPdf(v.files.get(v.file.path)!)).fields[0]!.value, 'Saved answer');
});

test('an index-write failure after deleting backups blocks new saves until cleanup is retried', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Saved answer'); await session.save();
  const original = v.sessions.backupFor(v.file)!;
  v.failPersistence(true);
  await assert.rejects(v.sessions.clearRecoveryStorage(), /Index write failed/);
  assert.equal(v.sessions.backupFor(v.file), original);
  session.setValue('Answer', 'Later answer');
  await assert.rejects(session.save(), /original recovery copy was removed/);
});

test('turning original copies off skips new PDFs without removing existing copies', async () => {
  const v = await vault();
  await v.sessions.updatePreferences({ ...v.sessions.preferences, keepOriginalBackups: false });
  const session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Saved without an original'); await session.save();
  assert.equal(v.sessions.backupFor(v.file), undefined);
  assert.equal((await readTextPdf(v.files.get(v.file.path)!)).fields[0]!.value, 'Saved without an original');
  const beforeTurningOn = v.files.get(v.file.path)!.slice();
  await v.sessions.updatePreferences({ ...v.sessions.preferences, keepOriginalBackups: true });
  session.setValue('Answer', 'Saved after turning copies on'); await session.save();
  const original = v.sessions.backupFor(v.file);
  assert(original);
  assert.deepEqual(v.files.get(original), beforeTurningOn, 'The later copy is the PDF as it existed when backup creation resumed');
  await v.sessions.updatePreferences({ ...v.sessions.preferences, keepOriginalBackups: false });
  session.setValue('Answer', 'Saved while copies are off again'); await session.save();
  assert.equal(v.sessions.backupFor(v.file), original);
  assert.deepEqual(v.files.get(original), beforeTurningOn, 'Turning the switch off must not delete or replace an existing copy');
  await v.sessions.clearRecoveryStorage();
  assert.equal(v.sessions.backupFor(v.file), undefined);
  session.setValue('Answer', 'Saved after clearing while copies are off'); await session.save();
  assert.equal(v.sessions.backupFor(v.file), undefined, 'Clear deletes old copies; the off switch prevents replacing them');
});

test('pending edits prevent recovery cleanup even after their last view closes', async () => {
  const v = await vault(), session = await v.sessions.get(v.file);
  session.setValue('Answer', 'Pending answer'); await session.checkpoint();
  await assert.rejects(v.sessions.clearRecoveryStorage(), /pending PDF edits/);
  assert(v.files.has(v.draft));
  await assert.rejects(v.create().clearRecoveryStorage(), /Pending or leftover PDF drafts/);
  assert(v.files.has(v.draft));
});
