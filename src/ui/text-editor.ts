import { Component, Menu, Modal, Notice, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import type { NativePage, NativePdf } from '../compat/native-pdf';
import { pdfRectangle, screenRectangle } from '../compat/native-pdf';
import type { Rect, TextField } from '../pdf/text-engine';
import type { BackupKind } from '../pdf/recovery';
import { usePdfFont } from './pdf-font';
import type { TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';

interface PageLayer { page: NativePage; layer: HTMLElement; fingerprint: string; controls: Map<string, HTMLInputElement | HTMLTextAreaElement> }
interface EditorState {
  editing: boolean; fontSize: number; selected?: string;
  focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
}

export class TextEditor extends Component {
  private app: App;
  private native: NativePdf;
  private sessions: VaultSessions;
  private session?: TextSession;
  private toolbar: HTMLElement;
  private toggle: HTMLButtonElement;
  private status: HTMLElement;
  private message: HTMLElement;
  private saveButton: HTMLButtonElement;
  private removeButton: HTMLButtonElement;
  private editControls: HTMLElement;
  private menu?: Menu;
  private layers = new Map<HTMLElement, PageLayer>();
  private nativeInputs = new Map<HTMLInputElement | HTMLTextAreaElement, boolean>();
  private editing = false;
  private loaded = true;
  private fontSize = 14;
  private selected?: string;
  private focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
  private timer?: number;
  private unsubscribe?: () => void;

  constructor(app: App, native: NativePdf, sessions: VaultSessions, state?: EditorState) {
    super(); this.app = app; this.native = native; this.sessions = sessions;
    if (state) { this.editing = state.editing; this.fontSize = state.fontSize; this.selected = state.selected; this.focused = state.focused; }
    const doc = native.element.ownerDocument;
    this.register(usePdfFont(doc));
    native.element.classList.add('pdf-form-studio-view');
    this.toolbar = doc.createElement('div'); this.toolbar.className = 'pdf-form-studio-toolbar';
    this.toolbar.setAttribute('role', 'toolbar'); this.toolbar.setAttribute('aria-label', 'PDF text editor');
    const button = (parent: HTMLElement, label: string, icon: string, callback: () => void): HTMLButtonElement => {
      const element = doc.createElement('button'); element.type = 'button'; element.className = 'clickable-icon pdf-form-studio-icon';
      setIcon(element, icon); setTooltip(element, label);
      this.registerDomEvent(element, 'click', callback); parent.append(element); return element;
    };
    this.toggle = button(this.toolbar, 'Edit text', 'type', () => { void this.toggleEditing(); });
    this.editControls = doc.createElement('div'); this.editControls.className = 'pdf-form-studio-edit-controls'; this.toolbar.append(this.editControls);
    const size = doc.createElement('select'); size.setAttribute('aria-label', 'New text size');
    size.className = 'pdf-form-studio-size'; setTooltip(size, 'Size for new text');
    for (const number of [10, 12, 14, 16, 18, 24]) {
      const option = doc.createElement('option'); option.value = String(number); option.textContent = `${number} pt`; size.append(option);
    }
    size.value = String(this.fontSize); this.registerDomEvent(size, 'change', () => { this.fontSize = Number(size.value); });
    this.editControls.append(size);
    this.saveButton = button(this.editControls, 'Save PDF', 'save', () => { void this.save(); });
    this.removeButton = button(this.editControls, 'Remove text box', 'trash-2', () => {
      if (this.selected) { this.focused = undefined; this.session?.delete(this.selected); this.selected = undefined; this.scheduleSave(); }
    });
    this.status = doc.createElement('span'); this.status.className = 'pdf-form-studio-status'; this.status.setAttribute('role', 'status');
    this.editControls.append(this.status);
    const more = button(this.toolbar, 'PDF text options', 'ellipsis', () => this.openMenu(more));
    this.message = doc.createElement('div'); this.message.className = 'pdf-form-studio-message';
    this.message.setAttribute('role', 'status');
    this.mountToolbar();
    this.register(() => this.menu?.hide());
    const observe = () => observer.observe(native.element, { childList: true, subtree: true });
    const observer = new doc.defaultView!.MutationObserver(() => {
      // Never observe our own layer rebuild: detached pages can otherwise cause
      // a self-sustaining microtask loop while Obsidian switches files.
      observer.disconnect(); this.refresh();
      if (this.loaded) observe();
    });
    observe();
    this.register(() => observer.disconnect());
    this.registerDomEvent(doc, 'pointerdown', event => {
      if (this.focused && event.target !== this.focused.input) this.focused = undefined;
    }, true);
    this.updateStatus();
    if (this.editing) void this.openSession().then(() => { this.updateStatus(); this.refresh(); }).catch(error => this.showError(error));
  }

  matches(native: NativePdf): boolean { return this.native.file === native.file && this.native.source === native.source && this.native.element === native.element; }
  get file() { return this.native.file; }
  captureState(native?: NativePdf): EditorState | undefined {
    return !native || this.native.file === native.file ? { editing: this.editing, fontSize: this.fontSize, selected: this.selected, focused: this.focused } : undefined;
  }
  private async openSession(): Promise<void> {
    if (this.session) return;
    this.status.textContent = 'Loading…';
    const session = await this.sessions.get(this.native.file);
    if (!this.loaded || this.session) return;
    this.session = session;
    this.unsubscribe = session.subscribe(() => { this.updateStatus(); this.refresh(); });
  }

  private async toggleEditing(): Promise<void> {
    try {
      await this.openSession();
      if (!this.loaded || !this.session) return;
      if (this.editing) { await this.session.save(); this.editing = false; }
      else this.editing = true;
      this.updateStatus(); this.refresh();
    } catch (error) { this.showError(error); }
  }

  private showError(error: unknown): void {
    if (!this.loaded) return;
    const message = error instanceof Error ? error.message : String(error);
    if (this.session?.status === 'conflict' || this.session?.status === 'error') this.updateStatus();
    else { this.message.textContent = message; this.status.textContent = 'Read only / save failed'; }
    new Notice(message);
  }

  private updateStatus(): void {
    const session = this.session;
    this.toggle.replaceChildren();
    setIcon(this.toggle, this.editing ? 'check' : 'type');
    setTooltip(this.toggle, this.editing ? 'Done editing' : 'Edit text — click or drag on the PDF to add text');
    this.toggle.setAttribute('aria-pressed', String(this.editing));
    this.editControls.hidden = !this.editing;
    this.native.element.classList.toggle('pdf-form-studio-editing', this.editing);
    this.saveButton.disabled = !session?.dirty || session.status === 'conflict' || session.status === 'saving';
    this.removeButton.disabled = !this.editing || !session?.snapshot.fields.find(field => field.name === this.selected)?.owned || session.status === 'conflict';
    this.removeButton.hidden = !this.selected;
    const status = session ? ({ saved: 'Saved to PDF', saving: 'Saving…', unsaved: 'Waiting to save', error: 'Save failed', conflict: 'File changed' }[session.status]) : 'Loading…';
    this.status.replaceChildren();
    setIcon(this.status, session?.status === 'saved' ? 'check' : session?.status === 'error' || session?.status === 'conflict' ? 'triangle-alert' : 'loader-circle');
    setTooltip(this.status, status); this.status.dataset.state = session?.status;
    const accessible = this.status.ownerDocument.createElement('span'); accessible.className = 'pdf-form-studio-sr-only'; accessible.textContent = status;
    this.status.append(accessible);
    this.message.textContent = session?.error || '';
    this.message.classList.toggle('is-error', session?.status === 'error' || session?.status === 'conflict');
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
    const file = this.native.file;
    const original = this.sessions.backupFor(file); const recovery = this.sessions.backupFor(file, 'recovery');
    const blocked = this.session?.status === 'conflict' || this.session?.status === 'saving';
    menu.addItem(item => item.setTitle('Reload PDF').setIcon('refresh-cw').setDisabled(!this.session).onClick(() => this.requestReload()));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('Open original backup').setIcon('folder-open').setDisabled(!original).onClick(() => {
      if (original) void this.app.workspace.getLeaf('tab').openFile(original);
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
    modal.contentEl.createEl('p', { text: 'This replaces the PDF and discards pending text. The current saved PDF is kept in the restore recovery slot first, so this action can be reversed.' });
    const confirm = modal.contentEl.createEl('button', { text: action, cls: 'mod-warning' });
    confirm.addEventListener('click', () => { modal.close(); this.focused = undefined; void this.sessions.restore(this.native.file, kind).catch(error => this.showError(error)); });
    modal.open();
  }

  private scheduleSave(): void {
    if (this.timer !== undefined) this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    this.timer = this.native.element.ownerDocument.defaultView!.setTimeout(() => { this.timer = undefined; void this.save(); }, 900);
  }

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
    modal.contentEl.createEl('p', { text: 'Reloading discards the pending text shown here and reads the current PDF from disk.' });
    const button = modal.contentEl.createEl('button', { text: 'Reload and discard pending text', cls: 'mod-warning' });
    button.addEventListener('click', () => { modal.close(); reload(); });
    modal.open();
  }

  refresh(): void {
    if (!this.loaded) return;
    for (const input of this.native.textInputs()) {
      if (!this.nativeInputs.has(input)) this.nativeInputs.set(input, input.readOnly);
      // Native form input changes do not participate in the verified vault writer.
      input.readOnly = true;
    }
    for (const input of this.nativeInputs.keys()) if (!input.isConnected) this.nativeInputs.delete(input);
    // Obsidian may replace toolbar content while refreshing a file.
    if (this.native.element.isConnected && (!this.toolbar.isConnected || this.toolbar.parentElement !== (this.native.toolbarHost() ?? this.native.element))) this.mountToolbar();
    const pages = this.native.pages();
    const resume = this.focused && !this.focused.input.isConnected ? this.focused : undefined;
    const alive = new Set(pages.map(page => page.div));
    for (const [div, entry] of this.layers) if (!alive.has(div) || !entry.layer.isConnected) { entry.layer.remove(); this.layers.delete(div); }
    if (!this.session) return;
    for (const page of pages) {
      let entry = this.layers.get(page.div);
      if (!entry) {
        const layer = page.div.ownerDocument.createElement('div'); layer.className = 'pdf-form-studio-layer';
        page.div.append(layer);
        entry = { page, layer, fingerprint: '', controls: new Map() }; this.layers.set(page.div, entry); this.bindPlacement(entry);
      }
      entry.page = page;
      entry.layer.hidden = !this.editing;
      if (!this.editing) continue;
      const fieldWidgets = this.session.snapshot.fields.flatMap(field => field.widgets.filter(widget => widget.page === page.number).map(widget => ({ field, widget })));
      const fingerprint = JSON.stringify([page.viewport.width, page.viewport.height, page.viewport.rotation, fieldWidgets.map(({ field, widget }) => [field.name, widget.rect, widget.rotation, field.fontSize, field.multiline])]);
      if (fingerprint !== entry.fingerprint) {
        // Preserve the currently focused field and caret across zoom/page refresh.
        const focused = page.div.ownerDocument.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        const name = focused?.dataset.pdfField;
        const caret = name ? focused?.selectionStart : undefined;
        entry.layer.replaceChildren(); entry.controls.clear(); entry.fingerprint = fingerprint;
        for (const { field, widget } of fieldWidgets) this.mountField(entry, field, widget.rect, widget.rotation);
        if (name) { const input = entry.controls.get(name); input?.focus(); if (caret != null) input?.setSelectionRange(caret, caret); }
      }
      for (const { field } of fieldWidgets) {
        const control = entry.controls.get(field.name);
        if (control && control.value !== field.value) control.value = field.value;
        if (control) { control.disabled = field.readOnly; control.readOnly = this.session.status === 'conflict'; }
      }
      // A vault write makes the native viewer recreate pages. Keep typing in the
      // replacement control instead of sending subsequent keys to the note.
      if (resume?.page === page.number && this.editing) {
        const input = entry.controls.get(resume.name);
        if (input && !input.disabled) {
          const start = resume.input.selectionStart; const end = resume.input.selectionEnd;
          input.focus({ preventScroll: true });
          if (start !== null && end !== null) input.setSelectionRange(start, end);
        }
      }
    }
  }

  private mountField(entry: PageLayer, field: TextField, rect: Rect, rotation: number): void {
    const doc = entry.layer.ownerDocument;
    const input = field.multiline ? doc.createElement('textarea') : doc.createElement('input');
    if (input instanceof doc.defaultView!.HTMLInputElement) input.type = 'text';
    input.className = 'pdf-form-studio-field'; input.dataset.pdfField = field.name;
    input.value = field.value; input.setAttribute('aria-label', field.owned ? 'PDF answer' : field.name);
    if (field.owned) input.placeholder = ' ';
    input.spellcheck = false;
    if (field.maxLength !== undefined) input.maxLength = field.maxLength;
    const [left, top, right, bottom] = screenRectangle(entry.page.viewport, rect);
    // PDF widget appearance rotation is counterclockwise; viewport/CSS is clockwise.
    const angle = ((entry.page.viewport.rotation - rotation) % 360 + 360) % 360;
    input.style.left = `${angle === 90 || angle === 180 ? right : left}px`;
    input.style.top = `${angle === 180 || angle === 270 ? bottom : top}px`;
    input.style.width = `${angle === 90 || angle === 270 ? bottom - top : right - left}px`;
    input.style.height = `${angle === 90 || angle === 270 ? right - left : bottom - top}px`;
    input.style.transformOrigin = 'top left'; input.style.transform = `rotate(${angle}deg)`;
    input.style.fontSize = `${field.fontSize * entry.page.viewport.scale}px`;
    input.style.padding = `${entry.page.viewport.scale}px`;
    input.addEventListener('focus', () => {
      this.focused = { input, page: entry.page.number, name: field.name };
      this.selected = field.name; this.updateStatus();
    });
    input.addEventListener('input', event => {
      if ((event as InputEvent).isComposing) return;
      try { this.session!.setValue(field.name, input.value); this.scheduleSave(); } catch (error) { this.showError(error); }
    });
    input.addEventListener('compositionend', () => { this.session!.setValue(field.name, input.value); this.scheduleSave(); });
    input.addEventListener('compositionstart', () => {
      if (this.timer !== undefined) { doc.defaultView!.clearTimeout(this.timer); this.timer = undefined; }
    });
    input.addEventListener('blur', () => {
      // Native PDF reloads blur the control before detaching it. Explicit clicks,
      // Tab and Escape clear the focus record; this blur must keep it for refresh.
      if (this.session?.dirty && this.session.status !== 'conflict') void this.save();
    });
    input.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      // Keep Obsidian's note editor from handling typing inside the PDF.
      event.stopPropagation();
      if (key.key === 'Tab' || key.key === 'Escape') this.focused = undefined;
      if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === 's') { event.preventDefault(); void this.save(); }
      if (key.key === 'Escape') { input.blur(); }
    });
    entry.layer.append(input); entry.controls.set(field.name, input);
  }

  private bindPlacement(entry: PageLayer): void {
    let start: [number, number] | undefined;
    let pointer: number | undefined;
    let preview: HTMLElement | undefined;
    const point = (event: PointerEvent): [number, number] => {
      const box = entry.layer.getBoundingClientRect();
      return [Math.max(0, Math.min(entry.page.viewport.width, (event.clientX - box.left) * entry.page.viewport.width / box.width)),
        Math.max(0, Math.min(entry.page.viewport.height, (event.clientY - box.top) * entry.page.viewport.height / box.height))];
    };
    entry.layer.addEventListener('pointerdown', event => {
      if (event.target !== entry.layer || event.button !== 0 || !this.editing || this.session?.status === 'conflict') return;
      event.preventDefault(); event.stopPropagation(); start = point(event); pointer = event.pointerId;
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
      const multiline = dragged && Math.abs(screenEnd[1] - screenStart[1]) > this.fontSize * scale * 2;
      start = undefined; pointer = undefined;
      preview?.remove(); preview = undefined;
      if (entry.layer.hasPointerCapture(event.pointerId)) entry.layer.releasePointerCapture(event.pointerId);
      if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) return;
      const field = this.session.add(entry.page.number, rect, this.fontSize, multiline, entry.page.viewport.rotation);
      this.selected = field.name; this.refresh(); entry.controls.get(field.name)?.focus(); this.scheduleSave();
    });
    const cancel = () => { start = undefined; pointer = undefined; preview?.remove(); preview = undefined; };
    entry.layer.addEventListener('pointercancel', cancel); entry.layer.addEventListener('lostpointercapture', cancel);
  }

  onunload(): void {
    this.loaded = false;
    if (this.timer !== undefined) this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    this.unsubscribe?.();
    // Commit edits when a note/embed closes; errors remain in the shared session.
    if (this.session?.dirty) void this.session.save().catch(() => {});
    for (const entry of this.layers.values()) entry.layer.remove();
    this.layers.clear(); this.toolbar.remove(); this.message.remove();
    this.native.element.classList.remove('pdf-form-studio-view', 'pdf-form-studio-editing');
    for (const [input, readOnly] of this.nativeInputs) input.readOnly = readOnly;
    this.nativeInputs.clear();
  }
}
