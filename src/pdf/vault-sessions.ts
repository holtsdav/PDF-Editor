import { App, TFile } from 'obsidian';
import { TextSession } from './text-session';
import { RecoveryCopies, hash, isRecoveryPath } from './recovery';
import type { BackupKind, BackupRecord } from './recovery';
import type { PdfDraft } from './text-session';
import type { PdfFonts } from './text-format';
import { migrateRecovery } from './recovery-migration';

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }
function encode(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export class VaultSessions {
  private app: App;
  private font: PdfFonts;
  private sessions = new Map<string, Promise<TextSession>>();
  private backups: Record<string, BackupRecord>;
  private recovery: RecoveryCopies;
  private persist: () => Promise<void>;
  readonly root: string;

  constructor(app: App, font: PdfFonts, backups: Record<string, BackupRecord>, persist: () => Promise<void>) {
    this.app = app; this.font = font; this.backups = backups; this.persist = persist;
    this.root = `${app.vault.configDir}/plugins/pdf-form-studio/recovery`;
    const adapter = app.vault.adapter;
    this.recovery = new RecoveryCopies({
      read: async path => await adapter.exists(path) ? new Uint8Array(await adapter.readBinary(path)) : null,
      write: async (path, bytes) => { await this.ensureFolder(path.slice(0, path.lastIndexOf('/'))); await adapter.writeBinary(path, arrayBuffer(bytes)); }
    }, backups, persist, this.root);
  }

  async initialize(): Promise<void> {
    await this.ensureFolder(this.root);
    await migrateRecovery(this.app.vault.adapter, this.root, this.backups, this.persist);
  }

  get(file: TFile): Promise<TextSession> {
    if (isRecoveryPath(file.path, this.root)) return Promise.reject(new Error('Recovery copies are read only. Edit the original PDF instead.'));
    const existing = this.sessions.get(file.path); if (existing) return existing;
    const path = file.path;
    const promise = TextSession.open({
      read: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      write: bytes => this.app.vault.modifyBinary(file, arrayBuffer(bytes)),
      backup: (bytes, purpose) => this.recovery.protect(file.path, file.name, bytes, purpose),
      draft: {
        read: async () => this.readDraft(file.path),
        write: async draft => this.writeDraft(file.path, draft),
        clear: async () => { const base = await this.draftPath(file.path); for (const suffix of ['', '.previous']) if (await this.app.vault.adapter.exists(base + suffix)) await this.app.vault.adapter.remove(base + suffix); }
      }
    }, this.font).catch(error => { this.sessions.delete(path); throw error; });
    this.sessions.set(path, promise); return promise;
  }

  private async draftPath(path: string): Promise<string> {
    const id = await hash(new TextEncoder().encode(path)); return `${this.root}/drafts/${id}.json`;
  }
  private async readDraft(path: string): Promise<PdfDraft | null> {
    const base = await this.draftPath(path); const adapter = this.app.vault.adapter;
    let failure: unknown;
    for (const suffix of ['', '.previous']) {
      if (!await adapter.exists(base + suffix)) continue;
      try {
        const value: unknown = JSON.parse(await adapter.read(base + suffix));
        if (!value || typeof value !== 'object' || !('baselineHash' in value) || typeof value.baselineHash !== 'string'
          || !('pdf' in value) || typeof value.pdf !== 'string' || !('pdfHash' in value) || typeof value.pdfHash !== 'string') throw new Error('Invalid pending PDF draft.');
        const bytes = Uint8Array.from(atob(value.pdf), character => character.charCodeAt(0));
        if (await hash(bytes) !== value.pdfHash) throw new Error('The pending PDF draft failed verification.');
        return { bytes, baselineHash: value.baselineHash };
      } catch (error) { failure = error; }
    }
    if (failure) throw failure; return null;
  }
  private async writeDraft(path: string, draft: PdfDraft): Promise<void> {
    const base = await this.draftPath(path); const adapter = this.app.vault.adapter;
    await this.ensureFolder(base.slice(0, base.lastIndexOf('/')));
    const saved = JSON.stringify({ baselineHash: draft.baselineHash, pdfHash: await hash(draft.bytes), pdf: encode(draft.bytes) });
    // Retain the prior complete journal if a crash interrupts the next write.
    if (await adapter.exists(base)) {
      const prior = await this.readDraft(path);
      if (prior) {
        const previous = JSON.stringify({ baselineHash: prior.baselineHash, pdfHash: await hash(prior.bytes), pdf: encode(prior.bytes) });
        await adapter.write(base + '.previous', previous);
        if (await adapter.read(base + '.previous') !== previous) throw new Error('Pending PDF recovery verification failed.');
      }
    }
    await adapter.write(base, saved);
    if (await adapter.read(base) !== saved) throw new Error('Pending PDF recovery verification failed.');
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter; if (await adapter.exists(path)) return;
    const slash = path.lastIndexOf('/'); if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    try { await adapter.mkdir(path); } catch (error) { if (!await adapter.exists(path)) throw error; }
  }

  backupFor(file: TFile, kind: BackupKind = 'original'): string | undefined { return this.recovery.path(file.path, kind); }
  readRecovery(file: TFile, kind: BackupKind = 'original'): Promise<Uint8Array> { return this.recovery.read(file.path, kind); }
  async restore(file: TFile, kind: BackupKind = 'original'): Promise<void> { await (await this.get(file)).restore(await this.recovery.read(file.path, kind)); }
  async modified(file: TFile): Promise<void> { const session = this.sessions.get(file.path); if (session) await (await session).checkExternal(); }
  renamed(file: TFile, oldPath: string): void {
    const session = this.sessions.get(oldPath);
    if (session) { this.sessions.delete(oldPath); this.sessions.set(file.path, session); }
    if (this.backups[oldPath]) { this.backups[file.path] = this.backups[oldPath]; delete this.backups[oldPath]; void this.persist(); }
    void (async () => { const from = await this.draftPath(oldPath), to = await this.draftPath(file.path); for (const suffix of ['', '.previous']) if (await this.app.vault.adapter.exists(from + suffix)) await this.app.vault.adapter.rename(from + suffix, to + suffix); })().catch(() => {});
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(async value => (await value).save())); }
}
