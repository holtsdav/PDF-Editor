import { equalBytes } from './text-session.ts';

export const BACKUP_ROOT = '.obsidian/plugins/pdf-form-studio/recovery';
export const LEGACY_BACKUP_ROOT = 'PDF Form Studio Backups';
export type BackupPurpose = 'edit' | 'restore';
export type BackupKind = 'original' | 'recovery';
export interface BackupRecord { original: string; originalHash?: string; recovery?: string; recoveryHash?: string }
export interface RecoveryStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export function isRecoveryPath(path: string, root = BACKUP_ROOT): boolean { return path.startsWith(root + '/') || path.startsWith(LEGACY_BACKUP_ROOT + '/'); }
function safeRecoveryPath(path: string, root: string): boolean {
  return isRecoveryPath(path, root) && !path.includes('\\') && !path.split('/').some(part => part === '.' || part === '..');
}
export function loadBackups(value: unknown, root = BACKUP_ROOT): Record<string, BackupRecord> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, BackupRecord> = Object.create(null) as Record<string, BackupRecord>;
  for (const [source, saved] of Object.entries(value)) {
    // 0.2.0 stored only the latest backup path. Reuse that file without copying it.
    if (typeof saved === 'string' && safeRecoveryPath(saved, root)) result[source] = { original: saved };
    else if (saved && typeof saved === 'object' && 'original' in saved && typeof saved.original === 'string' && safeRecoveryPath(saved.original, root)) {
      const record: BackupRecord = { original: saved.original };
      if ('originalHash' in saved && typeof saved.originalHash === 'string') record.originalHash = saved.originalHash;
      if ('recovery' in saved && typeof saved.recovery === 'string' && safeRecoveryPath(saved.recovery, root)) record.recovery = saved.recovery;
      if ('recoveryHash' in saved && typeof saved.recoveryHash === 'string') record.recoveryHash = saved.recoveryHash;
      result[source] = record;
    }
  }
  return result;
}

export async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

/** One retained original and two alternating restore slots, across app reloads. */
export class RecoveryCopies {
  private store: RecoveryStore;
  private records: Record<string, BackupRecord>;
  private persist: () => Promise<void>;
  private root: string;
  private queues = new Map<string, Promise<string>>();

  constructor(store: RecoveryStore, records: Record<string, BackupRecord>, persist: () => Promise<void>, root = BACKUP_ROOT) {
    this.store = store; this.records = records; this.persist = persist; this.root = root;
  }

  path(source: string, kind: BackupKind = 'original'): string | undefined { return this.records[source]?.[kind]; }

  async read(source: string, kind: BackupKind = 'original'): Promise<Uint8Array> {
    const record = this.records[source]; const path = record?.[kind];
    if (!record || !path) throw new Error('No recovery copy is available for this PDF.');
    const bytes = await this.store.read(path);
    if (!bytes) throw new Error('This recovery copy was moved or removed.');
    const expected = kind === 'original' ? record.originalHash : record.recoveryHash;
    if (expected && await hash(bytes) !== expected) throw new Error('The recovery copy changed outside PDF Form Studio. The PDF has not been replaced.');
    return bytes;
  }

  protect(source: string, name: string, bytes: Uint8Array, purpose: BackupPurpose = 'edit'): Promise<string> {
    if (isRecoveryPath(source, this.root)) return Promise.reject(new Error('Recovery copies are read only. Edit or restore the original PDF instead.'));
    const result = (this.queues.get(source) ?? Promise.resolve()).catch(() => '').then(() => this.performBackup(source, name, bytes, purpose));
    this.queues.set(source, result);
    void result.finally(() => { if (this.queues.get(source) === result) this.queues.delete(source); }).catch(() => {});
    return result;
  }

  private async writeVerified(path: string, bytes: Uint8Array): Promise<void> {
    await this.store.write(path, bytes);
    const verified = await this.store.read(path);
    if (!verified || !equalBytes(verified, bytes)) throw new Error('Recovery copy verification failed. The PDF has not been written.');
  }

  private async performBackup(source: string, name: string, bytes: Uint8Array, purpose: BackupPurpose): Promise<string> {
    let record = this.records[source];
    if (!record) {
      const label = name.replace(/\.pdf$/i, '');
      record = { original: `${this.root}/${label} - ${globalThis.crypto.randomUUID().slice(0, 8)}/original.pdf` };
      await this.writeVerified(record.original, bytes);
      record.originalHash = await hash(bytes);
      this.records[source] = record;
    } else {
      const existing = await this.store.read(record.original);
      if (!existing) {
        throw new Error('The original recovery copy was removed. Restore the missing copy before saving; it will not be replaced with a newer PDF.');
      } else {
        const actual = await hash(existing);
        if (record.originalHash && record.originalHash !== actual) throw new Error('The original recovery copy changed outside PDF Form Studio. Your pending text is kept; recover the backup before saving.');
        record.originalHash = actual;
      }
    }
    let path = record.original;
    const previousRecovery = record.recovery, previousHash = record.recoveryHash;
    if (purpose === 'restore') {
      const directory = record.original.slice(0, record.original.lastIndexOf('/'));
      const slots = ['before-restore.pdf', 'before-restore-next.pdf', 'before-restore-spare.pdf'].map(name => `${directory}/${name}`).filter(candidate => candidate !== record.original);
      path = slots.find(candidate => candidate !== record.recovery)!;
      await this.writeVerified(path, bytes);
      record.recovery = path; record.recoveryHash = await hash(bytes);
    }
    // Also retry failed index writes when reusing an already verified copy.
    try { await this.persist(); } catch (error) {
      record.recovery = previousRecovery; record.recoveryHash = previousHash; throw error;
    }
    return path;
  }
}
