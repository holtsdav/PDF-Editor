import { hash } from './recovery.ts';
import type { PdfDraft } from './text-session.ts';

export interface JournalStore {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}
interface Entry { path: string; sequence: number; draft: PdfDraft }
function encode(bytes: Uint8Array): string {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Alternating slots: never rewrite the newest verified journal to make a backup. */
export class DraftJournal {
  private store: JournalStore;
  constructor(store: JournalStore) { this.store = store; }

  private async entries(base: string): Promise<Entry[]> {
    const entries: Entry[] = []; let failure: Error | undefined;
    for (const path of [base, base + '.previous']) {
      if (!await this.store.exists(path)) continue;
      try {
        const value: unknown = JSON.parse(await this.store.read(path));
        if (!value || typeof value !== 'object' || !('baselineHash' in value) || typeof value.baselineHash !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.baselineHash) || !('pdf' in value) || typeof value.pdf !== 'string'
          || !('pdfHash' in value) || typeof value.pdfHash !== 'string') throw new Error('Invalid pending PDF draft.');
        const sequence = 'sequence' in value ? value.sequence : 0;
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid pending PDF draft sequence.');
        const bytes = Uint8Array.from(atob(value.pdf), character => character.charCodeAt(0));
        if (await hash(bytes) !== value.pdfHash) throw new Error('The pending PDF draft failed verification.');
        entries.push({ path, sequence, draft: { bytes, baselineHash: value.baselineHash } });
      } catch (error) { failure = error instanceof Error ? error : new Error('Unable to read the pending PDF draft.', { cause: error }); }
    }
    if (!entries.length && failure) throw failure;
    return entries.sort((a, b) => b.sequence - a.sequence);
  }

  async read(base: string): Promise<PdfDraft | null> { return (await this.entries(base))[0]?.draft ?? null; }

  async write(base: string, source: string, draft: PdfDraft): Promise<void> {
    const latest = (await this.entries(base))[0];
    const target = latest?.path === base ? base + '.previous' : base;
    const sequence = (latest?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('The pending PDF draft sequence is exhausted.');
    const saved = JSON.stringify({ source, sequence, baselineHash: draft.baselineHash, pdfHash: await hash(draft.bytes), pdf: encode(draft.bytes) });
    await this.store.write(target, saved);
    if (await this.store.read(target) !== saved) throw new Error('Pending PDF recovery verification failed.');
  }

  async clear(base: string): Promise<void> {
    // Clear the older slot first so interruption cannot resurrect an old draft
    // after the latest committed draft has already been removed.
    const latest = (await this.entries(base).catch(() => []))[0]?.path;
    const paths = [base, base + '.previous'].sort((a, b) => Number(a === latest) - Number(b === latest));
    for (const path of paths) if (await this.store.exists(path)) await this.store.remove(path);
  }
}
