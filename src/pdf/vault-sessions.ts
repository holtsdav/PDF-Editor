import { App, TFile, normalizePath } from 'obsidian';
import { TextSession } from './text-session';

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer as ArrayBuffer; }

export class VaultSessions {
  private app: App;
  private font: Uint8Array;
  private sessions = new Map<string, Promise<TextSession>>();
  private backups: Record<string, string>;
  private persist: () => Promise<void>;

  constructor(app: App, font: Uint8Array, backups: Record<string, string>, persist: () => Promise<void>) {
    this.app = app; this.font = font; this.backups = backups; this.persist = persist;
  }

  get(file: TFile): Promise<TextSession> {
    const existing = this.sessions.get(file.path);
    if (existing) return existing;
    const path = file.path;
    const promise = TextSession.open({
      read: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      write: bytes => this.app.vault.modifyBinary(file, arrayBuffer(bytes)),
      backup: bytes => this.backup(file, bytes)
    }, this.font).catch(error => { this.sessions.delete(path); throw error; });
    this.sessions.set(path, promise); return promise;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    try { await this.app.vault.createFolder(path); }
    catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
  }

  async backup(file: TFile, bytes: Uint8Array): Promise<string> {
    const root = 'PDF Form Studio Backups';
    await this.ensureFolder(root);
    const directory = `${root}/${globalThis.crypto.randomUUID()}`;
    await this.ensureFolder(directory);
    const path = normalizePath(`${directory}/${file.name}`);
    await this.app.vault.createBinary(path, arrayBuffer(bytes));
    const verified = new Uint8Array(await this.app.vault.readBinary(this.app.vault.getFileByPath(path)!));
    if (verified.length !== bytes.length || !verified.every((value, index) => value === bytes[index])) throw new Error('Recovery copy verification failed.');
    this.backups[file.path] = path;
    await this.persist(); return path;
  }

  backupFor(file: TFile): TFile | null { return this.app.vault.getFileByPath(this.backups[file.path] ?? ''); }
  async restore(file: TFile): Promise<void> {
    const backup = this.backupFor(file);
    if (!backup) throw new Error('No recovery copy is available for this PDF.');
    const bytes = new Uint8Array(await this.app.vault.readBinary(backup));
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
