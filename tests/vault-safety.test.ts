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
  const file = { path: 'Folder/Worksheet.pdf', name: 'Worksheet.pdf' } as TFile;
  const loaded = new Map<string, TFile>([[file.path, file]]);
  const encoder = new TextEncoder(), decoder = new TextDecoder(); let interrupted: string | undefined;
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
    rename: async (from: string, to: string) => { if (files.has(to)) throw new Error('Destination exists'); files.set(to, files.get(from)!); files.delete(from); }
  };
  const app = { vault: { configDir: '.obsidian', adapter, getAbstractFileByPath: (path: string) => loaded.get(path),
    readBinary: (file: TFile) => adapter.readBinary(file.path), modifyBinary: (file: TFile, bytes: ArrayBuffer) => adapter.writeBinary(file.path, bytes) } } as unknown as App;
  const records: Record<string, BackupRecord> = {};
  const create = () => new VaultSessions(app, font, records, async () => {});
  const sessions = create(); await sessions.initialize();
  const draft = `${sessions.root}/drafts/${await hash(encoder.encode(file.path))}.json`;
  return { app, sessions, file, files, loaded, records, draft, create, interrupt: (path: string) => { interrupted = path; } };
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
