import { App, TFile } from 'obsidian';
import { TextSession } from './text-session';
import { RecoveryCopies, isRecoveryPath } from './recovery';
import type { BackupKind, BackupRecord } from './recovery';

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }

export class VaultSessions {
  private app: App;
  private font: Uint8Array;
  private sessions = new Map<string, Promise<TextSession>>();
  private backups: Record<string, BackupRecord>;
  private recovery: RecoveryCopies;
  private persist: () => Promise<void>;

  constructor(app: App, font: Uint8Array, backups: Record<string, BackupRecord>, persist: () => Promise<void>) {
    this.app = app; this.font = font; this.backups = backups; this.persist = persist;
    this.recovery = new RecoveryCopies({
      read: async path => {
        const file = this.app.vault.getFileByPath(path);
        return file ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
      },
      write: async (path, bytes) => {
        await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
        const file = this.app.vault.getFileByPath(path);
        if (file) await this.app.vault.modifyBinary(file, arrayBuffer(bytes));
        else await this.app.vault.createBinary(path, arrayBuffer(bytes));
      }
    }, backups, persist);
  }

  get(file: TFile): Promise<TextSession> {
    if (isRecoveryPath(file.path)) return Promise.reject(new Error('Recovery copies are read only. Edit the original PDF instead.'));
    const existing = this.sessions.get(file.path);
    if (existing) return existing;
    const path = file.path;
    const promise = TextSession.open({
      read: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      write: bytes => this.app.vault.modifyBinary(file, arrayBuffer(bytes)),
      backup: (bytes, purpose) => this.recovery.protect(file.path, file.name, bytes, purpose)
    }, this.font).catch(error => { this.sessions.delete(path); throw error; });
    this.sessions.set(path, promise); return promise;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const slash = path.lastIndexOf('/');
    if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    try { await this.app.vault.createFolder(path); }
    catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
  }

  backupFor(file: TFile, kind: BackupKind = 'original'): TFile | null { return this.app.vault.getFileByPath(this.recovery.path(file.path, kind) ?? ''); }
  async restore(file: TFile, kind: BackupKind = 'original'): Promise<void> {
    const bytes = await this.recovery.read(file.path, kind);
    await (await this.get(file)).restore(bytes);
  }
  async modified(file: TFile): Promise<void> { const session = this.sessions.get(file.path); if (session) await (await session).checkExternal(); }
  renamed(file: TFile, oldPath: string): void {
    const session = this.sessions.get(oldPath);
    if (session) { this.sessions.delete(oldPath); this.sessions.set(file.path, session); }
    if (this.backups[oldPath]) { this.backups[file.path] = this.backups[oldPath]; delete this.backups[oldPath]; void this.persist(); }
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(async value => (await value).save())); }
}
