import { LEGACY_BACKUP_ROOT } from './recovery.ts';
import type { BackupRecord } from './recovery.ts';

export interface MigrationStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Receipt precedes the folder move, so an interrupted index write is recoverable. */
export async function migrateRecovery(store: MigrationStore, root: string, records: Record<string, BackupRecord>, persist: () => Promise<void>): Promise<void> {
  const receipt = `${root}/migration.json`;
  let target: string;
  if (await store.exists(receipt)) {
    const saved: unknown = JSON.parse(await store.read(receipt));
    if (!saved || typeof saved !== 'object' || !('target' in saved) || typeof saved.target !== 'string'
      || !saved.target.startsWith(root + '/legacy-') || saved.target.includes('..')) throw new Error('Invalid recovery migration receipt.');
    target = saved.target;
  } else {
    if (!await store.exists(LEGACY_BACKUP_ROOT)) return;
    target = `${root}/legacy-${globalThis.crypto.randomUUID()}`;
    await store.write(receipt, JSON.stringify({ target }));
  }
  if (!await store.exists(target)) {
    if (!await store.exists(LEGACY_BACKUP_ROOT)) throw new Error('The recovery folder was moved outside PDF Editor during migration.');
    await store.rename(LEGACY_BACKUP_ROOT, target);
  }
  for (const record of Object.values(records)) for (const kind of ['original', 'recovery'] as const) {
    if (record[kind]?.startsWith(LEGACY_BACKUP_ROOT + '/')) record[kind] = target + record[kind]!.slice(LEGACY_BACKUP_ROOT.length);
  }
  await persist(); await store.remove(receipt);
}
