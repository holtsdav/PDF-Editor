import { FIELD_PREFIX, readTextPdf, writeTextPdf } from './text-engine.ts';
import type { AddedField, BoxUpdate, Rect, TextChanges, TextField, TextSnapshot } from './text-engine.ts';
import type { BackupPurpose } from './recovery.ts';
import { InteractionGate } from './interaction-gate.ts';
import { INK_PREFIX, strokeBounds, validateStroke } from './ink-engine.ts';
import type { InkKind, InkStroke, Point } from './ink-engine.ts';

export interface PdfStore {
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  backup(bytes: Uint8Array, purpose?: BackupPurpose): Promise<string>;
}
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
const emptyChanges = (): TextChanges => ({ values: new Map(), added: new Map(), boxes: new Map(), deleted: new Set(), strokes: new Map(), deletedStrokes: new Set() });

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
  private changes: TextChanges = emptyChanges();
  private strokeHistory: string[] = [];
  private revision = 0;
  private savedRevision = 0;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private writing = false;
  private interactions = new InteractionGate();
  private editEpoch = 0;
  private waitingForInteraction = false;

  private constructor(store: PdfStore, font: Uint8Array, seed: Uint8Array, snapshot: TextSnapshot) {
    this.store = store; this.font = font; this.seed = seed; this.baseline = seed; this.snapshot = snapshot;
  }

  static async open(store: PdfStore, font: Uint8Array): Promise<TextSession> {
    const bytes = await store.read();
    return new TextSession(store, font, bytes.slice(), await readTextPdf(bytes));
  }

  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private changed(): void { this.revision++; if (this.status !== 'conflict') this.status = this.writing && !this.waitingForInteraction ? 'saving' : 'unsaved'; this.error = ''; this.notify(); }
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
    this.changes.boxes.delete(name);
    this.snapshot.fields = this.snapshot.fields.filter(field => field.name !== name); this.changed();
  }

  updateBox(name: string, rect: Rect, options: Partial<Omit<BoxUpdate, 'rect'>> = {}): void {
    if (this.status === 'conflict') throw new Error('Reload the PDF before moving or resizing text.');
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.owned || field.readOnly || field.widgets.length !== 1) throw new Error('Only added text boxes can be moved or resized.');
    const widget = field.widgets[0]!;
    const bounds = this.snapshot.pages[widget.page - 1]!;
    const fontSize = options.fontSize ?? field.fontSize;
    const multiline = options.multiline ?? field.multiline;
    if (![...rect, fontSize].every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1] || fontSize <= 0
      || rect[0] < bounds[0] - 0.001 || rect[1] < bounds[1] - 0.001 || rect[2] > bounds[2] + 0.001 || rect[3] > bounds[3] + 0.001) {
      throw new Error('Keep the text box inside its PDF page.');
    }
    if (widget.rect.every((value, index) => Math.abs(value - rect[index]!) < 0.001) && fontSize === field.fontSize && multiline === field.multiline) return;
    widget.rect = [...rect]; field.fontSize = fontSize; field.multiline = multiline;
    this.changes.boxes.set(name, { rect: [...rect], fontSize, multiline });
    this.changes.values.set(name, field.value); this.changed();
  }

  addStroke(page: number, kind: InkKind, points: Point[], width = kind === 'marker' ? 14 : 2): InkStroke {
    if (this.conflicted) throw new Error('Reload the PDF before drawing after an external change.');
    const bounds = this.snapshot.pages[page - 1];
    if (!bounds || !Number.isInteger(page)) throw new Error('The drawing page does not exist.');
    const stroke: InkStroke = { id: INK_PREFIX + globalThis.crypto.randomUUID(), page, kind,
      points: points.map(point => [...point]), width, color: kind === 'marker' ? [1, 0.84, 0] : [0.085, 0.085, 0.085],
      opacity: kind === 'marker' ? 0.4 : 1, rect: strokeBounds(points, width, bounds), readOnly: false };
    validateStroke(stroke, bounds);
    this.changes.strokes.set(stroke.id, stroke); this.snapshot.strokes.push(stroke);
    this.strokeHistory.push(stroke.id); this.changed(); return stroke;
  }

  deleteStroke(id: string): void {
    if (this.conflicted) throw new Error('Reload the PDF before removing a drawing.');
    const stroke = this.snapshot.strokes.find(stroke => stroke.id === id);
    if (!stroke || stroke.readOnly) throw new Error('This drawing cannot be removed.');
    if (this.changes.strokes.has(id)) this.changes.strokes.delete(id);
    else this.changes.deletedStrokes.add(id);
    this.snapshot.strokes = this.snapshot.strokes.filter(stroke => stroke.id !== id); this.changed();
  }

  get canUndoStroke(): boolean { return this.strokeHistory.some(id => this.snapshot.strokes.some(stroke => stroke.id === id)); }
  undoStroke(): void {
    if (this.conflicted) throw new Error('Reload the PDF before undoing a drawing.');
    let id: string | undefined;
    while ((id = this.strokeHistory.pop())) {
      if (this.snapshot.strokes.some(stroke => stroke.id === id)) { this.deleteStroke(id); return; }
    }
  }

  save(): Promise<void> {
    // Explicit Save/Done/close must also release an automatic save already
    // waiting in the queue, otherwise the explicit request would deadlock.
    this.interactions.flush();
    const result = this.queue.catch(() => {}).then(() => this.performSave());
    this.queue = result; return result;
  }

  beginInteraction(): () => void { return this.interactions.begin(); }

  private async waitForInteraction(generation: number): Promise<void> {
    if (this.interactions.isIdle(generation)) return;
    this.waitingForInteraction = true;
    if (this.status !== 'conflict') { this.status = 'unsaved'; this.notify(); }
    await this.interactions.whenIdle(generation);
    this.waitingForInteraction = false;
    if (this.writing && this.status !== 'conflict') { this.status = 'saving'; this.notify(); }
  }

  saveWhenIdle(): Promise<void> {
    const generation = this.interactions.generation;
    const epoch = this.editEpoch;
    const result = this.queue.catch(() => {}).then(() => this.performSave(generation, epoch));
    this.queue = result; return result;
  }

  /** Caller confirms discarding pending edits. The current PDF is backed up first. */
  restore(bytes: Uint8Array): Promise<void> {
    this.editEpoch++;
    this.interactions.flush();
    const restore = async (): Promise<void> => {
      const snapshot = await readTextPdf(bytes);
      if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
      this.writing = true; this.status = 'saving'; this.notify();
      try {
        const recovery = await this.store.backup(this.baseline, 'restore');
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        await this.store.write(bytes);
        if (!equalBytes(await this.store.read(), bytes)) return this.conflict();
        this.seed = bytes.slice(); this.baseline = bytes.slice(); this.snapshot = snapshot;
        this.changes = emptyChanges(); this.strokeHistory = [];
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

  private async performSave(generation?: number, epoch?: number): Promise<void> {
    // A queued autosave may follow an explicit commit. A clean document must
    // not wait for focus or change its already-saved status.
    if (epoch !== undefined && epoch !== this.editEpoch) return;
    if (!this.dirty && this.status !== 'conflict') return;
    if (generation !== undefined) await this.waitForInteraction(generation);
    if (epoch !== undefined && epoch !== this.editEpoch) return;
    if (this.status === 'conflict') throw new Error(this.error || 'The PDF changed outside this editing session. Reload before saving.');
    if (!this.dirty) return;
    this.status = 'saving'; this.error = ''; this.notify();
    this.writing = true;
    try {
      let revision: number;
      let output: Uint8Array;
      do {
        if (generation !== undefined) await this.waitForInteraction(generation);
        if (epoch !== undefined && epoch !== this.editEpoch) return;
        revision = this.revision;
        const changes: TextChanges = {
          values: new Map(this.changes.values), added: new Map(this.changes.added), boxes: new Map(this.changes.boxes), deleted: new Set(this.changes.deleted),
          strokes: new Map(this.changes.strokes), deletedStrokes: new Set(this.changes.deletedStrokes)
        };
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        output = await writeTextPdf(this.seed, changes, this.font);
        this.backupPath = await this.store.backup(this.baseline);
        // A new tap/focus can arrive during PDF serialization or backup I/O.
        // Wait again at the write boundary and regenerate if the answer changed.
        if (generation !== undefined) await this.waitForInteraction(generation);
        if (epoch !== undefined && epoch !== this.editEpoch) return;
        // Recheck after serialization/backup/waiting. The synchronous idle check
        // also catches a new interaction during this final asynchronous read.
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        if (epoch !== undefined && epoch !== this.editEpoch) return;
      } while (generation !== undefined && (revision !== this.revision || !this.interactions.isIdle(generation)));
      await this.store.write(output);
      if (!equalBytes(await this.store.read(), output)) return this.conflict();
      this.baseline = output;
      if (this.snapshot.strokes.length) {
        const saved = new Map((await readTextPdf(output)).strokes.map(stroke => [stroke.id, stroke.annotationId]));
        for (const stroke of this.snapshot.strokes) stroke.annotationId = saved.get(stroke.id);
      }
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
    this.status = 'conflict'; this.error = 'The PDF changed outside this session. Your pending text and marks are kept here. Reload to use the newer PDF.';
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
    this.editEpoch++;
    this.interactions.flush();
    await this.queue.catch(() => {});
    const bytes = await this.store.read();
    const snapshot = await readTextPdf(bytes);
    this.seed = bytes.slice(); this.baseline = bytes; this.snapshot = snapshot;
    this.changes = emptyChanges(); this.strokeHistory = [];
    this.revision = 0; this.savedRevision = 0; this.status = 'saved'; this.error = ''; this.notify();
  }
}
