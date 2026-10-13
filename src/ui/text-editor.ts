import { Component, Menu, Modal, Notice, Scope, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import type { NativePage, NativePdf, EditorSurface } from '../compat/native-pdf';
import { pdfRectangle, screenRectangle } from '../compat/native-pdf';
import type { Rect, TextField, TextWidget } from '../pdf/text-engine';
import type { BackupKind } from '../pdf/recovery';
import { usePdfFont } from './pdf-font';
import type { CopiedPdfObject, PdfObject, TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { growBox, rotatedHandle, transformBox } from '../pdf/box-geometry';
import type { ResizeHandle } from '../pdf/box-geometry';
import { ObjectSelection } from './object-selection';
import { InkLayer } from './ink-layer';
import type { EditorTool } from './ink-layer';
import { cssColor, fontFaces } from '../pdf/text-format';
import type { FontFamily, PdfColor, TextFormat } from '../pdf/text-format';
import { RecoveryInfo } from './recovery-info';
import { RecoveryPreview } from './recovery-preview';
import { ToolPopover } from './tool-popover';
import { ruledAnswerBlock } from '../pdf/ruled-text';
import { labelOverlay } from './overlay-label';


interface AnswerLine { page: number; rect: Rect }
const objectClipboardType = 'application/x-pdf-editor-objects';
const webObjectClipboardType = `web ${objectClipboardType}`;
interface ObjectCopy { token: string; objects: CopiedPdfObject[]; text: string; custom: boolean; blurred?: boolean; write?: Promise<void> }
let copiedObjects: ObjectCopy | undefined;
function objectClipboardHtml(doc: Document, text: string, token: string): string {
  const span = doc.createElement('span'); span.dataset.pdfEditorObjects = token;
  span.textContent = text;
  // Semantic preformatting survives HTML clipboard transfer without inline CSS.
  // Nesting the span also preserves a leading newline when the HTML is parsed.
  const pre = doc.createElement('pre'); pre.append(span);
  return pre.outerHTML;
}

interface FieldControl {
  frame: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement;
  preview?: Rect; dispose?: () => void; cancel?: () => void;
}
interface PageLayer { page: NativePage; layer: HTMLElement; controls: Map<string, FieldControl>; ink: InkLayer; cancelPlacement?: () => void; placing?: () => boolean }
interface EditorState {
  tool: EditorTool; textFamily: FontFamily; textColor: PdfColor; fontSize: number; markerWidth: number; penWidth: number; markerColor: PdfColor; penColor: PdfColor; selected?: string; selectedStroke?: string;
  letterSpacing: number; lineSpacing: number; textAlignment: 'left' | 'center' | 'right';
  focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
}

export class TextEditor extends Component {
  private app: App;
  private native: EditorSurface;
  private sessions: VaultSessions;
  private session?: TextSession;
  private toolbar: HTMLElement;
  private tools = new Map<EditorTool, HTMLButtonElement>();
  private status: HTMLElement;
  private message: HTMLElement;
  private saveButton: HTMLButtonElement;
  private removeButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private editControls: HTMLElement;
  private propertiesButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private popover?: ToolPopover;
  private textFamily: FontFamily = 'sans';
  private textColor: PdfColor = [0.05, 0.05, 0.05];
  private markerColor: PdfColor = [1, 0.84, 0];
  private penColor: PdfColor = [0.085, 0.085, 0.085];
  private menu?: Menu;
  private layers = new Map<HTMLElement, PageLayer>();
  private tool: EditorTool = 'select';
  private markerWidth = 14;
  private penWidth = 2;
  private smoothPen = true;
  private holdShapes = false;
  private holdHighlighter = true;
  private loadError = '';
  private loaded = true;
  private fontSize = 14;
  private letterSpacing = 0;
  private lineSpacing = 1.2;
  private textAlignment: 'left' | 'center' | 'right' = 'left';
  private formatPreview?: { name?: string; letterSpacing: number; lineSpacing: number };
  private selected?: string;
  private selectedStroke?: string;
  private focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
  private timer?: number;
  private unsubscribe?: () => void;
  private focusInteraction?: { input: HTMLElement; release: () => void };
  private composing = new Set<HTMLInputElement | HTMLTextAreaElement>();
  private editing?: string;
  private selection?: ObjectSelection;
  private objectScope?: Scope;
  private objectScopeActive = false;
  private windowFocused = true;
  private openingPopover = false;
  private activeBox?: string;
  private answerLines: AnswerLine[] = [];
  private answerFields = new Set<string>();
  private releaseEditing?: () => void;

  /** Attach document-local editing controls and shortcut ownership to the shared session registry. */
  constructor(app: App, native: EditorSurface, sessions: VaultSessions, state?: EditorState) {
    super(); this.app = app; this.native = native; this.sessions = sessions;
    Object.assign(this, sessions.preferences);
    if (state) { this.letterSpacing = state.letterSpacing; this.lineSpacing = state.lineSpacing; this.textAlignment = state.textAlignment; this.textFamily = state.textFamily; this.textColor = state.textColor; this.tool = state.tool; this.fontSize = state.fontSize; this.markerWidth = state.markerWidth; this.penWidth = state.penWidth; this.markerColor = state.markerColor; this.penColor = state.penColor;
      this.selected = state.selected; this.selectedStroke = state.selectedStroke; this.focused = state.focused; }
    const doc = native.element.ownerDocument;
    this.registerDomEvent(doc.defaultView!, 'blur', () => { this.windowFocused = false; this.cancelInteractions(); this.syncObjectScope(); });
    this.registerDomEvent(doc.defaultView!, 'focus', () => { this.windowFocused = true; this.syncObjectScope(); });
    if (app.keymap) {
      const scope = this.objectScope = new Scope(app.scope);
      for (const key of ['c', 'v', 'd']) scope.register(['Mod'], key, event => {
        if (this.claimScopedShortcut(key, event)) return false;
        return undefined;
      });
      for (const redo of [false, true]) scope.register(redo ? ['Mod', 'Shift'] : ['Mod'], 'z', event => this.claimHistoryShortcut(event) ? false : undefined);
      this.register(() => { if (this.objectScopeActive) app.keymap.popScope(scope); });
    }
    this.register(usePdfFont(doc));
    native.element.classList.add('pdf-form-studio-view');
    this.toolbar = doc.createElement('div'); this.toolbar.className = 'pdf-form-studio-toolbar';
    this.toolbar.setAttribute('role', 'toolbar'); this.toolbar.setAttribute('aria-label', 'PDF editor');
    setTooltip(this.toolbar, 'PDF editor', { classes: ['pfs-overlay-tooltip'] });
    const button = (parent: HTMLElement, label: string, icon: string, callback: () => void, tooltip = true): HTMLButtonElement => {
      const element = doc.createElement('button'); element.type = 'button'; element.className = 'clickable-icon pdf-form-studio-icon';
      setIcon(element, icon); setTooltip(element, label, tooltip ? {} : { classes: ['pfs-overlay-tooltip'] });
      this.registerDomEvent(element, 'click', callback); parent.append(element); return element;
    };
    for (const [tool, label, icon] of [
      ['select', 'Select', 'mouse-pointer-2'], ['text', 'Add text box', 'type'],
      ['marker', 'Highlighter', 'highlighter'], ['scribble', 'Pen', 'pencil'], ['eraser', 'Eraser', 'eraser']
    ] as const) {
      this.tools.set(tool, button(this.toolbar, label, icon, () => { if (this.tool === tool) this.closePopover(); else this.setTool(tool); }));
      if (tool === 'text') this.toolbar.append(this.native.answerLineButton());
    }
    this.editControls = doc.createElement('div'); this.editControls.className = 'pdf-form-studio-edit-controls'; this.toolbar.append(this.editControls);
    this.propertiesButton = button(this.editControls, 'Tool settings', 'sliders-horizontal', () => this.openProperties());
    this.propertiesButton.classList.add('pfs-properties-button');
    const settingsIcon = this.propertiesButton.createSpan({ cls: 'pfs-settings-icon', attr: { 'aria-hidden': 'true' } });
    settingsIcon.append(this.propertiesButton.querySelector('svg')!);
    settingsIcon.createSpan({ cls: 'pfs-settings-color' });
    this.propertiesButton.createSpan({ cls: 'pfs-tool-value' });
    this.saveButton = button(this.editControls, 'Save PDF', 'save', () => { void this.save(); }, false);
    this.removeButton = button(this.editControls, 'Remove selection', 'trash-2', () => this.removeSelection(), false);
    this.undoButton = button(this.editControls, 'Undo', 'undo-2', () => this.applyHistory(false), false);
    this.redoButton = button(this.editControls, 'Redo', 'redo-2', () => this.applyHistory(true), false);
    this.undoButton.setAttribute('aria-keyshortcuts', 'Meta+Z Control+Z');
    this.redoButton.setAttribute('aria-keyshortcuts', 'Meta+Shift+Z Control+Shift+Z');
    this.status = doc.createElement('span'); this.status.className = 'pdf-form-studio-status'; this.status.setAttribute('role', 'status');
    this.toolbar.append(this.status);
    const more = button(this.toolbar, 'PDF options', 'ellipsis', () => this.openMenu(more));
    this.message = doc.createElement('div'); this.message.className = 'pdf-form-studio-message';
    this.message.setAttribute('role', 'status');
    this.mountToolbar();
    this.register(() => this.menu?.hide());
    this.registerDomEvent(doc, 'pointerdown', event => {
      if (this.focused && event.target !== this.focused.input) this.focused = undefined;
      const target = event.target;
      if (!(target instanceof doc.defaultView!.Element)) return;
      const inPdf = this.native.element.contains(target), ownControl = this.ownsControl(target);
      if (!ownControl && (!inPdf || target.closest('.pdf-form-studio-box')?.querySelector<HTMLElement>('[data-pdf-field]')?.dataset.pdfField !== this.activeBox)) this.endTextEditing();
      if (!ownControl && (!inPdf || !target.closest('.pdf-form-studio-box, .pdf-form-studio-ink-control'))) {
        this.selected = undefined; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
        const active = doc.activeElement;
        if (active instanceof doc.defaultView!.HTMLElement && [...this.layers.values()].some(entry => entry.layer.contains(active))) active.blur();
      }
    }, true);
    this.registerDomEvent(doc, 'focusin', event => {
      // Keyboard-opened dialogs also move focus deliberately. Never restore
      // a PDF input over the quick switcher, command palette or another note.
      if (this.focused && event.target !== this.focused.input) this.focused = undefined;
      if (event.target instanceof doc.defaultView!.Element && !this.native.element.contains(event.target) && !this.ownsControl(event.target)) {
        this.closePopover();
        this.endTextEditing();
        this.selected = undefined; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
      }
      if (event.target instanceof doc.defaultView!.HTMLElement && this.toolbar.contains(event.target) && this.session) {
        this.releaseFocus(); this.focusInteraction = { input: event.target, release: this.session.beginInteraction() };
      }
      this.syncObjectScope();
    });
    this.registerDomEvent(doc, 'focusout', () => this.syncObjectScope());
    this.registerDomEvent(this.toolbar, 'focusout', event => {
      if (this.focusInteraction?.input === event.target) this.releaseFocus();
      if (this.loaded && this.session?.dirty) this.scheduleSave();
    });
    // Live Preview handles shortcuts before an embedded input's bubble phase.
    // Claim Save at the window capture phase, scoped to this editor's controls.
    this.registerDomEvent(doc.defaultView!, 'keydown', event => {
      const target = event.target;
      if (this.claimHistoryShortcut(event)) return;
      if (event.key === 'Escape' && this.popover?.cancelScrub()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const objectKey = (event.metaKey || event.ctrlKey) && ['c', 'v', 'd'].includes(event.key.toLowerCase());
      if (!this.shortcutTarget(target) && !(objectKey && this.objectShortcutActive())
        && !(target === doc.body && event.key === 'Escape' && this.tool !== 'select')) return;
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && target instanceof doc.defaultView!.HTMLElement
        && target.dataset.pdfField && !event.isComposing && this.navigateAnswerLine(target.dataset.pdfField, event.shiftKey ? -1 : 1)) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (event.key === 'Escape') {
        this.selection?.cancel(); this.selection?.clear();
        for (const entry of this.layers.values()) { entry.ink.cancel(); entry.cancelPlacement?.(); for (const control of entry.controls.values()) control.cancel?.(); }
        this.endTextEditing(); this.selected = undefined; this.selectedStroke = undefined;
        if (target instanceof doc.defaultView!.HTMLElement) target.blur();
        this.updateStatus(); this.refresh(); return;
      }
      if (!(event.metaKey || event.ctrlKey)) {
        if (!this.isTextTarget(target) && !event.altKey) {
          const shortcut: Record<string, EditorTool> = { v: 'select', t: 'text', p: 'scribble', h: 'marker', e: 'eraser' };
          const tool = shortcut[event.key.toLowerCase()]; if (tool) { event.preventDefault(); event.stopPropagation(); this.setTool(tool); }
        }
        return;
      }
      if (event.key.toLowerCase() === 'd' && !event.shiftKey) {
        const objects = this.shortcutObjects(target);
        if (objects.length && this.session) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.repeat) return;
          try { this.selectCreated(this.session.pasteObjects(this.session.copyObjects(objects))); this.scheduleSave(); }
          catch (error) { this.showError(error); }
          return;
        }
      }
      if ((event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'v') && !event.shiftKey && !event.altKey
        && this.shortcutObjects(target).length && (!doc.getSelection()?.toString()
          || target instanceof doc.defaultView!.HTMLElement && target.classList.contains('pdf-form-studio-shortcut-proxy'))) {
        this.claimScopedShortcut(event.key.toLowerCase(), event);
        return;
      }
      if (event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopImmediatePropagation(); void this.save();
      }

    }, true);
    this.registerDomEvent(doc.defaultView!, 'copy', event => {
      const target = event.target;
      if (!(target instanceof doc.defaultView!.Element) || !target.closest('.pdf-form-studio-view')) { copiedObjects = undefined; return; }
      if (!this.shortcutTarget(target)) return;
      if (doc.getSelection()?.toString()) { copiedObjects = undefined; return; }
      const objects = this.shortcutObjects(target);
      if (!objects.length || !this.session || !event.clipboardData) { copiedObjects = undefined; return; }
      try {
        const token = globalThis.crypto.randomUUID(), data = this.session.copyObjects(objects);
        const text = data.filter(item => item.kind === 'text').map(item => item.value).join('\n') || 'PDF Editor elements';
        event.clipboardData.setData(objectClipboardType, token);
        event.clipboardData.setData('text/plain', text);
        event.clipboardData.setData('text/html', objectClipboardHtml(doc, text, token));
        copiedObjects = { token, objects: data, text, custom: true };
        event.preventDefault(); event.stopImmediatePropagation();
      } catch (error) { this.showError(error); }
    }, true);
    this.registerDomEvent(doc.defaultView!, 'cut', () => { copiedObjects = undefined; }, true);
    // Switching windows does not replace the clipboard. Retain the copy so a
    // matching clipboard token can authorize an object paste after returning.
    this.registerDomEvent(doc.defaultView!, 'blur', () => {
      if (copiedObjects) copiedObjects.blurred = true;
      if (!this.selected && !this.selectedStroke && !this.selection?.objects.length) return;
      this.selected = undefined; this.selectedStroke = undefined;
      this.selection?.clear(); this.updateStatus(); this.refresh();
    });
    this.registerDomEvent(doc.defaultView!, 'paste', event => {
      if (!this.shortcutTarget(event.target) || (this.isTextTarget(event.target) && !this.shortcutField(event.target)) || !this.session || !event.clipboardData) return;
      const target = event.target, objects = this.shortcutObjects(target), copy = copiedObjects, session = this.session;
      const focused = doc.activeElement;
      if (!objects.length) return;
      const text = event.clipboardData.getData('text/plain');
      const nativeToken = event.clipboardData.getData(objectClipboardType) || event.clipboardData.getData(webObjectClipboardType);
      const pasteCopy = () => {
        if (!copy || copiedObjects !== copy || !this.loaded || this.session !== session || !this.sameShortcutSelection(target, objects, focused)) return;
        try { this.selectCreated(session.pasteObjects(copy.objects)); this.scheduleSave(); }
        catch (error) { this.showError(error); }
      };
      if (copy && nativeToken === copy.token) {
        event.preventDefault(); event.stopImmediatePropagation(); pasteCopy(); return;
      }
      const pasteText = () => {
        if (!this.loaded || this.session !== session || !this.sameShortcutSelection(target, objects, focused)) return;
        if (this.isTextTarget(target)) return;
        this.pastePlainTextBox(text, objects);
      };
      const clipboard = doc.defaultView!.navigator.clipboard;
      if ((copy?.custom || copy?.write) && typeof clipboard?.read === 'function') {
        // Menu and context-menu paste can deliver only a filtered DataTransfer.
        // The async clipboard still carries our web custom format.
        event.preventDefault(); event.stopImmediatePropagation();
        const answer = target instanceof doc.defaultView!.HTMLInputElement || target instanceof doc.defaultView!.HTMLTextAreaElement
          ? this.shortcutField(target) ? target : undefined : undefined;
        const caret = answer && answer.selectionStart !== null && answer.selectionEnd !== null
          ? { value: answer.value, start: answer.selectionStart, end: answer.selectionEnd } : undefined;
        void (async () => {
          if (copy.write) await copy.write;
          if (copy.custom) try {
            if (await this.clipboardHasObjectToken(clipboard, copy.token)) { pasteCopy(); return; }
          } catch { /* An unreadable token cannot authorize an object paste. */ }
          if (copiedObjects !== copy) return;
          if (copiedObjects === copy) copiedObjects = undefined;
          if (answer && caret && answer.isConnected && answer.ownerDocument.activeElement === answer
            && this.sameShortcutSelection(target, objects, focused)
            && answer.value === caret.value && answer.selectionStart === caret.start && answer.selectionEnd === caret.end) {
            answer.setRangeText(text, caret.start, caret.end, 'end');
            answer.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
          } else pasteText();
        })();
        return;
      }
      copiedObjects = undefined;
      if (!this.isTextTarget(target) && text) { event.preventDefault(); event.stopImmediatePropagation(); pasteText(); }
    }, true);
    this.updateStatus();
    void this.openSession().then(() => { this.updateStatus(); this.refresh(); }).catch(error => {
      if (!this.loaded) return;
      this.loadError = error instanceof Error ? error.message : String(error); this.updateStatus();
    });
  }

  get file() { return this.native.file; }
  captureState(native?: NativePdf): EditorState | undefined {
    return !native || this.native.file === native.file ? { tool: this.tool, letterSpacing: this.letterSpacing, lineSpacing: this.lineSpacing, textAlignment: this.textAlignment, textFamily: this.textFamily, textColor: this.textColor, fontSize: this.fontSize, markerWidth: this.markerWidth, penWidth: this.penWidth, markerColor: this.markerColor, penColor: this.penColor,
      selected: this.selected, selectedStroke: this.selectedStroke, focused: this.focused } : undefined;
  }
  private async openSession(): Promise<void> {
    if (this.session) return;
    this.status.textContent = 'Loading…';
    const session = await this.sessions.get(this.native.file);
    if (!this.loaded || this.session) return;
    this.session = session;
    this.selection = this.addChild(new ObjectSelection(session, this.native.element, {
      enabled: () => this.tool === 'select', changed: () => { this.updateStatus(); this.refresh(); }, save: () => this.scheduleSave(), error: error => this.showError(error),
      floatingToolbar: () => this.floatingToolbarHost(),
      shortcut: (key, event) => this.claimScopedShortcut(key, event),
      endTyping: () => { this.selected = undefined; this.selectedStroke = undefined; this.focused = undefined; this.endTextEditing(); }
    }, this.app));
    this.unsubscribe = session.subscribe(() => { if (session.replacing || session.status === 'conflict') this.closePopover(); this.updateStatus(); this.refresh(); });
  }

  private activateBox(name: string): void {
    if (this.activeBox === name) return;
    this.endTextEditing();
    this.activeBox = name; this.releaseEditing = this.session!.beginTextEdit(name);
  }

  private endTextEditing(retain?: string): void {
    const wasEditing = this.editing; this.editing = undefined;
    const name = this.activeBox;
    if (name !== retain) {
      this.activeBox = undefined; this.releaseEditing?.(); this.releaseEditing = undefined;
      if (name && this.session?.pruneEmptyBoxes(name)) this.scheduleSave();
    }
    if (wasEditing || name) this.refresh();
  }

  private setTool(tool: EditorTool): void {
    if (!this.session || (this.session.status === 'conflict' || this.session.replacing)) return;
    this.closePopover(); this.selection?.cancel(); this.selection?.clear();
    const retain = tool === 'select' || tool === 'text' ? this.activeBox : undefined;
    this.endTextEditing(retain);
    for (const entry of this.layers.values()) { entry.cancelPlacement?.(); entry.ink.finishPending(); for (const control of entry.controls.values()) control.cancel?.(); }
    this.releaseFocus(); this.focused = undefined;
    const active = this.native.element.ownerDocument.activeElement;
    if (active instanceof this.native.element.ownerDocument.defaultView!.HTMLElement && [...this.layers.values()].some(entry => entry.layer.contains(active))) active.blur();
    this.tool = tool; this.selected = retain; this.selectedStroke = undefined;
    this.updateStatus(); this.refresh();
    if (retain) for (const entry of this.layers.values()) entry.controls.get(`${retain}:0`)?.frame.focus({ preventScroll: true });
    if (this.session.dirty) this.scheduleSave();
  }

  /** Detected lines stay transient; clicking or tabbing to one creates a field. */
  setAnswerLines(lines: AnswerLine[]): void {
    this.answerLines = lines.map(line => ({ page: line.page, rect: [...line.rect] as Rect }))
      .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    for (const field of this.session?.snapshot.fields ?? []) if (this.answerLines.some(line => this.answerWidget(field, line) >= 0)) this.answerFields.add(field.name);
    this.refresh();
  }
  private answerWidget(field: TextField, line: AnswerLine): number {
    return field.widgets.findIndex(widget => widget.page === line.page && line.rect[0] < widget.rect[2] && line.rect[2] > widget.rect[0]
      && line.rect[1] < widget.rect[3] && line.rect[3] > widget.rect[1]);
  }
  private navigateAnswerLine(name: string, direction: number): boolean {
    if (!this.session || this.session.replacing || this.session.status === 'conflict') return false;
    const field = this.session.snapshot.fields.find(field => field.name === name);
    if (!field || (!this.answerFields.has(name) && !field.ruled)) return false;
    const index = this.answerLines.findIndex(line => this.answerWidget(field, line) >= 0);
    if (index < 0) return false;
    for (let next = index + direction; next >= 0 && next < this.answerLines.length; next += direction) {
      const line = this.answerLines[next]!;
      const existing = this.session.snapshot.fields.find(field => this.answerWidget(field, line) >= 0);
      if (existing?.readOnly || existing?.name === name) continue;
      this.addSuggestedField(line.page, line.rect, true); return true;
    }
    return false;
  }
  private adoptAdjacentAnswer(line: AnswerLine): TextField | undefined {
    if (!this.session || !this.sessions.preferences.flowAnswerLines) return;
    for (const anchor of this.session.snapshot.fields) {
      if (!anchor.owned || anchor.readOnly || anchor.widgets.length !== 1) continue;
      const widget = anchor.widgets[0]!;
      if (widget.page !== line.page || widget.rotation !== 0) continue;
      const rows = anchor.ruled?.rows ?? 1;
      if (rows > 500) continue;
      const height = widget.rect[3] - widget.rect[1] - (rows - 1) * (anchor.ruled?.spacing ?? 0);
      if (!anchor.ruled && (widget.rect[2] - widget.rect[0] < 100 || height > 35)) continue;
      const anchors: AnswerLine[] = Array.from({ length: rows }, (_, i) => ({ page: line.page,
        rect: [widget.rect[0], widget.rect[3] - height - i * (anchor.ruled?.spacing ?? 0), widget.rect[2], widget.rect[3] - i * (anchor.ruled?.spacing ?? 0)] }));
      const candidates = [...this.answerLines.filter(candidate => candidate.page === line.page && this.answerWidget(anchor, candidate) < 0), ...anchors];
      const block = ruledAnswerBlock(candidates, line, candidate => this.session!.snapshot.fields.some(field => field !== anchor && this.answerWidget(field, candidate) >= 0));
      if (!block || block.layout.rows <= rows || Math.abs(block.rect[3] - widget.rect[3]) > 3) continue;
      const rect: Rect = [widget.rect[0], block.rect[1], widget.rect[2], widget.rect[3]];
      if (this.session.adoptRuledBlock(anchor.name, rect, block.layout)) return anchor;
    }
    return;
  }
  private isTextTarget(target: EventTarget | null): boolean {
    const element = target instanceof this.native.element.ownerDocument.defaultView!.Element ? target : undefined;
    return !!element && !element.classList.contains('pdf-form-studio-shortcut-proxy')
      && !!element.closest('input, textarea, [contenteditable="true"]');
  }
  /** A caret in an owned PDF answer selects the box; highlighted text keeps native clipboard behavior. */
  private shortcutField(target: EventTarget | null): string | undefined {
    const view = this.native.element.ownerDocument.defaultView!;
    if (!(target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement)
      || target.selectionStart !== target.selectionEnd) return;
    const name = target.dataset.pdfField;
    return name && this.session?.snapshot.fields.some(field => field.name === name && field.owned && !field.readOnly && field.widgets.length === 1)
      ? name : undefined;
  }
  private shortcutObjects(target: EventTarget | null): PdfObject[] {
    // Obsidian shares keymap scopes across pop-out windows. Never let a
    // selected PDF consume a shortcut dispatched by another document.
    if (!(target instanceof this.native.element.ownerDocument.defaultView!.Node)) return [];
    const field = this.shortcutField(target);
    if (field) return [{ kind: 'text', id: field }];
    if (target.instanceOf(this.native.element.ownerDocument.defaultView!.HTMLElement) && target.classList.contains('pdf-form-studio-shortcut-proxy')) return this.selectedObjects();
    if (this.isTextTarget(target)) {
      // Settings inputs keep native keyboard editing/copy, even while their PDF object scope is active.
      if (target instanceof this.native.element.ownerDocument.defaultView!.Element && this.ownsControl(target)) return [];
      // Live Preview can keep its note editor as the keyboard target even
      // while the PDF selection owns the active Obsidian shortcut scope.
      return !this.native.element.contains(target) && this.objectShortcutActive() ? this.selectedObjects() : [];
    }
    return this.selectedObjects();
  }
  private objectShortcutActive(): boolean {
    return this.objectScopeActive || !!this.selection?.objects.length;
  }
  /** Apply shared document history for both toolbar and shortcuts, retaining focus after object removal. */
  private applyHistory(redo: boolean): void {
    const doc = this.native.element.ownerDocument, active = doc.activeElement;
    const layer = active instanceof doc.defaultView!.Element && this.native.element.contains(active)
      ? active.closest<HTMLElement>('.pdf-form-studio-layer') : undefined;
    try {
      if (redo) this.session?.redoStroke(); else this.session?.undoStroke();
      this.selectedStroke = undefined; this.updateStatus(); this.refresh(); this.scheduleSave();
      // Removing a focused object must keep the next Undo/Redo in this PDF, not the containing note.
      if (layer?.isConnected && (doc.activeElement === doc.body || !doc.activeElement)) layer.focus({ preventScroll: true });
    } catch (error) { this.showError(error); }
  }
  /** Claim history keys only for this editor, preserving native typing undo and consuming exhausted object history. */
  private claimHistoryShortcut(event: KeyboardEvent): boolean {
    const target = event.target, view = this.native.element.ownerDocument.defaultView!;
    const ownControl = target instanceof view.Element && this.ownsControl(target);
    if (!this.loaded || !this.session || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== 'z'
      || !(target instanceof view.Node) || (!this.shortcutTarget(target) && !ownControl && !this.objectShortcutActive())) return false;
    if (this.isTextTarget(target) && (this.shortcutTarget(target) || ownControl)) {
      // Preserve the browser's text-edit history, while keeping the note's keymap out.
      event.stopImmediatePropagation();
      return false;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    // Consume exhausted/blocked object history too: it must never undo the enclosing note.
    if (!event.repeat && (event.shiftKey ? this.session.canRedoStroke : this.session.canUndoStroke)) this.applyHistory(event.shiftKey);
    return true;
  }
  private claimScopedShortcut(key: string, event: KeyboardEvent): boolean {
    if (key === 'z') return this.claimHistoryShortcut(event);
    const objects = this.shortcutObjects(event.target);
    if (!this.loaded || !this.session || !objects.length || event.shiftKey || event.altKey || event.isComposing) return false;
    const target = event.target;
    const inPdf = target instanceof this.native.element.ownerDocument.defaultView!.Node && this.native.element.contains(target);
    if (inPdf && this.isTextTarget(target) && !this.shortcutField(target)) return false;
    if (key === 'd') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) try { this.selectCreated(this.session.pasteObjects(this.session.copyObjects(objects))); this.scheduleSave(); }
      catch (error) { this.showError(error); }
      return true;
    }
    if (key === 'v' && !copiedObjects) return false;
    const view = this.native.element.ownerDocument.defaultView!;
    const answer = key === 'v' && (target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement)
      && this.shortcutField(target) ? target : undefined;
    const caret = answer && answer.selectionStart !== null && answer.selectionEnd !== null
      ? { value: answer.value, start: answer.selectionStart, end: answer.selectionEnd } : undefined;
    // Obsidian's Live Preview keymap consumes these keys before the browser
    // dispatches copy/paste events for an embedded PDF. Use the system
    // clipboard directly while this PDF owns the active shortcut scope.
    event.preventDefault(); event.stopImmediatePropagation();
    const clipboard = this.native.element.ownerDocument.defaultView?.navigator.clipboard;
    if (key === 'c') {
      try {
        const data = this.session.copyObjects(objects);
        const text = data.filter(item => item.kind === 'text').map(item => item.value).join('\n') || 'PDF Editor elements';
        const copy: ObjectCopy = { token: globalThis.crypto.randomUUID(), objects: data, text, custom: false };
        copiedObjects = copy;
        // A web custom format carries an opaque identity without changing the
        // plain text seen when this answer is pasted into another application.
        const writePlainText = async () => { try { await clipboard?.writeText?.(text); } catch { /* Internal copy still works in restricted contexts. */ } };
        if (clipboard?.write && typeof view.ClipboardItem === 'function') {
          try {
            const item = new view.ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([objectClipboardHtml(this.native.element.ownerDocument, text, copy.token)], { type: 'text/html' }),
              [webObjectClipboardType]: new Blob([copy.token], { type: objectClipboardType })
            });
            copy.write = clipboard.write([item]).then(() => { copy.custom = true; }, writePlainText);
          } catch { copy.write = writePlainText(); }
        } else copy.write = writePlainText();
      } catch (error) { this.showError(error); }
      return true;
    }
    const copy = copiedObjects, session = this.session;
    if (!copy) return false;
    const focused = this.native.element.ownerDocument.activeElement;
    const paste = () => {
      if (copiedObjects !== copy || !this.loaded || this.session !== session || !this.sameShortcutSelection(target, objects, focused)) return;
      try { this.selectCreated(session.pasteObjects(copy.objects)); this.scheduleSave(); }
      catch (error) { this.showError(error); }
    };
    const pasteCurrentText = (value: string) => {
      if (!answer || !caret || !this.loaded || this.session !== session || !answer.isConnected || answer.readOnly
        || !this.sameShortcutSelection(target, objects, focused)
        || answer.ownerDocument.activeElement !== answer || answer.value !== caret.value
        || answer.selectionStart !== caret.start || answer.selectionEnd !== caret.end) return;
      answer.setRangeText(value, caret.start, caret.end, 'end');
      answer.dispatchEvent(new view.Event('input', { bubbles: true }));
    };
    const pasteExternalText = (value: string) => {
      if (answer) { pasteCurrentText(value); return; }
      if (this.loaded && this.session === session && this.sameShortcutSelection(target, objects, focused)) this.pastePlainTextBox(value, objects);
    };
    if (!clipboard?.readText && !clipboard?.read) { if (!copy.blurred) paste(); return true; }
    void (async () => {
      // Clipboard writes and reads can be unavailable in some Obsidian
      // contexts. The window-blur guard still invalidates their fallback.
      if (copy.write) await copy.write;
      if (copiedObjects !== copy) return;
      if (copy.custom && typeof clipboard.read === 'function') {
        try {
          const matches = await this.clipboardHasObjectToken(clipboard, copy.token);
          if (copiedObjects !== copy) return;
          if (matches) { paste(); return; }
        } catch { /* Without a readable token, do not paste a cached PDF object. */ }
        copiedObjects = undefined;
        try { if (clipboard.readText) pasteExternalText(await clipboard.readText()); } catch { /* No readable text to insert. */ }
        return;
      }
      if (copy.blurred) {
        copiedObjects = undefined;
        try { if (clipboard.readText) pasteExternalText(await clipboard.readText()); } catch { /* No readable text to insert. */ }
        return;
      }
      if (!clipboard.readText) { paste(); return; }
      try {
        const current = await clipboard.readText();
        if (copiedObjects !== copy) return;
        if (current !== copy.text) { copiedObjects = undefined; pasteExternalText(current); return; }
      } catch { /* A same-window copy remains usable when read permission is denied. */ }
      paste();
    })();
    return true;
  }
  private syncObjectScope(): void {
    if (!this.objectScope) return;
    const focused = this.native.element.ownerDocument.activeElement;
    // Obsidian's window capture handler runs before ours. Own its public keymap
    // scope for the focused PDF canvas too, even when no object is selected.
    const focusedPdf = !!focused && (this.shortcutTarget(focused) || this.ownsControl(focused));
    const active = this.windowFocused && !!this.session && !this.selection?.objects.length && (!!(this.selected || this.selectedStroke) || focusedPdf);
    if (active === this.objectScopeActive) return;
    this.objectScopeActive = active;
    if (active) this.app.keymap.pushScope(this.objectScope); else this.app.keymap.popScope(this.objectScope);
  }
  private floatingToolbarHost(): HTMLElement | undefined {
    const host = this.native.toolbarHost().parentElement;
    return host?.classList.contains('pfs-floating-toolbar') ? host : undefined;
  }
  private ownsControl(target: Element): boolean {
    return this.toolbar.contains(target) || !!this.popover?.element.contains(target)
      || this.openingPopover && !!target.closest('.pfs-tool-popover');
  }
  private shortcutTarget(target: EventTarget | null): boolean {
    const doc = this.native.element.ownerDocument;
    return target instanceof doc.defaultView!.Node && (this.native.element.contains(target)
      || !!this.floatingToolbarHost()?.contains(target)
      || target === doc.body && !!this.selection?.active);
  }
  private selectedObjects(): PdfObject[] {
    if (this.selection?.objects.length) return [...this.selection.objects];
    if (this.selected && this.session?.snapshot.fields.some(field => field.name === this.selected && field.owned && !field.readOnly)) return [{ kind: 'text', id: this.selected }];
    if (this.selectedStroke && this.session?.snapshot.strokes.some(stroke => stroke.id === this.selectedStroke && !stroke.readOnly)) return [{ kind: 'ink', id: this.selectedStroke }];
    return [];
  }
  private sameShortcutSelection(target: EventTarget | null, objects: PdfObject[], focused: Element | null): boolean {
    const view = this.native.element.ownerDocument.defaultView!;
    if (!(target instanceof view.Node) || !target.isConnected || this.native.element.ownerDocument.activeElement !== focused) return false;
    const current = this.shortcutObjects(target);
    return current.length === objects.length && current.every((object, index) => object.kind === objects[index]!.kind && object.id === objects[index]!.id);
  }
  private async clipboardHasObjectToken(clipboard: Clipboard, token: string): Promise<boolean> {
    const view = this.native.element.ownerDocument.defaultView!;
    for (const item of await clipboard.read()) {
      if (item.types.includes(webObjectClipboardType) && await (await item.getType(webObjectClipboardType)).text() === token) return true;
      if (item.types.includes('text/html')) {
        const html = await (await item.getType('text/html')).text();
        if (new view.DOMParser().parseFromString(html, 'text/html').querySelector('[data-pdf-editor-objects]')
          ?.getAttribute('data-pdf-editor-objects') === token) return true;
      }
    }
    return false;
  }
  private pastePlainTextBox(value: string, objects: PdfObject[]): void {
    if (!value.trim() || !this.session || !objects.length || !this.session.canEditObjects) return;
    try {
      const anchor = this.session.copyObjects(objects)[0];
      if (!anchor) return;
      const bounds = this.session.snapshot.pages[anchor.page - 1]!;
      const width = Math.min(300, bounds[2] - bounds[0]);
      const charactersPerRow = Math.max(1, Math.floor((width - 8) / (this.fontSize * 0.6)));
      const rows = value.split(/\r\n?|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charactersPerRow)), 0);
      const height = Math.min(bounds[3] - bounds[1], Math.max(this.fontSize * 1.4 + 8, rows * this.fontSize * 1.4 + 8));
      const x = Math.max(bounds[0], Math.min(bounds[2] - width, anchor.rect[0]));
      let top = anchor.rect[1] - 12;
      if (top - height < bounds[1]) top = anchor.rect[3] + 12 + height;
      top = Math.max(bounds[1] + height, Math.min(bounds[3], top));
      const rect: Rect = [x, top - height, x + width, top];
      const rotation = this.native.pages().find(page => page.number === anchor.page)?.viewport.rotation ?? 0;
      const text: CopiedPdfObject = { kind: 'text', page: anchor.page, rect, rotation, value,
        fontSize: this.fontSize, fontFamily: this.textFamily, color: [...this.textColor], letterSpacing: this.letterSpacing, lineSpacing: this.lineSpacing, alignment: this.textAlignment, multiline: true };
      this.selectCreated(this.session.pasteObjects([text], [0, 0])); this.scheduleSave();
    } catch (error) { this.showError(error); }
  }
  private clearBrowserSelection(): void { this.native.element.ownerDocument.getSelection()?.removeAllRanges(); }
  private selectCreated(objects: PdfObject[]): void {
    if (!objects.length) return;
    this.endTextEditing();
    this.clearBrowserSelection();
    this.selected = undefined; this.selectedStroke = undefined;
    if (objects.length > 1) this.selection?.selectObjects(objects);
    else {
      this.selection?.clear();
      if (objects[0]!.kind === 'text') this.selected = objects[0]!.id;
      else this.selectedStroke = objects[0]!.id;
    }
    this.updateStatus(); this.refresh();
    if (objects.length === 1 && objects[0]!.kind === 'text') {
      for (const entry of this.layers.values()) entry.controls.get(`${objects[0]!.id}:0`)?.frame.focus({ preventScroll: true });
    }
  }
  /** Reveal an offscreen answer page before mounting its editable field and transferring focus. */
  addSuggestedField(page: number, rect: Rect, scroll = false): void {
    if (!this.session || this.session.replacing || this.session.status === 'conflict') return;
    try {
      if (![...this.layers.values()].some(layer => layer.page.number === page)) { this.native.revealPage?.(page); this.refresh(); }
      const entry = [...this.layers.values()].find(layer => layer.page.number === page);
      if (!entry) return;
      // Filling never arms the tool that creates boxes on arbitrary page clicks.
      const line = { page, rect };
      let field = this.session.snapshot.fields.find(field => this.answerWidget(field, line) >= 0);
      if (field?.readOnly) return;
      this.setTool('select'); this.endTextEditing(field?.name);
      if (!field) field = this.adoptAdjacentAnswer(line);
      if (!field) {
        const block = this.sessions.preferences.flowAnswerLines ? ruledAnswerBlock(this.answerLines, line,
          candidate => this.session!.snapshot.fields.some(existing => this.answerWidget(existing, candidate) >= 0)) : undefined;
        const area = block?.rect ?? rect;
        const firstHeight = area[3] - area[1] - (block ? (block.layout.rows - 1) * block.layout.spacing : 0);
        const size = Math.min(this.fontSize, Math.max(6, (firstHeight - 2) / 1.2));
        field = this.session.add(page, area, size, !!block, 0, block?.layout);
        this.session.formatField(field.name, { fontFamily: this.textFamily, color: this.textColor, alignment: this.textAlignment, letterSpacing: this.letterSpacing, ...(field.ruled ? {} : { lineSpacing: this.lineSpacing }) });
      }
      this.answerFields.add(field.name); this.selected = field.name; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
      const input = entry.controls.get(`${field.name}:${this.answerWidget(field, line)}`)?.input;
      if (scroll) input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      input?.focus({ preventScroll: true });
    } catch (error) { this.showError(error); }
  }

  private formatSelected(format: Partial<TextFormat>, name = this.selected): void {
    if (!name) return;
    try {
      this.session?.formatField(name, format);
      for (const entry of this.layers.values()) for (const control of entry.controls.values()) if (control.input.dataset.pdfField === name) this.growField(entry, control);
      this.scheduleSave();
    } catch (error) { this.showError(error); }
  }
  private rememberPreferences(): void {
    void this.sessions.updatePreferences({ ...this.sessions.preferences, letterSpacing: this.letterSpacing, lineSpacing: this.lineSpacing, textAlignment: this.textAlignment, fontSize: this.fontSize, textFamily: this.textFamily, textColor: this.textColor, penColor: this.penColor, markerColor: this.markerColor, penWidth: this.penWidth, markerWidth: this.markerWidth, smoothPen: this.smoothPen, holdShapes: this.holdShapes, holdHighlighter: this.holdHighlighter }).catch(error => this.showError(error));
  }
  private closePopover(): void { if (this.popover) { this.removeChild(this.popover); this.popover = undefined; } this.propertiesButton.setAttribute('aria-expanded', 'false'); }
  private openProperties(): void {
    if (this.popover) { this.closePopover(); return; }
    if (this.tool === 'marker' || this.tool === 'scribble') { this.openBrushMenu(this.tool, this.propertiesButton); return; }
    const field = this.session?.snapshot.fields.find(field => field.name === this.selected);
    if (!field && this.tool !== 'text') return;
    const session = this.session!, epoch = session.renderEpoch;
    /** History can replace model objects; resolve the captured identity within this session and epoch. */
    const currentField = () => field ? session.snapshot.fields.find(item => item.name === field.name) : undefined;
    let signature: string | undefined;
    const valid = () => this.session === session && session.renderEpoch === epoch && !session.replacing && session.status !== 'conflict'
      && (field ? !!currentField() && (!signature || JSON.stringify(currentField()) === signature) : !this.selected && this.tool === 'text');
    const formatTarget = (format: Partial<TextFormat>) => { if (valid()) this.formatSelected(format, field?.name); };
    let release: (() => void) | undefined;
    const changeSpacing = (letterSpacing: number, lineSpacing: number) => {
      if (!valid()) return;
      this.letterSpacing = letterSpacing; this.lineSpacing = lineSpacing; this.rememberPreferences();
      formatTarget({ letterSpacing, ...(currentField()?.ruled ? {} : { lineSpacing }) }); this.updateStatus();
    };
    this.openingPopover = true;
    try { this.popover = this.addChild(new ToolPopover(this.propertiesButton, {
      title: 'Text', color: field?.color ?? this.textColor,
      changeColor: color => { this.textColor = color; this.rememberPreferences(); formatTarget({ color }); this.updateStatus(); },
      text: { font: field?.fontFamily ?? this.textFamily, size: field?.fontSize ?? this.fontSize, disabled: field?.readOnly,
        alignment: field ? field.alignment ?? 'left' : this.textAlignment,
        align: alignment => { this.textAlignment = alignment; this.rememberPreferences(); formatTarget({ alignment }); },
        spacing: { letter: field ? field.letterSpacing ?? 0 : this.letterSpacing, line: field ? field.lineSpacing ?? 1.2 : this.lineSpacing,
          disabled: field ? !field.owned || field.readOnly : false, lineLocked: !!field?.ruled,
          read: () => {
            const latest = currentField();
            return { letter: field ? latest?.letterSpacing ?? 0 : this.letterSpacing, line: field ? latest?.lineSpacing ?? 1.2 : this.lineSpacing,
              disabled: field ? !latest?.owned || latest.readOnly : false, lineLocked: !!latest?.ruled };
          },
          change: changeSpacing,
          begin: () => {
            if (!valid()) return false;
            if (field) this.selected = field.name;
            signature = field ? JSON.stringify(currentField()) : undefined;
            release = session.beginInteraction();
            const editingSpacing = this.native.element.ownerDocument.activeElement?.matches('.pfs-spacing-value');
            for (const entry of this.layers.values()) for (const control of entry.controls.values()) if (!editingSpacing && this.editing === field?.name && control.input.dataset.pdfField === field?.name) {
              const start = control.input.selectionStart, end = control.input.selectionEnd;
              control.input.focus({ preventScroll: true }); if (start !== null && end !== null) control.input.setSelectionRange(start, end);
            }
            return true;
          },
          preview: (letterSpacing, lineSpacing) => {
            if (!valid()) return false;
            this.formatPreview = { name: field?.name, letterSpacing, lineSpacing }; this.refresh();
            for (const entry of this.layers.values()) for (const control of entry.controls.values()) if (control.input.dataset.pdfField === field?.name) this.growField(entry, control, true);
            return true;
          },
          finish: cancel => {
            const preview = this.formatPreview; this.formatPreview = undefined;
            try { if (!cancel && preview && valid()) changeSpacing(preview.letterSpacing, preview.lineSpacing); }
            finally { signature = undefined; release?.(); release = undefined; this.refresh(); }
          }
        },
        change: (fontFamily, fontSize) => { this.textFamily = fontFamily; this.fontSize = fontSize; this.rememberPreferences(); formatTarget({ fontFamily, fontSize }); this.updateStatus(); } },
      close: () => this.closePopover()
    })); } finally { this.openingPopover = false; }
    this.updateStatus(); this.propertiesButton.setAttribute('aria-expanded', 'true');
  }
  private openBrushMenu(kind: 'marker' | 'scribble', anchor: HTMLElement): void {
    this.closePopover();
    this.openingPopover = true;
    try { this.popover = this.addChild(new ToolPopover(anchor, {
      title: kind === 'marker' ? 'Highlighter' : 'Pen', color: kind === 'marker' ? this.markerColor : this.penColor,
      changeColor: color => { if (kind === 'marker') this.markerColor = color; else this.penColor = color; this.rememberPreferences(); this.updateStatus(); },
      widths: { values: kind === 'marker' ? [8, 14, 22, 30] : [1, 2, 4, 6], value: kind === 'marker' ? this.markerWidth : this.penWidth,
        change: value => { if (kind === 'marker') this.markerWidth = value; else this.penWidth = value; this.rememberPreferences(); this.updateStatus(); } }, close: () => this.closePopover(),
      toggles: kind === 'marker' ? [{ label: 'Hold for straight line', description: 'Pause at the end before lifting.', value: this.holdHighlighter, change: value => { this.holdHighlighter = value; this.rememberPreferences(); } }]
        : [{ label: 'Smooth ink', description: 'Reduce wobble while keeping your handwriting.', value: this.smoothPen, change: value => { this.smoothPen = value; this.rememberPreferences(); } },
          { label: 'Draw & hold shapes', description: 'Lines, rectangles, triangles, circles, ellipses and arrows. Keep holding and drag to resize.', value: this.holdShapes, change: value => { this.holdShapes = value; this.rememberPreferences(); } }]
    })); } finally { this.openingPopover = false; }
    this.updateStatus(); this.propertiesButton.setAttribute('aria-expanded', 'true');
  }

  private removeSelection(): void {
    try {
      if (this.selection?.objects.length) { this.selection.remove(); return; }
      if (this.selectedStroke) { this.session?.deleteStroke(this.selectedStroke); this.selectedStroke = undefined; this.scheduleSave(); }
      else if (this.selected) { this.focused = undefined; this.session?.delete(this.selected, true); this.selected = undefined; this.scheduleSave(); }
      this.updateStatus(); this.refresh();
    } catch (error) { this.showError(error); }
  }

  private showError(error: unknown): void {
    if (!this.loaded) return;
    const message = error instanceof Error ? error.message : String(error);
    if ((this.session?.status === 'conflict' || this.session?.replacing) || this.session?.status === 'error') this.updateStatus();
    else { this.message.textContent = message; this.status.textContent = 'Read only / save failed'; }
    new Notice(message);
  }

  private updateStatus(): void {
    this.syncObjectScope();
    const session = this.session;
    const blocked = session?.status === 'conflict' || !!session?.replacing;
    const selected = session?.snapshot.fields.find(field => field.name === this.selected);
    const brush = this.tool === 'marker' || this.tool === 'scribble';
    this.propertiesButton.disabled = !session || blocked || (!brush && this.tool !== 'text' && !selected) || !!selected?.readOnly;
    const color = brush ? this.tool === 'marker' ? this.markerColor : this.penColor : selected?.color ?? this.textColor;
    this.propertiesButton.style.setProperty('--pdf-tool-color', cssColor(color));
    this.propertiesButton.setAttribute('aria-haspopup', 'dialog');
    const width = brush ? this.tool === 'marker' ? this.markerWidth : this.penWidth : selected?.fontSize ?? this.fontSize;
    this.propertiesButton.setAttribute('aria-label', brush ? 'Brush settings' : 'Text settings');
    this.propertiesButton.querySelector('.pfs-tool-value')!.textContent = `${Number(width.toFixed(1))} pt`;
    for (const [tool, button] of this.tools) {
      if (tool === 'marker' || tool === 'scribble') button.style.setProperty('--pdf-tool-color', cssColor(tool === 'marker' ? this.markerColor : this.penColor));
      button.setAttribute('aria-pressed', String(this.tool === tool)); button.disabled = !session || blocked;
    }
    this.editControls.hidden = false;
    this.native.element.classList.toggle('pdf-form-studio-editing', !!session);
    this.native.element.dataset.pdfTool = this.tool;
    this.saveButton.disabled = !session?.dirty || blocked;
    const stroke = session?.snapshot.strokes.find(stroke => stroke.id === this.selectedStroke);
    this.removeButton.disabled = (!this.selection?.objects.length && !selected?.owned && !stroke) || !!selected?.readOnly || !!stroke?.readOnly || blocked;
    this.removeButton.hidden = false;
    setTooltip(this.removeButton, this.selection?.objects.length ? 'Remove selection' : stroke ? 'Remove mark' : 'Remove text box', { classes: ['pfs-overlay-tooltip'] });
    this.undoButton.disabled = !session?.canUndoStroke || blocked;
    this.redoButton.disabled = !session?.canRedoStroke || blocked;
    const status = session ? ({ saved: 'Saved to PDF', saving: 'Saving…', unsaved: session.drafted ? 'Draft saved locally · Saving PDF…' : 'Unsaved changes', error: 'Save failed', conflict: 'File changed' }[session.status]) : 'Loading…';
    this.status.replaceChildren();
    setIcon(this.status, session?.status === 'saved' ? 'check' : session?.status === 'error' || blocked ? 'triangle-alert' : 'loader-circle');
    this.status.removeAttribute('aria-label'); this.status.dataset.state = session?.status;
    const accessible = this.status.ownerDocument.createElement('span'); accessible.className = 'pdf-form-studio-sr-only'; accessible.textContent = status;
    this.status.append(accessible);
    { accessible.className = 'pfs-save-label'; accessible.textContent = session?.status === 'saved' ? 'Saved' : session?.status === 'saving' ? 'Saving…' : session?.status === 'unsaved' ? 'Unsaved' : status; }
    this.message.textContent = session?.error || this.loadError;
    this.message.classList.toggle('is-error', !!this.loadError || session?.status === 'error' || blocked);
  }

  private mountToolbar(): void {
    const host = this.native.toolbarHost();
    this.toolbar.classList.toggle('is-fallback', !host);
    if (host) host.append(this.toolbar);
    else this.native.element.prepend(this.toolbar);
    this.native.element.prepend(this.message);
  }

  private openMenu(anchor: HTMLElement): void {
    this.menu?.hide();
    const menu = this.menu = new Menu();
    const release = this.session?.beginInteraction(); menu.onHide(() => release?.());
    const file = this.native.file;
    const original = this.sessions.backupFor(file); const recovery = this.sessions.backupFor(file, 'recovery');
    const blocked = (this.session?.status === 'conflict' || this.session?.replacing) || this.session?.status === 'saving';
    menu.addItem(item => item.setTitle('Floating toolbar').setIcon('pin').setChecked(this.sessions.preferences.floatingToolbar)
      .onClick(() => { void this.sessions.updatePreferences({ ...this.sessions.preferences, floatingToolbar: !this.sessions.preferences.floatingToolbar })
        .catch(error => this.showError(error)); }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('Reload PDF').setIcon('refresh-cw').setDisabled(!this.session).onClick(() => this.requestReload()));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('Recovery copies…').setIcon('shield-check').onClick(() => { const modal = new RecoveryInfo(this.app, this.sessions, file); this.register(() => modal.close()); modal.open(); }));
    menu.addItem(item => item.setTitle('Preview original PDF').setIcon('folder-open').setDisabled(!original).onClick(() => {
      if (original) { const modal = new RecoveryPreview(this.app, () => this.sessions.readRecovery(file)); this.register(() => modal.close()); modal.open(); }
    }));
    menu.addItem(item => item.setTitle('Restore original backup…').setIcon('history').setDisabled(!original || blocked).onClick(() => this.requestRestore('original')));
    menu.addItem(item => item.setTitle('Undo last restore…').setIcon('undo-2').setDisabled(!recovery || blocked).onClick(() => this.requestRestore('recovery')));
    const bounds = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, anchor.ownerDocument);
  }

  private requestRestore(kind: BackupKind): void {
    const modal = new Modal(this.app); this.register(() => modal.close());
    const action = kind === 'original' ? 'Restore original backup' : 'Undo last restore';
    modal.setTitle(action + '?');
    modal.contentEl.createEl('p', { text: 'This replaces the PDF and discards pending edits. The current saved PDF is kept in the restore recovery slot first, so this action can be reversed.' });
    const confirm = modal.contentEl.createEl('button', { text: action, cls: 'mod-warning' });
    confirm.addEventListener('click', () => { modal.close(); this.focused = undefined; void this.sessions.restore(this.native.file, kind).catch(error => this.showError(error)); });
    modal.open();
  }

  private scheduleSave(): void {
    if (this.timer !== undefined) this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    this.timer = this.native.element.ownerDocument.defaultView!.setTimeout(() => {
      this.timer = undefined;
      void this.session?.checkpoint().then(() => this.session?.save()).catch(error => this.showError(error));
    }, 900);
  }

  private releaseFocus(): void { this.focusInteraction?.release(); this.focusInteraction = undefined; }

  private async save(): Promise<void> {
    if (this.timer !== undefined) { this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer); this.timer = undefined; }
    try { await this.session?.save(); } catch (error) { this.showError(error); }
  }

  private requestReload(): void {
    if (!this.session) return;
    const reload = () => { void this.session!.reload().catch(error => this.showError(error)); };
    if (!this.session.dirty) { reload(); return; }
    const modal = new Modal(this.app);
    this.register(() => modal.close());
    modal.setTitle('Reload this PDF?');
    modal.contentEl.createEl('p', { text: 'Reloading discards the pending text and marks shown here and reads the current PDF from disk.' });
    const button = modal.contentEl.createEl('button', { text: 'Reload and discard pending edits', cls: 'mod-warning' });
    button.addEventListener('click', () => { modal.close(); reload(); });
    modal.open();
  }

  /** Mount nearby pages plus focused, selected or interacting pages without changing the shared model. */
  refresh(): void {
    if (!this.loaded) return;
    // Obsidian may replace toolbar content while refreshing a file.
    if (this.native.element.isConnected && (!this.toolbar.isConnected || this.toolbar.parentElement !== (this.native.toolbarHost() ?? this.native.element))) this.mountToolbar();
    const allPages = this.native.pages(), nearby = this.native.editablePages?.() ?? allPages;
    const requested = new Set(nearby.map(page => page.div)), all = new Set(allPages.map(page => page.div));
    const active = this.native.element.ownerDocument.activeElement;
    const selected = new Set(this.selectedObjects().map(object => `${object.kind}:${object.id}`));
    const retained = new Set<number>(this.selection?.gesturePage ? [this.selection.gesturePage] : []);
    for (const field of this.session?.snapshot.fields ?? []) if (field.owned && field.widgets.length === 1 && selected.has(`text:${field.name}`)) retained.add(field.widgets[0]!.page);
    for (const stroke of this.session?.snapshot.strokes ?? []) if (selected.has(`ink:${stroke.id}`)) retained.add(stroke.page);
    for (const entry of this.layers.values()) if (all.has(entry.page.div) && (retained.has(entry.page.number) || !!active && entry.layer.contains(active)
      || entry.placing?.() || entry.ink.interacting || [...entry.controls.values()].some(control => control.preview))) requested.add(entry.page.div);
    const pages = allPages.filter(page => requested.has(page.div));
    const resume = this.focused && !this.focused.input.isConnected ? this.focused : undefined;
    const alive = new Set(pages.map(page => page.div));
    for (const [div, entry] of this.layers) if (!alive.has(div) || !entry.layer.isConnected) {
      if (this.focusInteraction && entry.layer.contains(this.focusInteraction.input)) this.releaseFocus();
      entry.cancelPlacement?.();
      this.removeChild(entry.ink);
      for (const control of entry.controls.values()) control.dispose?.();
      entry.layer.remove(); this.layers.delete(div);
    }
    if (!this.session) return;
    for (const page of pages) {
      let entry = this.layers.get(page.div);
      if (!entry) {
        const layer = page.div.ownerDocument.createElement('div'); layer.className = 'pdf-form-studio-layer';
        layer.tabIndex = -1;
        page.div.append(layer);
        const ink = this.addChild(new InkLayer(page, layer, this.session, {
          tool: () => this.tool, width: kind => kind === 'marker' ? this.markerWidth : this.penWidth, color: kind => kind === 'marker' ? this.markerColor : this.penColor, selected: () => this.selectedStroke,
          smooth: () => this.smoothPen, shapes: () => this.holdShapes, straightHold: () => this.holdHighlighter,
          select: id => { if (id) this.clearBrowserSelection(); this.selection?.clear(); this.selectedStroke = id; this.selected = undefined; this.focused = undefined; this.updateStatus(); this.refresh(); },
          start: () => {
            this.focused = undefined; this.selected = undefined; this.selectedStroke = undefined;
            const active = layer.ownerDocument.activeElement;
            if (active instanceof layer.ownerDocument.defaultView!.HTMLElement && this.native.element.contains(active)) active.blur();
            this.updateStatus();
          },
          changed: () => { if (this.session?.dirty) this.scheduleSave(); },
          remove: id => { this.selectedStroke = id; this.removeSelection(); }, error: error => this.showError(error)
        }));
        entry = { page, layer, controls: new Map(), ink }; this.layers.set(page.div, entry); this.bindPlacement(entry);
      }
      entry.page = page;
      entry.layer.dataset.tool = this.tool;
      entry.ink.update(page);
      const fieldWidgets = this.session.snapshot.fields.filter(field => !field.readOnly).flatMap(field => field.widgets.flatMap((widget, index) =>
        widget.page === page.number ? [{ field, widget, key: `${field.name}:${index}` }] : []));
      const keys = new Set(fieldWidgets.map(({ key }) => key));
      for (const [key, control] of entry.controls) if (!keys.has(key)) {
        if (this.focusInteraction && control.frame.contains(this.focusInteraction.input)) this.releaseFocus();
        this.composing.delete(control.input); control.dispose?.();
        control.frame.remove(); entry.controls.delete(key);
      }
      // Add only the new widget. Replacing the whole layer blurs the previous
      // input mid-tap, loses caret/IME state and can start an unwanted PDF write.
      for (const { field, widget, key } of fieldWidgets) {
        let control = entry.controls.get(key);
        if (!control) { this.mountField(entry, field, key); control = entry.controls.get(key)!; }
        if (!control.preview) this.positionField(entry, control, field, widget.rect, widget.rotation, widget);
        if (!this.composing.has(control.input) && control.input.value !== field.value) control.input.value = field.value;
        control.input.disabled = field.readOnly;
        control.input.readOnly = (this.session.status === 'conflict' || this.session.replacing) || this.editing !== field.name;
        const drawing = this.tool === 'marker' || this.tool === 'scribble' || this.tool === 'eraser';
        control.input.tabIndex = !drawing && this.editing === field.name ? 0 : -1;
        control.frame.tabIndex = drawing ? -1 : 0;
        control.frame.classList.toggle('is-answer-field', this.answerFields.has(field.name) || !!field.ruled);
        if (this.answerFields.has(field.name) || field.ruled) labelOverlay(control.frame, field.ruled ? 'Ruled answer block. Click to edit; text wraps along the printed lines.' : 'Detected answer. Click to edit; Tab or Shift+Tab to change answer lines.');
        control.frame.classList.toggle('is-editing', this.editing === field.name);
        control.frame.classList.toggle('is-empty', !field.value.trim());
        control.frame.classList.toggle('is-selected', field.name === this.selected);
        control.frame.classList.toggle('is-locked', (this.session.status === 'conflict' || this.session.replacing) || field.readOnly || (field.owned && field.widgets.length !== 1));
      }
      // Explicit reload/recovery can replace pages. Restore focus only when
      // the user has not deliberately moved it elsewhere.
      const active = page.div.ownerDocument.activeElement;
      if (resume?.page === page.number && this.tool !== 'marker' && this.tool !== 'scribble' && this.tool !== 'eraser' && (!active || active === page.div.ownerDocument.body || active === resume.input)) {
        const input = [...entry.controls.values()].find(control => control.input.dataset.pdfField === resume.name)?.input;
        if (input && !input.disabled) {
          const start = resume.input.selectionStart; const end = resume.input.selectionEnd;
          input.focus({ preventScroll: true });
          if (start !== null && end !== null) input.setSelectionRange(start, end);
        }
      }
    }
    this.selection?.update(pages);
    this.popover?.refreshSpacing();
  }

  private positionField(entry: PageLayer, control: FieldControl, field: TextField, rect: Rect, rotation: number, widget?: TextWidget): void {
    if (this.formatPreview?.name === field.name) field = { ...field, ...this.formatPreview };
    const { frame, input } = control;
    const [left, top, right, bottom] = screenRectangle(entry.page.viewport, rect);
    // PDF widget appearance rotation is counterclockwise; viewport/CSS is clockwise.
    const angle = ((entry.page.viewport.rotation - rotation) % 360 + 360) % 360;
    frame.style.left = `${angle === 90 || angle === 180 ? right : left}px`;
    frame.style.top = `${angle === 180 || angle === 270 ? bottom : top}px`;
    frame.style.width = `${angle === 90 || angle === 270 ? bottom - top : right - left}px`;
    frame.style.height = `${angle === 90 || angle === 270 ? right - left : bottom - top}px`;
    frame.style.transform = `rotate(${angle}deg)`;
    input.style.fontFamily = `'${fontFaces[field.fontFamily]}', ${field.fontFamily === 'serif' ? 'serif' : field.fontFamily === 'mono' ? 'monospace' : 'sans-serif'}`;
    const color = widget?.color ?? field.color, size = widget?.fontSize ?? field.fontSize;
    input.style.color = cssColor(color); input.style.caretColor = cssColor(color);
    input.style.fontSize = `${size * entry.page.viewport.scale}px`;
    input.style.textAlign = field.alignment ?? 'left';
    const appearance = widget?.appearance;
    frame.style.backgroundColor = appearance?.backgroundColor ? cssColor(appearance.backgroundColor) : '';
    frame.style.borderColor = appearance?.borderColor ? cssColor(appearance.borderColor) : 'transparent';
    frame.style.borderStyle = appearance?.borderStyle === 'underline' ? 'solid' : appearance?.borderStyle ?? 'solid';
    const borderWidth = Math.max(0, appearance?.borderWidth ?? 0) * entry.page.viewport.scale;
    frame.style.borderWidth = appearance?.borderStyle === 'underline' ? `0 0 ${borderWidth}px` : `${borderWidth}px`;
    input.style.padding = `${entry.page.viewport.scale}px`;
    const offset = field.ruled ? Math.max(0, (field.ruled.spacing - field.fontSize * 1.2) / 2) * entry.page.viewport.scale : 0;
    input.style.lineHeight = field.ruled ? `${field.ruled.spacing * entry.page.viewport.scale}px` : String(field.lineSpacing ?? 1.2);
    input.style.letterSpacing = `${(field.letterSpacing ?? 0) * entry.page.viewport.scale}px`;
    input.style.position = field.ruled ? 'relative' : '';
    input.style.top = field.ruled ? `${-offset}px` : '';
    input.style.height = field.ruled ? `calc(100% + ${offset * 2}px)` : '';
    input.style.clipPath = field.ruled ? `inset(${offset}px 0 ${offset}px 0)` : '';
  }

  private mountField(entry: PageLayer, field: TextField, key: string): void {
    const doc = entry.layer.ownerDocument;
    const frame = doc.createElement('div'); frame.className = 'pdf-form-studio-box';
    frame.classList.toggle('is-added', field.owned);
    frame.classList.toggle('is-form-field', !field.owned);
    const input = field.owned || field.multiline ? doc.createElement('textarea') : doc.createElement('input');
    const control: FieldControl = { frame, input };
    if (input instanceof doc.defaultView!.HTMLInputElement) input.type = 'text';
    input.className = 'pdf-form-studio-field'; input.dataset.pdfField = field.name;
    input.value = field.value;
    if (field.owned) input.placeholder = ' ';
    input.spellcheck = false;
    if (field.maxLength !== undefined) input.maxLength = field.maxLength;
    input.addEventListener('focus', () => {
      this.activateBox(field.name); this.editing = field.name;
      this.releaseFocus();
      this.focusInteraction = { input, release: this.session!.beginInteraction() };
      this.focused = { input, page: entry.page.number, name: field.name };
      input.readOnly = this.session?.status === 'conflict' || !!this.session?.replacing;
      this.selected = field.name; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
    });
    input.addEventListener('input', event => {
      if ((event as InputEvent).isComposing) return;
      try { this.session!.setValue(field.name, input.value); this.growField(entry, control); this.scheduleSave(); } catch (error) { this.showError(error); }
    });
    input.addEventListener('compositionend', () => {
      this.composing.delete(input);
      try { this.session!.setValue(field.name, input.value); this.growField(entry, control); this.scheduleSave(); } catch (error) { this.showError(error); }
    });
    input.addEventListener('compositionstart', () => {
      this.composing.add(input);
      if (this.timer !== undefined) { doc.defaultView!.clearTimeout(this.timer); this.timer = undefined; }
    });
    input.addEventListener('blur', () => {
      // Explicit clicks, Tab and Escape clear the focus record; retain it when
      // a document reload detaches this control before replacement.
      if (this.focusInteraction?.input === input) this.releaseFocus();
      if (this.loaded && this.session?.dirty && this.session.status !== 'conflict') this.scheduleSave();
    });
    input.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      // Keep Obsidian's note editor from handling typing inside the PDF.
      event.stopPropagation();
      if (key.key === 'Tab' || key.key === 'Escape') this.focused = undefined;
      if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === 's') { event.preventDefault(); void this.save(); }
      if (key.key === 'Escape') { input.blur(); }
    });
    frame.append(input); labelOverlay(input, field.owned ? 'PDF answer' : field.name); entry.layer.append(frame); entry.controls.set(key, control);
    control.dispose = this.bindBox(entry, control, field.name);
  }

  /** Measure editor wrapping with PDF glyph advances, previewing spacing without committing geometry. */
  private growField(entry: PageLayer, control: FieldControl, preview = false): void {
    let field = this.session?.snapshot.fields.find(field => field.name === control.input.dataset.pdfField);
    if (!field?.owned || field.readOnly || field.widgets.length !== 1 || (this.session?.status === 'conflict' || this.session?.replacing) || this.composing.has(control.input)) return;
    if (preview && this.formatPreview?.name === field.name) field = { ...field, ...this.formatPreview };
    const widget = field.widgets[0]!;
    const doc = control.input.ownerDocument;
    const style = doc.defaultView!.getComputedStyle(control.input);
    // Measure a separate textarea so fitting never disturbs the real caret,
    // scroll position, composition or native text undo history.
    const measure = doc.createElement('textarea'); measure.value = control.input.value;
    Object.assign(measure.style, {
      position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
      width: style.width, height: '0', minHeight: '0', maxHeight: 'none', minWidth: '0',
      fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
      fontKerning: style.fontKerning, fontVariantLigatures: style.fontVariantLigatures,
      lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, padding: style.padding, border: '0', boxSizing: 'border-box',
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden', margin: '0'
    });
    measure.tabIndex = -1; measure.setAttribute('aria-hidden', 'true'); doc.body.append(measure);
    const height = Math.max(measure.scrollHeight + 1, (field.fontSize * (field.lineSpacing ?? 1.2) + 2) * entry.page.viewport.scale);
    const widthOverflow = measure.scrollWidth > measure.clientWidth + 1;
    measure.remove();
    const viewport = entry.page.viewport;
    const angle = ((viewport.rotation - widget.rotation) % 360 + 360) % 360;
    // scrollHeight is rounded to screen pixels; count whole rows before
    // comparing so fractional zoom cannot create a spare row/false warning.
    const measuredRows = field.ruled ? Math.max(1, Math.round((height / viewport.scale - 2) / field.ruled.spacing)) : 0;
    if (field.ruled && !preview) this.session!.fitRuledField(field.name, measuredRows);
    if (!field.ruled) {
      const screen = growBox(screenRectangle(viewport, widget.rect), [0, 0, viewport.width, viewport.height], height, angle);
      const rect = pdfRectangle(viewport, [screen[0], screen[1]], [screen[2], screen[3]]);
      if (preview) this.positionField(entry, control, field, rect, widget.rotation);
      else this.session!.updateBox(field.name, rect, { multiline: true });
    }
    const overflow = widthOverflow || (field.ruled ? measuredRows > field.ruled.rows : height / viewport.scale > widget.rect[3] - widget.rect[1] + 1);
    control.frame.classList.toggle('is-overflow', overflow);
    if (overflow) control.frame.setAttribute('aria-description', 'Text exceeds the box or page edge. Widen the box or reduce the text size.');
    else control.frame.removeAttribute('aria-description');
  }

  private bindBox(entry: PageLayer, control: FieldControl, name: string): () => void {
    const { frame, input } = control;
    const doc = frame.ownerDocument;
    frame.tabIndex = 0; frame.setAttribute('role', 'group');
    // Live Preview does not reliably deliver Cmd shortcuts to a focused div.
    // A read-only input receives them without entering answer-text editing.
    const shortcutProxy = doc.createElement('textarea');
    shortcutProxy.className = 'pdf-form-studio-shortcut-proxy'; shortcutProxy.readOnly = true; shortcutProxy.tabIndex = -1;
    shortcutProxy.setAttribute('aria-label', 'Selected PDF text box');
    frame.append(shortcutProxy);
    const owned = this.session!.snapshot.fields.find(field => field.name === name)!.owned;
    labelOverlay(frame, owned ? 'Text box. Click to select, drag to move, double-click or Enter to edit, Backspace to delete.' : 'Form field. Click to edit.');
    const labels: Record<ResizeHandle, string> = {
      n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left'
    };
    for (const handle of (owned ? Object.keys(labels) : []) as ResizeHandle[]) {
      const button = doc.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.className = 'pdf-form-studio-handle'; button.dataset.resize = handle;
      labelOverlay(button, `Resize text box from ${labels[handle]}`); frame.append(button);
    }
    for (const edge of owned ? ['n', 'e', 's', 'w'] : []) {
      const border = doc.createElement('div'); border.className = 'pdf-form-studio-move-edge'; border.dataset.edge = edge;
      border.setAttribute('aria-hidden', 'true'); frame.append(border);
    }
    const select = () => {
      this.clearBrowserSelection();
      this.selection?.clear();
      this.selected = name; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
    };
    frame.addEventListener('focus', () => {
      if (!owned && this.session?.status !== 'conflict' && !this.session?.replacing) { input.focus({ preventScroll: true }); return; }
      this.activateBox(name); this.endTextEditing(name);
      select(); shortcutProxy.focus({ preventScroll: true });
    });
    shortcutProxy.addEventListener('focus', () => {
      this.releaseFocus(); this.focusInteraction = { input: shortcutProxy, release: this.session!.beginInteraction() };
      select();
    });
    frame.addEventListener('blur', () => {
      if (this.loaded && this.session?.dirty) this.scheduleSave();
    });
    shortcutProxy.addEventListener('blur', () => {
      if (this.focusInteraction?.input === shortcutProxy) this.releaseFocus();
      if (this.loaded && this.session?.dirty) this.scheduleSave();
    });
    frame.addEventListener('focusout', () => {
      // Focus can move from textarea to its frame/handles during a drag. Only
      // leaving the whole box ends its lifetime; toolbar formatting also retains it.
      queueMicrotask(() => {
        const active = doc.activeElement;
        if (this.loaded && this.activeBox === name && active !== doc.body && active !== doc.documentElement && !(active && (frame.contains(active) || this.toolbar.contains(active)
          || (active?.instanceOf(doc.defaultView!.Element) && active.closest('.pfs-tool-popover'))))) this.endTextEditing();
      });
    });
    frame.addEventListener('dblclick', event => {
      if (doc.activeElement === input || (this.session?.status === 'conflict' || this.session?.replacing) || (event.target as HTMLElement).dataset.resize) return;
      event.preventDefault(); event.stopPropagation(); input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    const point = (event: PointerEvent): [number, number] => {
      const box = entry.layer.getBoundingClientRect();
      return [(event.clientX - box.left) * entry.page.viewport.width / box.width, (event.clientY - box.top) * entry.page.viewport.height / box.height];
    };
    const signature = () => [entry.page.viewport.width, entry.page.viewport.height, entry.page.viewport.rotation].join(':');
    let gesture: { pointer: number; start: [number, number]; rect: Rect; handle?: ResizeHandle; signature: string; release: () => void } | undefined;
    const cancel = (repaint = true) => {
      const previous = gesture; gesture = undefined; control.preview = undefined;
      previous?.release();
      if (previous && frame.hasPointerCapture(previous.pointer)) frame.releasePointerCapture(previous.pointer);
      if (previous && this.loaded && repaint) this.refresh();
    };
    frame.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.tool === 'marker' || this.tool === 'scribble' || this.tool === 'eraser' || (this.session?.status === 'conflict' || this.session?.replacing)) return;
      if (event.target === input && this.editing === name) return;
      const field = this.session?.snapshot.fields.find(field => field.name === name);
      if (!field || field.readOnly) return;
      if ((!owned || this.answerFields.has(name) || field.ruled) && !event.shiftKey && !(event.target as HTMLElement).closest('[data-resize], [data-edge]')) {
        event.preventDefault(); event.stopPropagation(); this.selection?.clear(); input.focus({ preventScroll: true }); return;
      }
      event.preventDefault(); event.stopPropagation(); select(); frame.focus({ preventScroll: true });
      if (!owned || field.widgets.length !== 1 || !this.session!.snapshot.fields.includes(field)) return;
      const viewport = entry.page.viewport; const widget = field.widgets[0]!;
      const handle = (event.target as HTMLElement).dataset.resize as ResizeHandle | undefined;
      event.preventDefault(); event.stopPropagation(); cancel();
      gesture = { pointer: event.pointerId, start: point(event), rect: screenRectangle(viewport, widget.rect),
        handle: handle ? rotatedHandle(handle, viewport.rotation - widget.rotation) : undefined,
        signature: signature(), release: this.session!.beginInteraction() };
      select(); frame.focus({ preventScroll: true }); frame.setPointerCapture(event.pointerId);
    });
    frame.addEventListener('pointermove', event => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      if (gesture.signature !== signature()) { cancel(); return; }
      const field = this.session!.snapshot.fields.find(field => field.name === name)!;
      const widget = field.widgets[0]!; const viewport = entry.page.viewport; const end = point(event);
      if (!control.preview && Math.hypot(end[0] - gesture.start[0], end[1] - gesture.start[1]) < 3) return;
      const angle = ((viewport.rotation - widget.rotation) % 360 + 360) % 360;
      const minimum = this.session!.minimumTextBoxSize(name).map(value => value * viewport.scale) as [number, number];
      if (angle === 90 || angle === 270) minimum.reverse();
      control.preview = transformBox(gesture.rect, [0, 0, viewport.width, viewport.height], [end[0] - gesture.start[0], end[1] - gesture.start[1]], gesture.handle, minimum);
      this.positionField(entry, control, field, pdfRectangle(viewport, [control.preview[0], control.preview[1]], [control.preview[2], control.preview[3]]), widget.rotation);
    });
    frame.addEventListener('pointerup', event => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      try {
        if (control.preview && signature() === gesture.signature) {
          const rect = control.preview; control.preview = undefined;
          this.session!.updateBox(name, pdfRectangle(entry.page.viewport, [rect[0], rect[1]], [rect[2], rect[3]]), { multiline: true });
          this.growField(entry, control); this.scheduleSave();
        }
      } catch (error) { this.showError(error); }
      finally { cancel(); }
    });
    frame.addEventListener('pointercancel', () => cancel());
    frame.addEventListener('lostpointercapture', () => { if (gesture && !frame.hasPointerCapture(gesture.pointer)) cancel(); });
    frame.addEventListener('keydown', event => {
      if (event.target !== frame && event.target !== shortcutProxy) return;
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); input.focus({ preventScroll: true }); return; }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); this.selected = undefined; frame.blur(); this.updateStatus(); this.refresh(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.save(); return; }
      const field = this.session?.snapshot.fields.find(field => field.name === name);
      if (!field?.owned || field.readOnly || field.widgets.length !== 1 || (this.session?.status === 'conflict' || this.session?.replacing)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); this.session?.delete(name, true); this.selected = undefined; this.scheduleSave(); return;
      }
      const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = direction[event.key];
      if (!delta) return;
      event.preventDefault();
      const widget = field.widgets[0]!;
      const viewport = entry.page.viewport; const step = viewport.scale * (event.shiftKey ? 10 : 1);
      const handle = event.altKey ? (delta[0] ? 'e' : 's') : undefined;
      const minimum = this.session!.minimumTextBoxSize(name).map(value => value * viewport.scale) as [number, number];
      const angle = ((viewport.rotation - widget.rotation) % 360 + 360) % 360;
      if (angle === 90 || angle === 270) minimum.reverse();
      const rect = transformBox(screenRectangle(viewport, widget.rect), [0, 0, viewport.width, viewport.height], [delta[0] * step, delta[1] * step], handle,
        minimum);
      this.session!.updateBox(name, pdfRectangle(viewport, [rect[0], rect[1]], [rect[2], rect[3]]));
      if (handle) this.growField(entry, control);
      this.scheduleSave();
    });
    control.cancel = () => cancel(); return () => cancel(false);
  }

  private bindPlacement(entry: PageLayer): void {
    let start: [number, number] | undefined;
    let pointer: number | undefined;
    let preview: HTMLElement | undefined;
    let release: (() => void) | undefined;
    const point = (event: PointerEvent): [number, number] => {
      const box = entry.layer.getBoundingClientRect();
      return [Math.max(0, Math.min(entry.page.viewport.width, (event.clientX - box.left) * entry.page.viewport.width / box.width)),
        Math.max(0, Math.min(entry.page.viewport.height, (event.clientY - box.top) * entry.page.viewport.height / box.height))];
    };
    entry.layer.addEventListener('pointerdown', event => {
      if (event.target !== entry.layer || event.button !== 0 || this.tool !== 'text' || !this.session || (this.session.status === 'conflict' || this.session.replacing)) return;
      event.preventDefault(); event.stopPropagation(); start = point(event); pointer = event.pointerId;
      release?.(); release = this.session?.beginInteraction();
      entry.layer.setPointerCapture(event.pointerId);
    });
    entry.layer.addEventListener('pointermove', event => {
      if (!start || pointer !== event.pointerId) return;
      const end = point(event);
      if (Math.abs(end[0] - start[0]) < 12 && Math.abs(end[1] - start[1]) < 12) return;
      if (!preview) { preview = entry.layer.ownerDocument.createElement('div'); preview.className = 'pdf-form-studio-placement'; entry.layer.append(preview); }
      Object.assign(preview.style, { left: `${Math.min(start[0], end[0])}px`, top: `${Math.min(start[1], end[1])}px`,
        width: `${Math.abs(end[0] - start[0])}px`, height: `${Math.abs(end[1] - start[1])}px` });
    });
    entry.layer.addEventListener('pointerup', event => {
      if (pointer !== event.pointerId || !start || !this.session) return;
      event.preventDefault(); event.stopPropagation();
      const end = point(event);
      const dragged = Math.abs(end[0] - start[0]) > 12 || Math.abs(end[1] - start[1]) > 12;
      const scale = entry.page.viewport.scale;
      let screenEnd: [number, number] = end;
      let screenStart: [number, number] = start;
      if (!dragged) {
        screenStart = [start[0], Math.max(0, start[1] - this.fontSize * scale)];
        screenEnd = [Math.min(entry.page.viewport.width, start[0] + 240 * scale), Math.min(entry.page.viewport.height, start[1] + 6 * scale)];
      }
      const rect = pdfRectangle(entry.page.viewport, screenStart, screenEnd);
      start = undefined; pointer = undefined;
      preview?.remove(); preview = undefined;
      try {
        if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) return;
        const field = this.session.add(entry.page.number, rect, this.fontSize, true, entry.page.viewport.rotation);
        this.session.formatField(field.name, { fontFamily: this.textFamily, color: this.textColor, alignment: this.textAlignment, letterSpacing: this.letterSpacing, ...(field.ruled ? {} : { lineSpacing: this.lineSpacing }) });
        this.setTool('select');
        this.selected = field.name; this.selectedStroke = undefined; this.updateStatus(); this.refresh();
        entry.controls.get(`${field.name}:0`)?.input.focus({ preventScroll: true });
        // A blank box stays in the shared model while focused. Its eventual
        // blur, typing, explicit save or closing the editor commits it.
      } catch (error) { this.showError(error); }
      finally {
        release?.(); release = undefined;
        if (entry.layer.hasPointerCapture(event.pointerId)) entry.layer.releasePointerCapture(event.pointerId);
      }
    });
    const cancel = () => { start = undefined; pointer = undefined; preview?.remove(); preview = undefined; release?.(); release = undefined; };
    entry.layer.addEventListener('pointercancel', cancel); entry.layer.addEventListener('lostpointercapture', cancel);
    entry.cancelPlacement = cancel; entry.placing = () => !!start;
  }

  onunload(): void {
    this.closePopover(); this.selection?.cancel(); this.selection?.clear();
    this.endTextEditing();
    for (const entry of this.layers.values()) entry.ink.finishPending();
    this.loaded = false;
    this.releaseFocus();
    if (this.timer !== undefined) this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    this.unsubscribe?.();
    // Commit edits when a note/embed closes; errors remain in the shared session.
    if (this.session?.dirty) void this.session.checkpoint().then(() => this.session?.saveWhenIdle()).catch(() => {});
    for (const entry of this.layers.values()) {
      entry.cancelPlacement?.(); this.removeChild(entry.ink); for (const control of entry.controls.values()) control.dispose?.(); entry.layer.remove();
    }
    this.layers.clear(); this.toolbar.remove(); this.message.remove();
    this.composing.clear();
    this.native.element.classList.remove('pdf-form-studio-view', 'pdf-form-studio-editing');
    delete this.native.element.dataset.pdfTool;

  }

  /** Discard transient previews and release every active gesture before blur, zoom or replacement. */
  cancelInteractions(): void {
    this.popover?.cancelScrub(); this.selection?.cancel();
    for (const entry of this.layers.values()) { entry.cancelPlacement?.(); entry.ink.cancel(); for (const control of entry.controls.values()) control.cancel?.(); }
  }
}
