import { FIELD_PREFIX, readTextPdf, renderTextPdf, writeTextPdf } from './text-engine.ts';
import type { AddedField, BoxUpdate, Rect, TextChanges, TextField, TextSnapshot } from './text-engine.ts';
import { hash } from './recovery.ts';
import { validColor } from './text-format.ts';
import type { PdfColor, PdfFonts, TextFormat } from './text-format.ts';
import type { BackupPurpose } from './recovery.ts';
import { InteractionGate } from './interaction-gate.ts';
import { INK_PREFIX, strokeBounds, validateStroke } from './ink-engine.ts';
import type { InkKind, InkStroke, Point } from './ink-engine.ts';

export interface PdfStore {
  draft?: { read(): Promise<PdfDraft | null>; write(draft: PdfDraft): Promise<void>; clear(): Promise<void> };
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  backup(bytes: Uint8Array, purpose?: BackupPurpose): Promise<string>;
}
export interface PdfDraft { baselineHash: string; bytes: Uint8Array }
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
const emptyChanges = (): TextChanges => ({ values: new Map(), added: new Map(), boxes: new Map(), deleted: new Set(), strokes: new Map(), deletedStrokes: new Set(), formats: new Map() });

/** One session per vault PDF; every view shares its model and serialized writer. */
export class TextSession {
  snapshot: TextSnapshot;
  renderEpoch = 0;
  renderBytes(): Promise<Uint8Array> { return renderTextPdf(this.seed.slice()); }
  status: SaveStatus = 'saved';
  error = '';
  backupPath = '';
  private seed: Uint8Array;
  private baseline: Uint8Array;
  private store: PdfStore;
  private font: PdfFonts;
  private changes: TextChanges = emptyChanges();
  private strokeHistory: InkStroke[][] = [];
  private inkAction?: InkStroke[];
  private seedStrokeIds = new Set<string>();
  private draftQueue: Promise<void> = Promise.resolve();
  private revision = 0;
  private savedRevision = 0;
  private draftRevision = -1;
  get drafted(): boolean { return this.dirty && this.draftRevision === this.revision; }
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private writing = false;
  private interactions = new InteractionGate();
  private editEpoch = 0;
  private waitingForInteraction = false;

  private constructor(store: PdfStore, font: PdfFonts, seed: Uint8Array, snapshot: TextSnapshot) {
    this.store = store; this.font = font; this.seed = seed; this.baseline = seed; this.snapshot = snapshot; this.seedStrokeIds = new Set(snapshot.strokes.map(stroke => stroke.id));
  }

  static async open(store: PdfStore, font: PdfFonts): Promise<TextSession> {
    const bytes = await store.read();
    const draft = await store.draft?.read();
    const session = new TextSession(store, font, draft?.bytes.slice() ?? bytes.slice(), await readTextPdf(draft?.bytes ?? bytes));
    session.baseline = bytes.slice();
    if (draft) {
      session.revision = 1; session.draftRevision = 1; session.status = await hash(bytes) === draft.baselineHash ? 'unsaved' : 'conflict';
      if (session.status === 'conflict') session.error = 'A recovered draft belongs to an older PDF. Pending edits are preserved. Reload to discard them and use the current file.';
    }
    return session;
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
    const field: TextField = { name, value: '', fontSize, fontFamily: 'sans', color: [0.05, 0.05, 0.05], multiline, readOnly: false, owned: true, widgets: [{ page, rect, rotation }] };
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
    this.changes.boxes.delete(name); this.changes.formats.delete(name);
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
    this.changes.values.set(name, field.value);
    if (this.changes.formats.has(name)) this.changes.formats.set(name, { fontFamily: field.fontFamily, fontSize, color: [...field.color] });
    this.changed();
  }

  formatField(name: string, format: Partial<TextFormat>): void {
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field || field.readOnly || this.conflicted) throw new Error('This text cannot be formatted.');
    const next = { fontFamily: field.fontFamily, fontSize: field.fontSize, color: [...field.color] as PdfColor, ...format };
    if (!['sans', 'serif', 'mono'].includes(next.fontFamily) || !Number.isFinite(next.fontSize) || next.fontSize < 1 || next.fontSize > 200 || !validColor(next.color)) throw new Error('Invalid text formatting.');
    Object.assign(field, next); this.changes.formats.set(name, next); this.changes.values.set(name, field.value); this.changed();
  }

  private rememberInk(): void {
    if (!this.inkAction) { this.strokeHistory.push(structuredClone(this.snapshot.strokes)); if (this.strokeHistory.length > 50) this.strokeHistory.shift(); }
  }
  beginInkAction(): void { if (!this.inkAction) this.inkAction = structuredClone(this.snapshot.strokes); }
  finishInkAction(cancel = false): void {
    const before = this.inkAction; this.inkAction = undefined;
    if (!before || JSON.stringify(before) === JSON.stringify(this.snapshot.strokes)) return;
    if (cancel) this.restoreInk(before);
    else { this.strokeHistory.push(before); if (this.strokeHistory.length > 50) this.strokeHistory.shift(); this.notify(); }
  }
  private restoreInk(strokes: InkStroke[]): void {
    this.snapshot.strokes = structuredClone(strokes);
    this.changes.strokes = new Map(strokes.filter(stroke => !stroke.readOnly).map(stroke => [stroke.id, stroke]));
    const ids = new Set(strokes.map(stroke => stroke.id));
    this.changes.deletedStrokes = new Set([...this.seedStrokeIds].filter(id => !ids.has(id))); this.changed();
  }
  moveStroke(id: string, delta: Point): void {
    if (this.conflicted) throw new Error('Reload the PDF before moving marks.');
    const index = this.snapshot.strokes.findIndex(stroke => stroke.id === id); const stroke = this.snapshot.strokes[index];
    if (!stroke || stroke.readOnly || !delta.every(Number.isFinite)) throw new Error('This mark cannot be moved.');
    const b = this.snapshot.pages[stroke.page - 1]!;
    const dx = Math.max(b[0] - stroke.rect[0], Math.min(b[2] - stroke.rect[2], delta[0]));
    const dy = Math.max(b[1] - stroke.rect[1], Math.min(b[3] - stroke.rect[3], delta[1]));
    if (Math.abs(dx) + Math.abs(dy) < 0.001) return;
    this.rememberInk();
    const points = stroke.points.map(([x, y]) => [x + dx, y + dy] as Point);
    const next = { ...stroke, points, rect: strokeBounds(points, stroke.width, b) };
    this.snapshot.strokes[index] = next; this.changes.strokes.set(id, next); this.changed();
  }

  addStroke(page: number, kind: InkKind, points: Point[], width = kind === 'marker' ? 14 : 2, color?: PdfColor): InkStroke {
    if (this.conflicted) throw new Error('Reload the PDF before drawing after an external change.');
    const bounds = this.snapshot.pages[page - 1];
    if (!bounds || !Number.isInteger(page)) throw new Error('The drawing page does not exist.');
    const stroke: InkStroke = { id: INK_PREFIX + globalThis.crypto.randomUUID(), page, kind,
      points: points.map(point => [...point]), width, color: color ? [...color] : kind === 'marker' ? [1, 0.84, 0] : [0.085, 0.085, 0.085],
      opacity: kind === 'marker' ? 0.4 : 1, rect: strokeBounds(points, width, bounds), readOnly: false };
    validateStroke(stroke, bounds);
    this.rememberInk(); this.changes.strokes.set(stroke.id, stroke); this.snapshot.strokes.push(stroke);
    this.changed(); return stroke;
  }

  deleteStroke(id: string): void {
    if (this.conflicted) throw new Error('Reload the PDF before removing a drawing.');
    const stroke = this.snapshot.strokes.find(stroke => stroke.id === id);
    if (!stroke || stroke.readOnly) throw new Error('This drawing cannot be removed.');
    this.rememberInk(); this.changes.strokes.delete(id);
    if (this.seedStrokeIds.has(id)) this.changes.deletedStrokes.add(id);
    this.snapshot.strokes = this.snapshot.strokes.filter(stroke => stroke.id !== id); this.changed();
  }

  get canUndoStroke(): boolean { return this.strokeHistory.length > 0; }
  undoStroke(): void {
    if (this.conflicted) throw new Error('Reload the PDF before undoing a mark.');
    const before = this.strokeHistory.pop(); if (before) this.restoreInk(before);
  }

  private cloneChanges(): TextChanges {
    return structuredClone(this.changes);
  }
  /** Verified pending PDF in hidden storage; does not reload the displayed PDF. */
  checkpoint(): Promise<void> {
    const epoch = this.editEpoch;
    const result = this.draftQueue.catch(() => {}).then(async () => {
      if (!this.store.draft || epoch !== this.editEpoch || !this.dirty || this.conflicted) return;
      let revision: number, baseline: Uint8Array, bytes: Uint8Array;
      do {
        revision = this.revision; baseline = this.baseline;
        bytes = await writeTextPdf(this.seed, this.cloneChanges(), this.font);
        if (epoch !== this.editEpoch || !this.dirty || this.conflicted) return;
      } while (revision !== this.revision || baseline !== this.baseline);
      await this.store.draft.write({ baselineHash: await hash(baseline), bytes });
      if (baseline === this.baseline) this.draftRevision = revision; this.notify();
    });
    this.draftQueue = result; return result;
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
        this.seed = bytes.slice(); this.baseline = bytes.slice(); this.snapshot = snapshot; this.renderEpoch++;
        this.changes = emptyChanges(); this.strokeHistory = []; this.seedStrokeIds = new Set(this.snapshot.strokes.map(stroke => stroke.id));
        await this.draftQueue.catch(() => {}); await this.store.draft?.clear();
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
        const changes = this.cloneChanges();
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
      await this.draftQueue.catch(() => {});
      if (!this.dirty) await this.store.draft?.clear(); else await this.checkpoint();
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
    this.seed = bytes.slice(); this.baseline = bytes; this.snapshot = snapshot; this.renderEpoch++;
    this.changes = emptyChanges(); this.strokeHistory = []; this.seedStrokeIds = new Set(snapshot.strokes.map(stroke => stroke.id));
    await this.draftQueue.catch(() => {}); await this.store.draft?.clear();
    this.revision = 0; this.savedRevision = 0; this.status = 'saved'; this.error = ''; this.notify();
  }
}
