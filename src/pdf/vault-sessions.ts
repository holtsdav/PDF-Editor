import type { App, TAbstractFile, TFile } from 'obsidian';
import { TextSession, equalBytes } from './text-session.ts';
import { RecoveryCopies, hash, isRecoveryPath } from './recovery.ts';
import type { BackupKind, BackupRecord } from './recovery';
import type { PdfDraft } from './text-session';
import type { PdfFonts } from './text-format';
import { loadToolPreferences } from './tool-preferences.ts';
import type { ToolPreferences } from './tool-preferences';
import { migrateRecovery } from './recovery-migration.ts';
import { DraftJournal } from './draft-journal.ts';

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
export interface RecoveryUsage { files: number; bytes: number; indexedPdfs: number }

export class VaultSessions {
  private app: App;
  private font: PdfFonts;
  private sessions = new Map<TFile, Promise<TextSession>>();
  private views = new Map<TFile, number>();
  private storageQueue: Promise<unknown> = Promise.resolve();
  private journal: DraftJournal;
  private backups: Record<string, BackupRecord>;
  private recovery: RecoveryCopies;
  private persist: () => Promise<void>;
  private preferenceListeners = new Set<() => void>();
  readonly root: string;
  readonly preferences: ToolPreferences;

  constructor(app: App, font: PdfFonts, backups: Record<string, BackupRecord>, persist: () => Promise<void>, preferences: ToolPreferences = loadToolPreferences(null)) {
    this.preferences = preferences;
    this.app = app; this.font = font; this.backups = backups; this.persist = persist;
    this.root = `${app.vault.configDir}/plugins/pdf-form-studio/recovery`;
    const adapter = app.vault.adapter;
    this.journal = new DraftJournal(adapter);
    this.recovery = new RecoveryCopies({
      read: async path => await adapter.exists(path) ? new Uint8Array(await adapter.readBinary(path)) : null,
      write: async (path, bytes) => { await this.ensureFolder(path.slice(0, path.lastIndexOf('/'))); await adapter.writeBinary(path, arrayBuffer(bytes)); }
    }, backups, persist, this.root);
  }

  async updatePreferences(value: ToolPreferences): Promise<void> {
    Object.assign(this.preferences, loadToolPreferences(value));
    await this.persist();
    for (const listener of this.preferenceListeners) listener();
  }
  subscribePreferences(listener: () => void): () => void {
    this.preferenceListeners.add(listener);
    return () => this.preferenceListeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.ensureFolder(this.root);
    await migrateRecovery(this.app.vault.adapter, this.root, this.backups, this.persist);
  }

  /** Release clean document/font/undo state once its last surface closes. */
  retain(file: TFile): () => Promise<void> {
    this.views.set(file, (this.views.get(file) ?? 0) + 1); let released = false;
    return async () => {
      if (released) return; released = true;
      const count = (this.views.get(file) ?? 1) - 1;
      if (count) { this.views.set(file, count); return; }
      this.views.delete(file);
      const pending = this.sessions.get(file); if (!pending) return;
      try {
        const session = await pending;
        await session.checkpoint(); await session.save();
        if (!this.views.has(file) && !session.dirty && session.status === 'saved' && this.sessions.get(file) === pending) this.sessions.delete(file);
      } catch { /* Keep failed or conflicted sessions available for recovery. */ }
    };
  }

  get(file: TFile): Promise<TextSession> {
    if (isRecoveryPath(file.path, this.root)) return Promise.reject(new Error('Recovery copies are read only. Edit the original PDF instead.'));
    const existing = this.sessions.get(file); if (existing) return existing;
    const requireCurrent = () => {
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('This PDF was removed or replaced. Reopen the current file before saving.');
    };
    const promise = TextSession.open({
      read: async () => { requireCurrent(); return new Uint8Array(await this.app.vault.readBinary(file)); },
      write: bytes => { requireCurrent(); return this.app.vault.modifyBinary(file, arrayBuffer(bytes)); },
      backup: (bytes, purpose) => { requireCurrent(); const path = file.path, name = file.name; return this.storage(() => {
        // The opt-out applies only to PDFs without an existing original. Keep
        // checking retained originals, and always protect a restore operation.
        if (purpose !== 'restore' && !this.preferences.keepOriginalBackups && !this.backups[path]) return Promise.resolve('');
        return this.recovery.protect(path, name, bytes, purpose);
      }); },
      draft: {
        read: () => { const path = file.path; return this.storage(async () => this.journal.read(await this.draftPath(path))); },
        write: draft => { requireCurrent(); const path = file.path; return this.storage(() => this.writeDraft(path, draft)); },
        clear: () => { requireCurrent(); const path = file.path; return this.storage(async () => this.journal.clear(await this.draftPath(path))); }
      }
    }, this.font).catch(error => { this.sessions.delete(file); throw error; });
    this.sessions.set(file, promise); return promise;
  }

  private storage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.catch(() => {}).then(operation); this.storageQueue = result; return result;
  }

  private async draftPath(path: string): Promise<string> {
    const id = await hash(new TextEncoder().encode(path)); return `${this.root}/drafts/${id}.json`;
  }
  private async writeDraft(path: string, draft: PdfDraft): Promise<void> {
    const base = await this.draftPath(path);
    await this.ensureFolder(base.slice(0, base.lastIndexOf('/')));
    await this.journal.write(base, path, draft);
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter; if (await adapter.exists(path)) return;
    const slash = path.lastIndexOf('/'); if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    try { await adapter.mkdir(path); } catch (error) { if (!await adapter.exists(path)) throw error; }
  }

  async recoveryDetails(file: TFile): Promise<{ label: string; size: number; kind?: BackupKind }[]> {
    const draft = await this.draftPath(file.path);
    const paths: { label: string; path?: string; kind?: BackupKind }[] = [
      { label: 'Original PDF', path: this.backupFor(file), kind: 'original' },
      { label: 'Before restore', path: this.backupFor(file, 'recovery'), kind: 'recovery' },
      { label: 'Pending draft', path: draft }, { label: 'Previous draft', path: draft + '.previous' }
    ];
    const items = await Promise.all(paths.map(async item => {
      const stat = item.path ? await this.app.vault.adapter.stat(item.path) : null;
      return stat ? { label: item.label, size: stat.size, kind: item.kind } : null;
    }));
    return items.filter(item => item !== null);
  }

  async recoveryUsage(): Promise<RecoveryUsage> {
    return this.storage(async () => {
      const adapter = this.app.vault.adapter;
      const usage: RecoveryUsage = { files: 0, bytes: 0, indexedPdfs: Object.keys(this.backups).length };
      const pending = [this.root];
      while (pending.length) {
        const folder = pending.pop()!;
        if (!await adapter.exists(folder)) continue;
        const listing = await adapter.list(folder);
        pending.push(...listing.folders);
        for (const path of listing.files) {
          const stat = await adapter.stat(path);
          if (stat) { usage.files++; usage.bytes += stat.size; }
        }
      }
      return usage;
    });
  }

  /** Export a verified journal without requiring the source PDF to parse or be replaced. */
  async exportPendingDraft(file: TFile): Promise<TFile> {
    const draft = await this.storage(async () => this.journal.read(await this.draftPath(file.path)));
    if (!draft) throw new Error('No pending recovery draft exists for this PDF.');
    const folder = file.path.slice(0, file.path.lastIndexOf('/') + 1);
    let path: string;
    do { path = `${folder}${file.basename} recovered ${globalThis.crypto.randomUUID().slice(0, 8)}.pdf`; }
    while (this.app.vault.getAbstractFileByPath(path));
    const created = await this.app.vault.createBinary(path, arrayBuffer(draft.bytes));
    if (!equalBytes(new Uint8Array(await this.app.vault.readBinary(created)), draft.bytes)) {
      throw new Error(`The exported PDF could not be verified at ${path}. The recovery draft was retained.`);
    }
    return created;
  }

  /** Explicit reset only: preserve pending work and never silently expire originals. */
  async clearRecoveryStorage(): Promise<void> {
    if (this.views.size) throw new Error('Close all PDF Editor views before clearing recovery storage.');
    const sessions = await Promise.all([...this.sessions.values()]);
    if (sessions.some(session => session.dirty || session.status !== 'saved')) {
      throw new Error('Save or resolve all pending PDF edits before clearing recovery storage.');
    }
    await this.storage(async () => {
      if (this.views.size) throw new Error('A PDF Editor view opened. Close it before clearing recovery storage.');
      const drafts = `${this.root}/drafts`;
      if (await this.app.vault.adapter.exists(drafts) && (await this.app.vault.adapter.list(drafts)).files.length) {
        throw new Error('Pending or leftover PDF drafts exist. Open or export those PDFs and reach Saved before clearing recovery storage.');
      }
      const previous = Object.entries(this.backups);
      for (const key of Object.keys(this.backups)) delete this.backups[key];
      try { await this.persist(); }
      catch (error) { for (const [key, record] of previous) this.backups[key] = record; throw error; }
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.root)) await adapter.rmdir(this.root, true);
      await this.ensureFolder(this.root);
    });
  }

  backupFor(file: TFile, kind: BackupKind = 'original'): string | undefined { return this.recovery.path(file.path, kind); }
  readRecovery(file: TFile, kind: BackupKind = 'original'): Promise<Uint8Array> { return this.recovery.read(file.path, kind); }
  async restore(file: TFile, kind: BackupKind = 'original'): Promise<void> { await (await this.get(file)).restore(await this.recovery.read(file.path, kind)); }
  async modified(file: TFile): Promise<void> { const session = this.sessions.get(file); if (session) await (await session).checkExternal(); }
  renamed(file: TAbstractFile, oldPath: string): Promise<void> {
    const newPath = file.path;
    return this.storage(async () => {
      const sources = new Set([oldPath, ...Object.keys(this.backups).filter(path => path.startsWith(oldPath + '/'))]);
      for (const current of this.sessions.keys()) if (current.path.startsWith(newPath + '/')) sources.add(oldPath + current.path.slice(newPath.length));
      for (const source of sources) {
        const target = newPath + source.slice(oldPath.length);
        const from = await this.draftPath(source), to = await this.draftPath(target);
        for (const suffix of ['', '.previous']) if (await this.app.vault.adapter.exists(from + suffix)) {
          // A colliding journal is never overwritten silently.
          if (await this.app.vault.adapter.exists(to + suffix)) throw new Error('A recovery draft already exists at the renamed PDF path. Both drafts have been retained.');
          await this.app.vault.adapter.rename(from + suffix, to + suffix);
        }
        if (this.backups[source]) { this.backups[target] = this.backups[source]; delete this.backups[source]; }
      }
      await this.persist();
    });
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(async value => (await value).save())); }
}
