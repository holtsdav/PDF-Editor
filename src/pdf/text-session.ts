import { FIELD_PREFIX, readTextPdf, writeTextPdf } from './text-engine.ts';
import type { AddedField, Rect, TextChanges, TextField, TextSnapshot } from './text-engine.ts';

export interface PdfStore {
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  backup(bytes: Uint8Array): Promise<string>;
}
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** One session per vault PDF; every view shares its model and serialized writer. */
export class TextSession {
  snapshot: TextSnapshot;
  status: SaveStatus = 'saved';
  error = '';
  backupPath = '';
  private seed: Uint8Array;
  private baseline: Uint8Array;
  private store: PdfStore;
  private font: Uint8Array;
  private changes: TextChanges = { values: new Map(), added: new Map(), deleted: new Set() };
  private revision = 0;
  private savedRevision = 0;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private writing = false;

  private constructor(store: PdfStore, font: Uint8Array, seed: Uint8Array, snapshot: TextSnapshot) {
    this.store = store; this.font = font; this.seed = seed; this.baseline = seed; this.snapshot = snapshot;
  }

  static async open(store: PdfStore, font: Uint8Array): Promise<TextSession> {
    const bytes = await store.read();
    return new TextSession(store, font, bytes.slice(), await readTextPdf(bytes));
  }

  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private changed(): void { this.revision++; if (this.status !== 'conflict') this.status = this.writing ? 'saving' : 'unsaved'; this.error = ''; this.notify(); }
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  private get conflicted(): boolean { return this.status === 'conflict'; }

  setValue(name: string, value: string): void {
    if (this.status === 'conflict') throw new Error('Reload the PDF before editing after an external change.');
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field || field.readOnly) throw new Error('This text field is not editable.');
    if (field.value === value) return;
    field.value = value; this.changes.values.set(name, value); this.changed();
  }

  add(page: number, rect: Rect, fontSize: number, multiline: boolean, rotation = 0): TextField {
    if (this.status === 'conflict') throw new Error('Reload the PDF before adding text after an external change.');
    const name = FIELD_PREFIX + globalThis.crypto.randomUUID();
    const added: AddedField = { name, page, rect, fontSize, multiline, rotation };
    const field: TextField = { name, value: '', fontSize, multiline, readOnly: false, owned: true, widgets: [{ page, rect, rotation }] };
    this.changes.added.set(name, added); this.changes.values.set(name, '');
    this.snapshot.fields.push(field); this.changed(); return field;
  }

  delete(name: string): void {
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.owned) throw new Error('Only text boxes created here can be removed.');
    if (this.status === 'conflict') throw new Error('Reload the PDF before removing text after an external change.');
    if (this.changes.added.has(name)) this.changes.added.delete(name);
    else this.changes.deleted.add(name);
    this.changes.values.delete(name);
    this.snapshot.fields = this.snapshot.fields.filter(field => field.name !== name); this.changed();
  }

  save(): Promise<void> {
    const result = this.queue.catch(() => {}).then(() => this.performSave());
    this.queue = result; return result;
  }

  /** Caller confirms discarding pending edits. The current PDF is backed up first. */
  restore(bytes: Uint8Array): Promise<void> {
    const restore = async (): Promise<void> => {
      const snapshot = await readTextPdf(bytes);
      if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
      this.writing = true; this.status = 'saving'; this.notify();
      try {
        const recovery = await this.store.backup(this.baseline);
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        await this.store.write(bytes);
        if (!equalBytes(await this.store.read(), bytes)) return this.conflict();
        this.seed = bytes.slice(); this.baseline = bytes.slice(); this.snapshot = snapshot;
        this.changes = { values: new Map(), added: new Map(), deleted: new Set() };
        this.revision = 0; this.savedRevision = 0; this.backupPath = recovery;
        this.status = 'saved'; this.error = ''; this.notify();
      } catch (error) {
        if (!this.conflicted) this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error); this.notify(); throw error;
      } finally { this.writing = false; }
    };
    const result = this.queue.catch(() => {}).then(restore);
    this.queue = result; return result;
  }

  private async performSave(): Promise<void> {
    if (this.status === 'conflict') throw new Error(this.error || 'The PDF changed outside this editing session. Reload before saving.');
    if (!this.dirty) return;
    this.status = 'saving'; this.error = ''; this.notify();
    this.writing = true;
    const revision = this.revision;
    const changes: TextChanges = {
      values: new Map(this.changes.values), added: new Map(this.changes.added), deleted: new Set(this.changes.deleted)
    };
    try {
      if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
      const output = await writeTextPdf(this.seed, changes, this.font);
      if (!this.backupPath) this.backupPath = await this.store.backup(this.baseline);
      // Recheck after serialization/backup: sync or another editor may have written meanwhile.
      if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
      await this.store.write(output);
      if (!equalBytes(await this.store.read(), output)) return this.conflict();
      this.baseline = output;
      this.savedRevision = revision;
      this.status = this.dirty ? 'unsaved' : 'saved'; this.notify();
    } catch (error) {
      if (!this.conflicted) this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error); this.notify(); throw error;
    } finally {
      this.writing = false;
    }
  }

  private conflict(): never {
    this.status = 'conflict'; this.error = 'The PDF changed outside this session. Your pending text is kept here. Reload to use the newer PDF.';
    this.notify(); throw new Error(this.error);
  }

  async checkExternal(): Promise<void> {
    if (this.writing || this.status === 'conflict') return;
    if (equalBytes(await this.store.read(), this.baseline)) return;
    if (this.dirty) { try { this.conflict(); } catch { /* State is displayed by every view. */ } }
    else await this.reload();
  }

  /** Caller must explicitly discard pending changes before reload if dirty. */
  async reload(): Promise<void> {
    await this.queue.catch(() => {});
    const bytes = await this.store.read();
    const snapshot = await readTextPdf(bytes);
    this.seed = bytes.slice(); this.baseline = bytes; this.snapshot = snapshot;
    this.changes = { values: new Map(), added: new Map(), deleted: new Set() };
    this.revision = 0; this.savedRevision = 0; this.status = 'saved'; this.error = ''; this.notify();
  }
}
