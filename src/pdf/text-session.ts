import { FIELD_PREFIX, readTextPdf, renderTextPdf, writeTextPdf } from './text-engine.ts';
import type { AddedField, BoxUpdate, Rect, TextChanges, TextField, TextSnapshot } from './text-engine.ts';
import { hash } from './recovery.ts';
import { validColor } from './text-format.ts';
import type { PdfColor, PdfFonts, TextFormat } from './text-format.ts';
import type { BackupPurpose } from './recovery.ts';
import { InteractionGate } from './interaction-gate.ts';
import { INK_PREFIX, strokeBounds, validateStroke } from './ink-engine.ts';
import type { InkKind, InkStroke, Point } from './ink-engine.ts';
import { growRuledBlock, validRuledLayout } from './ruled-text.ts';
import type { RuledLayout } from './ruled-text';
import fontkit from '@pdf-lib/fontkit';
import type { Font } from '@pdf-lib/fontkit';
import type { FontFamily } from './text-format.ts';
import { wrapText } from './wrap-text.ts';

export interface PdfStore {
  draft?: { read(): Promise<PdfDraft | null>; write(draft: PdfDraft): Promise<void>; clear(): Promise<void> };
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  backup(bytes: Uint8Array, purpose?: BackupPurpose): Promise<string>;
}
type TextState = { fields: TextField[]; values: TextChanges['values']; added: TextChanges['added']; boxes: TextChanges['boxes']; deleted: TextChanges['deleted']; formats: TextChanges['formats'] };
export interface PdfObject { kind: 'text' | 'ink'; id: string }
export type CopiedPdfObject =
  | { kind: 'text'; page: number; rect: Rect; rotation: number; value: string; fontSize: number; fontFamily: FontFamily; color: PdfColor; multiline: boolean; ruled?: RuledLayout }
  | { kind: 'ink'; page: number; rect: Rect; points: Point[]; strokeKind: InkKind; width: number; color: PdfColor; opacity: number };
type UndoEntry = { kind: 'objects'; state: TextState; strokes: InkStroke[] } | { kind: 'ink'; strokes: InkStroke[] } | { kind: 'text'; state: TextState; key: string; time: number };

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
  private metrics = new Map<FontFamily, Font>();
  private changes: TextChanges = emptyChanges();
  private strokeHistory: UndoEntry[] = [];
  private inkAction?: InkStroke[];
  private inkOwner?: object;
  private strokeFuture: UndoEntry[] = [];
  private seedStrokeIds = new Set<string>();
  private draftQueue: Promise<void> = Promise.resolve();
  private candidate?: { revision: number; bytes: Uint8Array };
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
  private textEditors = new Map<string, number>();
  private persistedFieldNames: Set<string>;
  private replacements = 0;
  get replacing(): boolean { return this.replacements > 0; }
  private assertAvailable(): void {
    if (this.replacing) throw new Error('Wait for the PDF reload or restore to finish before editing.');
  }

  /** Empty placeholders stay alive while any view is actively typing in them. */
  beginTextEdit(name: string): () => void {
    this.textEditors.set(name, (this.textEditors.get(name) ?? 0) + 1);
    let released = false;
    return () => { if (released) return; released = true; const count = (this.textEditors.get(name) ?? 1) - 1;
      if (count) this.textEditors.set(name, count); else this.textEditors.delete(name); };
  }
  pruneEmptyBoxes(only?: string): number {
    if (this.conflicted || this.replacing) return 0;
    const empty = this.snapshot.fields.filter(field => this.changes.added.has(field.name) && !this.persistedFieldNames.has(field.name)
      && field.owned && !field.readOnly && !field.value.trim()
      && (!only || field.name === only) && !this.textEditors.has(field.name));
    for (const field of empty) this.delete(field.name);
    return empty.length;
  }

  private constructor(store: PdfStore, font: PdfFonts, seed: Uint8Array, snapshot: TextSnapshot) {
    this.store = store; this.font = font; this.seed = seed; this.baseline = seed; this.snapshot = snapshot; this.seedStrokeIds = new Set(snapshot.strokes.map(stroke => stroke.id));
    this.persistedFieldNames = new Set(snapshot.fields.map(field => field.name));
  }

  static async open(store: PdfStore, font: PdfFonts): Promise<TextSession> {
    const bytes = await store.read();
    const draft = await store.draft?.read();
    const session = new TextSession(store, font, draft?.bytes.slice() ?? bytes.slice(), await readTextPdf(draft?.bytes ?? bytes));
    session.baseline = bytes.slice();
    if (draft && !equalBytes(bytes, draft.bytes)) {
      session.revision = 1; session.draftRevision = 1; session.status = await hash(bytes) === draft.baselineHash ? 'unsaved' : 'conflict';
      if (session.status === 'conflict') session.error = 'A recovered draft belongs to an older PDF. Pending edits are preserved. Reload to discard them and use the current file.';
    }
    return session;
  }

  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  private removedFieldListeners = new Set<(field: TextField) => void>();
  subscribeRemovedField(callback: (field: TextField) => void): () => void {
    this.removedFieldListeners.add(callback); return () => this.removedFieldListeners.delete(callback);
  }
  private removedField(field: TextField): void { for (const listener of this.removedFieldListeners) listener(field); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private changed(): void { this.revision++; if (this.status !== 'conflict') this.status = this.writing && !this.waitingForInteraction ? 'saving' : 'unsaved'; this.error = ''; this.notify(); }
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  private get conflicted(): boolean { return this.status === 'conflict'; }

  setValue(name: string, value: string): void {
    this.assertAvailable();
    if (this.status === 'conflict') throw new Error('Reload the PDF before editing after an external change.');
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field || field.readOnly) throw new Error('This text field is not editable.');
    if (field.value === value) return;
    this.rememberText(name);
    field.value = value; this.changes.values.set(name, value); this.fitRuledField(name); this.changed();
  }

  /** Use the same glyph advances as the PDF writer, including offscreen/draft edits. */
  fitRuledField(name: string, minimumRows = 1): void {
    this.assertAvailable();
    if (this.conflicted) return;
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.ruled || !field.owned || field.readOnly || field.widgets.length !== 1) return;
    let font = this.metrics.get(field.fontFamily);
    if (!font) { font = fontkit.create(this.font instanceof Uint8Array ? this.font : this.font[field.fontFamily]); this.metrics.set(field.fontFamily, font); }
    const widget = field.widgets[0]!;
    const rows = Math.max(minimumRows, wrapText(field.value, widget.rect[2] - widget.rect[0] - 2,
      text => font.layout(text).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * field.fontSize / font.unitsPerEm).length);
    const next = growRuledBlock(widget.rect, field.ruled, rows, field.fontSize, this.snapshot.pages[widget.page - 1]!);
    if (widget.rect.every((n, i) => Math.abs(n - next.rect[i]!) < 0.001) && next.layout?.spacing === field.ruled.spacing && next.layout?.rows === field.ruled.rows) return;
    this.rememberText(name);
    widget.rect = next.rect; field.ruled = next.layout;
    this.changes.boxes.set(name, { rect: [...next.rect], fontSize: field.fontSize, multiline: true, ...(next.layout ? { ruled: { ...next.layout } } : {}) });
    this.changes.values.set(name, field.value); this.changed();
  }

  add(page: number, rect: Rect, fontSize: number, multiline: boolean, rotation = 0, ruled?: RuledLayout): TextField {
    this.assertAvailable();
    if (this.status === 'conflict') throw new Error('Reload the PDF before adding text after an external change.');
    const bounds = this.snapshot.pages[page - 1];
    if (!Number.isInteger(page) || !bounds || ![...rect, fontSize, rotation].every(Number.isFinite)
      || rect[2] <= rect[0] || rect[3] <= rect[1] || fontSize < 1 || fontSize > 200 || rotation % 90 !== 0
      || rect[0] < bounds[0] || rect[1] < bounds[1] || rect[2] > bounds[2] || rect[3] > bounds[3]
      || (ruled && (!multiline || rotation !== 0 || !validRuledLayout(ruled, rect)))) throw new Error('Invalid text box geometry. Keep the box inside its PDF page.');
    const name = FIELD_PREFIX + globalThis.crypto.randomUUID();
    const added: AddedField = { name, page, rect: [...rect], fontSize, multiline, rotation, ...(ruled ? { ruled: { ...ruled } } : {}) };
    const field: TextField = { name, value: '', fontSize, fontFamily: 'sans', color: [0.05, 0.05, 0.05], multiline, readOnly: false, owned: true, widgets: [{ page, rect: [...rect], rotation }], ...(ruled ? { ruled: { ...ruled } } : {}) };
    this.rememberText(name);
    this.changes.added.set(name, added); this.changes.values.set(name, '');
    this.snapshot.fields.push(field); this.changed(); return field;
  }

  delete(name: string, explicit = false): void {
    this.assertAvailable();
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.owned || field.readOnly) throw new Error('Only editable text boxes created here can be removed.');
    if (this.status === 'conflict') throw new Error('Reload the PDF before removing text after an external change.');
    this.rememberText(name, false);
    if (this.changes.added.has(name)) this.changes.added.delete(name);
    else this.changes.deleted.add(name);
    this.changes.values.delete(name);
    this.changes.boxes.delete(name); this.changes.formats.delete(name);
    this.snapshot.fields = this.snapshot.fields.filter(field => field.name !== name);
    if (explicit) this.removedField(field);
    this.changed();
  }

  updateBox(name: string, rect: Rect, options: Partial<Omit<BoxUpdate, 'rect'>> = {}): void {
    this.assertAvailable();
    if (this.status === 'conflict') throw new Error('Reload the PDF before moving or resizing text.');
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.owned || field.readOnly || field.widgets.length !== 1) throw new Error('Only added text boxes can be moved or resized.');
    const widget = field.widgets[0]!;
    const bounds = this.snapshot.pages[widget.page - 1]!;
    const fontSize = options.fontSize ?? field.fontSize;
    const multiline = options.multiline ?? field.multiline;
    if (![...rect, fontSize].every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1] || fontSize < 1 || fontSize > 200
      || rect[0] < bounds[0] - 0.001 || rect[1] < bounds[1] - 0.001 || rect[2] > bounds[2] + 0.001 || rect[3] > bounds[3] + 0.001) {
      throw new Error('Keep the text box inside its PDF page.');
    }
    if (widget.rect.every((value, index) => Math.abs(value - rect[index]!) < 0.001) && fontSize === field.fontSize && multiline === field.multiline) return;
    this.rememberText(name);
    if (Math.abs((widget.rect[2] - widget.rect[0]) - (rect[2] - rect[0])) > 0.001
      || Math.abs((widget.rect[3] - widget.rect[1]) - (rect[3] - rect[1])) > 0.001 || !multiline) delete field.ruled;
    widget.rect = [...rect]; field.fontSize = fontSize; field.multiline = multiline;
    this.changes.boxes.set(name, { rect: [...rect], fontSize, multiline, ...(field.ruled ? { ruled: { ...field.ruled } } : {}) });
    this.changes.values.set(name, field.value);
    if (this.changes.formats.has(name)) this.changes.formats.set(name, { fontFamily: field.fontFamily, fontSize, color: [...field.color] });
    this.changed();
  }

  adoptRuledBlock(name: string, rect: Rect, layout: RuledLayout): boolean {
    this.assertAvailable();
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field?.owned || field.readOnly || field.widgets.length !== 1 || this.status === 'conflict') return false;
    const widget = field.widgets[0]!, bounds = this.snapshot.pages[widget.page - 1]!;
    const firstHeight = rect[3] - rect[1] - (layout.rows - 1) * layout.spacing;
    if (widget.rotation !== 0 || !validRuledLayout(layout, rect) || field.fontSize * 1.2 + 2 > firstHeight + 0.001
      || rect[0] < bounds[0] || rect[1] < bounds[1] || rect[2] > bounds[2] || rect[3] > bounds[3]) return false;
    this.rememberText(name, false);
    widget.rect = [...rect]; field.multiline = true; field.ruled = { ...layout };
    this.changes.boxes.set(name, { rect: [...rect], fontSize: field.fontSize, multiline: true, ruled: { ...layout } });
    this.changes.values.set(name, field.value);
    this.changed(); return true;
  }

  formatField(name: string, format: Partial<TextFormat>): void {
    this.assertAvailable();
    const field = this.snapshot.fields.find(field => field.name === name);
    if (!field || field.readOnly || this.conflicted) throw new Error('This text cannot be formatted.');
    const next = { fontFamily: field.fontFamily, fontSize: field.fontSize, color: [...field.color] as PdfColor, ...format };
    if (!['sans', 'serif', 'mono'].includes(next.fontFamily) || !Number.isFinite(next.fontSize) || next.fontSize < 1 || next.fontSize > 200 || !validColor(next.color)) throw new Error('Invalid text formatting.');
    if (next.fontFamily === field.fontFamily && next.fontSize === field.fontSize && next.color.every((v, i) => v === field.color[i])) return;
    this.rememberText(name);
    Object.assign(field, next);
    for (const widget of field.widgets) { delete widget.fontSize; delete widget.color; }
    this.changes.formats.set(name, next); this.changes.values.set(name, field.value); this.fitRuledField(name); this.changed();
  }

  private textState(): TextState {
    const { values, added, boxes, deleted, formats } = this.changes;
    return structuredClone({ fields: this.snapshot.fields, values, added, boxes, deleted, formats });
  }
  private rememberText(key: string, merge = true): void {
    this.strokeFuture = [];
    const last = this.strokeHistory.at(-1), time = Date.now();
    if (merge && last?.kind === 'text' && last.key === key && time - last.time < 1000) { last.time = time; return; }
    this.strokeHistory.push({ kind: 'text', state: this.textState(), key, time });
    if (this.strokeHistory.length > 50) this.strokeHistory.shift();
  }
  private restoreHistory(entry: UndoEntry): void {
    if (entry.kind === 'ink') { this.restoreInk(entry.strokes); return; }
    const { fields, ...changes } = structuredClone(entry.state);
    this.snapshot.fields = fields; Object.assign(this.changes, changes);
    if (entry.kind === 'objects') this.restoreInk(entry.strokes); else this.changed();
  }
  private historyNow(entry: UndoEntry): UndoEntry {
    return entry.kind === 'objects' ? { kind: 'objects', state: this.textState(), strokes: structuredClone(this.snapshot.strokes) } : entry.kind === 'ink' ? { kind: 'ink', strokes: structuredClone(this.snapshot.strokes) }
      : { kind: 'text', state: this.textState(), key: entry.key, time: 0 };
  }
  private rememberInk(owner: object = this): void {
    if (this.inkOwner && this.inkOwner !== owner) throw new Error('Finish the current drawing gesture first.');
    this.strokeFuture = [];
    if (!this.inkAction) { this.strokeHistory.push({ kind: 'ink', strokes: structuredClone(this.snapshot.strokes) }); if (this.strokeHistory.length > 50) this.strokeHistory.shift(); }
  }
  beginInkAction(owner: object = this): boolean {
    if (this.replacing || this.conflicted) return false;
    if (this.inkOwner && this.inkOwner !== owner) return false;
    if (!this.inkAction) { this.inkAction = structuredClone(this.snapshot.strokes); this.inkOwner = owner; }
    return true;
  }
  finishInkAction(cancel = false, owner: object = this): void {
    if (this.inkOwner !== owner) return;
    const before = this.inkAction; this.inkAction = undefined; this.inkOwner = undefined;
    if (!before || JSON.stringify(before) === JSON.stringify(this.snapshot.strokes)) return;
    if (cancel) this.restoreInk(before);
    else { this.strokeHistory.push({ kind: 'ink', strokes: before }); if (this.strokeHistory.length > 50) this.strokeHistory.shift(); this.notify(); }
  }
  private restoreInk(strokes: InkStroke[]): void {
    this.snapshot.strokes = structuredClone(strokes);
    this.changes.strokes = new Map(strokes.filter(stroke => !stroke.readOnly).map(stroke => [stroke.id, stroke]));
    const ids = new Set(strokes.map(stroke => stroke.id));
    this.changes.deletedStrokes = new Set([...this.seedStrokeIds].filter(id => !ids.has(id))); this.changed();
  }
  moveStroke(id: string, delta: Point, owner: object = this): void {
    this.assertAvailable();
    if (this.conflicted) throw new Error('Reload the PDF before moving marks.');
    const index = this.snapshot.strokes.findIndex(stroke => stroke.id === id); const stroke = this.snapshot.strokes[index];
    if (!stroke || stroke.readOnly || !delta.every(Number.isFinite)) throw new Error('This mark cannot be moved.');
    const b = this.snapshot.pages[stroke.page - 1]!;
    const dx = Math.max(b[0] - stroke.rect[0], Math.min(b[2] - stroke.rect[2], delta[0]));
    const dy = Math.max(b[1] - stroke.rect[1], Math.min(b[3] - stroke.rect[3], delta[1]));
    if (Math.abs(dx) + Math.abs(dy) < 0.001) return;
    this.rememberInk(owner);
    const points = stroke.points.map(([x, y]) => [x + dx, y + dy] as Point);
    const next = { ...stroke, points, rect: strokeBounds(points, stroke.width, b) };
    this.snapshot.strokes[index] = next; this.changes.strokes.set(id, next); this.changed();
  }

  get canEditObjects(): boolean { return !this.conflicted && !this.replacing && !this.inkAction; }

  private objectItems(objects: PdfObject[]): { object: PdfObject; page: number; rect: Rect }[] {
    this.assertAvailable();
    if (this.conflicted || this.inkAction) throw new Error('Finish the current gesture or reload the PDF before editing a group.');
    const seen = new Set<string>();
    return objects.filter(object => { const key = object.kind + ':' + object.id; if (seen.has(key)) return false; seen.add(key); return true; }).map(object => {
      if (object.kind === 'text') {
        const field = this.snapshot.fields.find(field => field.name === object.id);
        if (!field?.owned || field.readOnly || field.widgets.length !== 1) throw new Error('This text box cannot be edited as part of a group.');
        return { object, page: field.widgets[0]!.page, rect: field.widgets[0]!.rect };
      }
      if (object.kind !== 'ink') throw new Error('Invalid object selection.');
      const stroke = this.snapshot.strokes.find(stroke => stroke.id === object.id);
      if (!stroke || stroke.readOnly || stroke.hidden) throw new Error('This drawing cannot be edited as part of a group.');
      return { object, page: stroke.page, rect: stroke.rect };
    });
  }
  copyObjects(objects: PdfObject[]): CopiedPdfObject[] {
    return this.objectItems(objects).map(({ object, page, rect }) => {
      if (object.kind === 'text') {
        const field = this.snapshot.fields.find(field => field.name === object.id)!;
        return { kind: 'text', page, rect: [...rect], rotation: field.widgets[0]!.rotation, value: field.value,
          fontSize: field.fontSize, fontFamily: field.fontFamily, color: [...field.color], multiline: field.multiline,
          ...(field.ruled ? { ruled: { ...field.ruled } } : {}) };
      }
      const stroke = this.snapshot.strokes.find(stroke => stroke.id === object.id)!;
      return { kind: 'ink', page, rect: [...rect], points: stroke.points.map(point => [...point]), strokeKind: stroke.kind,
        width: stroke.width, color: [...stroke.color], opacity: stroke.opacity };
    });
  }
  /** Add independent IDs and one undo entry for a copied selection. */
  pasteObjects(copied: CopiedPdfObject[], offset: Point = [12, -12]): PdfObject[] {
    this.assertAvailable();
    if (this.conflicted || this.inkAction) throw new Error('Finish the current gesture or reload the PDF before pasting objects.');
    if (!copied.length || copied.length > 500 || !offset.every(Number.isFinite)) return [];
    let left = -Infinity, right = Infinity, bottom = -Infinity, top = Infinity;
    for (const item of copied) {
      const bounds = this.snapshot.pages[item.page - 1];
      if (!bounds || !Number.isInteger(item.page) || item.rect.length !== 4 || item.rect.some(n => !Number.isFinite(n))
        || item.rect[0] < bounds[0] || item.rect[1] < bounds[1] || item.rect[2] > bounds[2] || item.rect[3] > bounds[3]
        || item.rect[2] <= item.rect[0] || item.rect[3] <= item.rect[1]) throw new Error('Copied object does not fit on this PDF page.');
      if (item.kind === 'text') {
        if (!Number.isFinite(item.fontSize) || item.fontSize < 1 || item.fontSize > 200 || item.rotation % 90 !== 0
          || !validColor(item.color) || !['sans', 'serif', 'mono'].includes(item.fontFamily)
          || (item.ruled && !validRuledLayout(item.ruled, item.rect))) throw new Error('Invalid copied text box.');
      } else if (item.kind === 'ink') {
        validateStroke({ id: INK_PREFIX + 'copy', page: item.page, kind: item.strokeKind, points: item.points, width: item.width,
          color: item.color, opacity: item.opacity, rect: item.rect, readOnly: false }, bounds);
      } else throw new Error('Invalid copied PDF object.');
      left = Math.max(left, bounds[0] - item.rect[0]); right = Math.min(right, bounds[2] - item.rect[2]);
      bottom = Math.max(bottom, bounds[1] - item.rect[1]); top = Math.min(top, bounds[3] - item.rect[3]);
    }
    const dx = Math.max(left, Math.min(right, offset[0])), dy = Math.max(bottom, Math.min(top, offset[1]));
    this.rememberObjects();
    const created: PdfObject[] = [];
    for (const item of copied) {
      if (item.kind === 'text') {
        const name = FIELD_PREFIX + globalThis.crypto.randomUUID();
        const rect: Rect = [item.rect[0] + dx, item.rect[1] + dy, item.rect[2] + dx, item.rect[3] + dy];
        const added: AddedField = { name, page: item.page, rect, fontSize: item.fontSize, multiline: item.multiline, rotation: item.rotation,
          ...(item.ruled ? { ruled: { ...item.ruled } } : {}) };
        this.snapshot.fields.push({ name, value: item.value, fontSize: item.fontSize, fontFamily: item.fontFamily,
          color: [...item.color], multiline: item.multiline, readOnly: false, owned: true,
          widgets: [{ page: item.page, rect: [...rect], rotation: item.rotation }], ...(item.ruled ? { ruled: { ...item.ruled } } : {}) });
        this.changes.added.set(name, added); this.changes.values.set(name, item.value);
        this.changes.formats.set(name, { fontFamily: item.fontFamily, fontSize: item.fontSize, color: [...item.color] });
        created.push({ kind: 'text', id: name });
      } else {
        const id = INK_PREFIX + globalThis.crypto.randomUUID(), bounds = this.snapshot.pages[item.page - 1]!;
        const points = item.points.map<Point>(([x, y]) => [x + dx, y + dy]);
        const stroke: InkStroke = { id, page: item.page, kind: item.strokeKind, points, width: item.width,
          color: [...item.color], opacity: item.opacity, rect: strokeBounds(points, item.width, bounds), readOnly: false };
        this.snapshot.strokes.push(stroke); this.changes.strokes.set(id, stroke); created.push({ kind: 'ink', id });
      }
    }
    this.changed(); return created;
  }
  /** One shared translation keeps spacing intact, even when a group reaches an edge. */
  objectDelta(objects: PdfObject[], delta: Point): Point {
    if (!delta.every(Number.isFinite)) throw new Error('Invalid group movement.');
    let left = -Infinity, right = Infinity, bottom = -Infinity, top = Infinity;
    for (const item of this.objectItems(objects)) {
      const bounds = this.snapshot.pages[item.page - 1]!;
      left = Math.max(left, bounds[0] - item.rect[0]); right = Math.min(right, bounds[2] - item.rect[2]);
      bottom = Math.max(bottom, bounds[1] - item.rect[1]); top = Math.min(top, bounds[3] - item.rect[3]);
    }
    return [Math.max(left, Math.min(right, delta[0])), Math.max(bottom, Math.min(top, delta[1]))];
  }
  private rememberObjects(): void {
    this.strokeFuture = []; this.strokeHistory.push({ kind: 'objects', state: this.textState(), strokes: structuredClone(this.snapshot.strokes) });
    if (this.strokeHistory.length > 50) this.strokeHistory.shift();
  }
  moveObjects(objects: PdfObject[], delta: Point): void {
    const items = this.objectItems(objects), [dx, dy] = this.objectDelta(objects, delta);
    if (!items.length || Math.abs(dx) + Math.abs(dy) < 0.001) return;
    this.rememberObjects();
    for (const { object, rect, page } of items) {
      if (object.kind === 'text') {
        const field = this.snapshot.fields.find(field => field.name === object.id)!;
        const next: Rect = [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
        field.widgets[0]!.rect = next;
        this.changes.boxes.set(object.id, { rect: next, fontSize: field.fontSize, multiline: field.multiline, ...(field.ruled ? { ruled: { ...field.ruled } } : {}) });
        this.changes.values.set(object.id, field.value);
      } else {
        const index = this.snapshot.strokes.findIndex(stroke => stroke.id === object.id), stroke = this.snapshot.strokes[index]!;
        const points = stroke.points.map<Point>(([x, y]) => [x + dx, y + dy]);
        const next = { ...stroke, points, rect: strokeBounds(points, stroke.width, this.snapshot.pages[page - 1]!) };
        this.snapshot.strokes[index] = next; this.changes.strokes.set(object.id, next);
      }
    }
    this.changed();
  }
  deleteObjects(objects: PdfObject[]): void {
    const items = this.objectItems(objects); if (!items.length) return;
    this.rememberObjects();
    for (const { object } of items) {
      if (object.kind === 'text') {
        const field = this.snapshot.fields.find(field => field.name === object.id)!;
        if (!this.changes.added.delete(object.id)) this.changes.deleted.add(object.id);
        this.changes.values.delete(object.id); this.changes.boxes.delete(object.id); this.changes.formats.delete(object.id);
        this.snapshot.fields = this.snapshot.fields.filter(field => field.name !== object.id);
        this.removedField(field);
      } else {
        this.changes.strokes.delete(object.id); if (this.seedStrokeIds.has(object.id)) this.changes.deletedStrokes.add(object.id);
        this.snapshot.strokes = this.snapshot.strokes.filter(stroke => stroke.id !== object.id);
      }
    }
    this.changed();
  }

  addStroke(page: number, kind: InkKind, points: Point[], width = kind === 'marker' ? 14 : 2, color?: PdfColor, owner: object = this): InkStroke {
    this.assertAvailable();
    if (this.conflicted) throw new Error('Reload the PDF before drawing after an external change.');
    const bounds = this.snapshot.pages[page - 1];
    if (!bounds || !Number.isInteger(page)) throw new Error('The drawing page does not exist.');
    const stroke: InkStroke = { id: INK_PREFIX + globalThis.crypto.randomUUID(), page, kind,
      points: points.map(point => [...point]), width, color: color ? [...color] : kind === 'marker' ? [1, 0.84, 0] : [0.085, 0.085, 0.085],
      opacity: kind === 'marker' ? 0.4 : 1, rect: strokeBounds(points, width, bounds), readOnly: false };
    validateStroke(stroke, bounds);
    this.rememberInk(owner); this.changes.strokes.set(stroke.id, stroke); this.snapshot.strokes.push(stroke);
    this.changed(); return stroke;
  }

  deleteStroke(id: string, owner: object = this): void {
    this.assertAvailable();
    if (this.conflicted) throw new Error('Reload the PDF before removing a drawing.');
    const stroke = this.snapshot.strokes.find(stroke => stroke.id === id);
    if (!stroke || stroke.readOnly) throw new Error('This drawing cannot be removed.');
    this.rememberInk(owner); this.changes.strokes.delete(id);
    if (this.seedStrokeIds.has(id)) this.changes.deletedStrokes.add(id);
    this.snapshot.strokes = this.snapshot.strokes.filter(stroke => stroke.id !== id); this.changed();
  }

  get canUndoStroke(): boolean { return !this.inkAction && this.strokeHistory.length > 0; }
  undoStroke(): void {
    this.assertAvailable();
    if (this.conflicted) throw new Error('Reload the PDF before undoing a mark.');
    if (this.inkAction) return;
    const before = this.strokeHistory.pop(); if (before) { this.strokeFuture.push(this.historyNow(before)); this.restoreHistory(before); }
  }

  get canRedoStroke(): boolean { return !this.inkAction && this.strokeFuture.length > 0; }
  redoStroke(): void {
    this.assertAvailable();
    if (this.conflicted || this.inkAction) return;
    const after = this.strokeFuture.pop(); if (after) { this.strokeHistory.push(this.historyNow(after)); this.restoreHistory(after); }
  }

  private cloneChanges(): TextChanges {
    return structuredClone(this.changes);
  }
  /** Verified pending PDF in hidden storage; does not reload the displayed PDF. */
  checkpoint(): Promise<void> {
    const epoch = this.editEpoch;
    const result = this.draftQueue.catch(() => {}).then(async () => {
      if (!this.store.draft || epoch !== this.editEpoch || !this.dirty || this.conflicted || this.replacing) return;
      let revision: number, baseline: Uint8Array, bytes: Uint8Array;
      do {
        revision = this.revision; baseline = this.baseline;
        bytes = this.candidate?.revision === revision ? this.candidate.bytes : await writeTextPdf(this.seed, this.cloneChanges(), this.font);
        if (epoch !== this.editEpoch || !this.dirty || this.conflicted) return;
      } while (revision !== this.revision || baseline !== this.baseline);
      this.candidate = { revision, bytes };
      await this.store.draft.write({ baselineHash: await hash(baseline), bytes });
      if (epoch === this.editEpoch && baseline === this.baseline) this.draftRevision = revision; this.notify();
    });
    this.draftQueue = result; return result;
  }

  save(): Promise<void> {
    // Explicit Save/Done/close must also release an automatic save already
    // waiting in the queue, otherwise the explicit request would deadlock.
    this.interactions.flush();
    const epoch = this.editEpoch;
    const result = this.queue.catch(() => {}).then(() => this.performSave(undefined, epoch));
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
    bytes = bytes.slice();
    const restore = async (): Promise<void> => {
      const snapshot = await readTextPdf(bytes);
      if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
      this.writing = true; this.status = 'saving'; this.notify();
      try {
        const recovery = await this.store.backup(this.baseline, 'restore');
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        await this.store.write(bytes);
        if (!equalBytes(await this.store.read(), bytes)) return this.conflict();
        await this.draftQueue.catch(() => {});
        this.reset(bytes, snapshot); this.backupPath = recovery;
        await this.store.draft?.clear();
        this.status = 'saved'; this.error = ''; this.notify();
      } catch (error) {
        if (!this.conflicted) this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error); this.notify(); throw error;
      } finally { this.writing = false; }
    };
    return this.replaceDocument(restore);
  }

  /** Reload/restore own the save queue and reject edits until their snapshot is installed. */
  private replaceDocument(operation: () => Promise<void>): Promise<void> {
    this.editEpoch++; this.candidate = undefined; this.draftRevision = -1; this.replacements++;
    this.interactions.flush(); this.notify();
    const result = this.queue.catch(() => {}).then(operation).catch(error => {
      if (!this.conflicted) this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error); throw error;
    }).finally(() => { this.replacements--; this.notify(); });
    this.queue = result; return result;
  }

  private reset(bytes: Uint8Array, snapshot: TextSnapshot): void {
    this.seed = bytes.slice(); this.baseline = bytes.slice(); this.snapshot = snapshot; this.renderEpoch++;
    this.candidate = undefined; this.draftRevision = -1;
    this.changes = emptyChanges(); this.strokeHistory = []; this.strokeFuture = []; this.inkAction = undefined; this.inkOwner = undefined;
    this.seedStrokeIds = new Set(snapshot.strokes.map(stroke => stroke.id));
    this.persistedFieldNames = new Set(snapshot.fields.map(field => field.name));
    this.revision = 0; this.savedRevision = 0;
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
        output = this.candidate?.revision === revision ? this.candidate.bytes : await writeTextPdf(this.seed, changes, this.font);
        // An explicit Save can happen before the UI's checkpoint timer. Keep a
        // complete verified candidate before touching the source, including on
        // adapters that can fail after a partial write.
        if (this.store.draft) {
          const baseline = this.baseline, candidate = output;
          const journal = this.draftQueue.catch(() => {}).then(async () => {
            if (epoch !== undefined && epoch !== this.editEpoch) return;
            if (this.draftRevision >= revision) return;
            await this.store.draft!.write({ baselineHash: await hash(baseline), bytes: candidate });
            if (baseline === this.baseline && epoch === this.editEpoch) this.draftRevision = revision;
          });
          this.draftQueue = journal; await journal;
        }
        this.backupPath = await this.store.backup(this.baseline);
        // A new tap/focus can arrive during PDF serialization or backup I/O.
        // Wait again at the write boundary and regenerate if the answer changed.
        if (generation !== undefined) await this.waitForInteraction(generation);
        if (epoch !== undefined && epoch !== this.editEpoch) return;
        // Recheck after serialization/backup/waiting. The synchronous idle check
        // also catches a new interaction during this final asynchronous read.
        if (!equalBytes(await this.store.read(), this.baseline)) return this.conflict();
        if (epoch !== undefined && epoch !== this.editEpoch) return;
      } while (revision !== this.revision || (generation !== undefined && !this.interactions.isIdle(generation)));
      await this.store.write(output);
      if (!equalBytes(await this.store.read(), output)) return this.conflict();
      this.baseline = output;
      this.draftRevision = -1;
      const savedSnapshot = await readTextPdf(output);
      for (const field of savedSnapshot.fields) this.persistedFieldNames.add(field.name);
      if (this.snapshot.strokes.length) {
        const saved = new Map(savedSnapshot.strokes.map(stroke => [stroke.id, stroke.annotationId]));
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
    if (this.writing || this.replacing || this.status === 'conflict') return;
    const baseline = this.baseline, epoch = this.editEpoch;
    const bytes = await this.store.read();
    if (this.writing || this.replacing || baseline !== this.baseline || epoch !== this.editEpoch) return;
    if (equalBytes(bytes, baseline)) return;
    if (this.dirty) { try { this.conflict(); } catch { /* State is displayed by every view. */ } }
    else await this.reload();
  }

  /** Caller must explicitly discard pending changes before reload if dirty. */
  reload(): Promise<void> {
    return this.replaceDocument(async () => {
      const bytes = await this.store.read();
      const snapshot = await readTextPdf(bytes);
      await this.draftQueue.catch(() => {});
      this.reset(bytes, snapshot);
      await this.store.draft?.clear();
      this.status = 'saved'; this.error = ''; this.notify();
    });
  }
}
