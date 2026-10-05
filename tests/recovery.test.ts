import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_ROOT, RecoveryCopies, loadBackups } from '../src/pdf/recovery.ts';
import type { BackupRecord, RecoveryStore } from '../src/pdf/recovery.ts';

function memory() {
  const files = new Map<string, Uint8Array>();
  const records: Record<string, BackupRecord> = {};
  let writes = 0; let indexes = 0;
  const store: RecoveryStore = {
    read: async path => files.get(path)?.slice() ?? null,
    write: async (path, bytes) => { files.set(path, bytes.slice()); writes++; }
  };
  const persist = async () => { indexes++; };
  return { files, records, store, persist, writes: () => writes, indexes: () => indexes };
}

test('app/session reloads retain one original instead of creating more copies', async () => {
  const memoryStore = memory(); const original = new Uint8Array([1, 2, 3]);
  for (let number = 0; number < 8; number++) {
    const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, memoryStore.persist);
    await copies.protect('Worksheet.pdf', 'Worksheet.pdf', number === 0 ? original : new Uint8Array([number, 4, 5]));
  }
  assert.equal(memoryStore.files.size, 1); assert.equal(memoryStore.writes(), 1);
  assert.deepEqual([...memoryStore.files.values()][0], original);
  assert([...memoryStore.files.keys()][0]?.includes('/Worksheet - '));
});

test('legacy index reuses the prior recovery file, without deleting older copies', async () => {
  const memoryStore = memory(); const path = `${BACKUP_ROOT}/old-id/Worksheet.pdf`;
  const older = `${BACKUP_ROOT}/older-id/Worksheet.pdf`;
  memoryStore.files.set(path, new Uint8Array([1, 2])); memoryStore.files.set(older, new Uint8Array([0, 1]));
  const records = loadBackups({ 'Worksheet.pdf': path, invalid: { original: 'Outside.pdf' } });
  const copies = new RecoveryCopies(memoryStore.store, records, memoryStore.persist);
  assert.equal(await copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([3, 4])), path);
  assert.equal(memoryStore.writes(), 0); assert.equal(memoryStore.files.size, 2);
  assert(records['Worksheet.pdf']?.originalHash); assert.equal(records.invalid, undefined);
});

test('repeated restores and reverse restores reuse one slot and preserve the original', async () => {
  const memoryStore = memory(); const original = new Uint8Array([1]); const edited = new Uint8Array([2]);
  const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, memoryStore.persist);
  await copies.protect('Worksheet.pdf', 'Worksheet.pdf', original);
  for (let number = 0; number < 6; number++) {
    await copies.protect('Worksheet.pdf', 'Worksheet.pdf', number % 2 === 0 ? edited : original, 'restore');
    assert.deepEqual(await copies.read('Worksheet.pdf', 'recovery'), number % 2 === 0 ? edited : original);
  }
  assert.equal(memoryStore.files.size, 2); assert.deepEqual(await copies.read('Worksheet.pdf'), original);
});

test('concurrent protection requests create just one verified original', async () => {
  const memoryStore = memory(); const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, memoryStore.persist);
  await Promise.all([1, 2, 3].map(number => copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([number]))));
  assert.equal(memoryStore.files.size, 1); assert.equal(memoryStore.writes(), 1);
  assert.deepEqual(await copies.read('Worksheet.pdf'), new Uint8Array([1]));
});

test('verification and index failures reject protection, and index persistence can retry', async () => {
  const memoryStore = memory(); let failIndex = true;
  const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, async () => {
    if (failIndex) throw new Error('Index unavailable'); await memoryStore.persist();
  });
  await assert.rejects(copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([1])), /Index unavailable/);
  failIndex = false; await copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([2]));
  assert.equal(memoryStore.files.size, 1); assert.equal(memoryStore.indexes(), 1);
  const brokenRecords: Record<string, BackupRecord> = {}; let corrupt = true;
  const broken = new RecoveryCopies({ ...memoryStore.store, write: async (path, bytes) => { memoryStore.files.set(path, corrupt ? new Uint8Array([99]) : bytes.slice()); } }, brokenRecords, memoryStore.persist);
  await assert.rejects(broken.protect('Other.pdf', 'Other.pdf', new Uint8Array([3])), /verification failed/);
  assert.equal(brokenRecords['Other.pdf'], undefined);
  corrupt = false; await broken.protect('Other.pdf', 'Other.pdf', new Uint8Array([3]));
  assert.deepEqual(await broken.read('Other.pdf'), new Uint8Array([3]));
});

test('tampered copies cannot be restored or silently reused before saving', async () => {
  const memoryStore = memory(); const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, memoryStore.persist);
  const path = await copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([1]));
  memoryStore.files.set(path, new Uint8Array([9]));
  await assert.rejects(copies.read('Worksheet.pdf'), /changed outside/);
  await assert.rejects(copies.protect('Worksheet.pdf', 'Worksheet.pdf', new Uint8Array([2])), /changed outside/);
  assert.deepEqual(memoryStore.files.get(path), new Uint8Array([9]));
});

test('recovery PDFs cannot recursively produce backups of backups', async () => {
  const memoryStore = memory(); const copies = new RecoveryCopies(memoryStore.store, memoryStore.records, memoryStore.persist);
  await assert.rejects(copies.protect(`${BACKUP_ROOT}/copy/Worksheet.pdf`, 'Worksheet.pdf', new Uint8Array([1])), /read only/);
  assert.equal(memoryStore.files.size, 0);
});
