import { Component, Menu, Modal, Notice, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import type { NativePage, NativePdf } from '../compat/native-pdf';
import { pdfRectangle, screenRectangle } from '../compat/native-pdf';
import type { Rect, TextField } from '../pdf/text-engine';
import type { BackupKind } from '../pdf/recovery';
import { usePdfFont } from './pdf-font';
import type { TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { growBox, rotatedHandle, transformBox } from '../pdf/box-geometry';
import type { ResizeHandle } from '../pdf/box-geometry';

interface FieldControl {
  frame: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement;
  preview?: Rect; dispose?: () => void;
}
interface PageLayer { page: NativePage; layer: HTMLElement; controls: Map<string, FieldControl>; cancelPlacement?: () => void }
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
  private size: HTMLSelectElement;
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
  private focusInteraction?: { input: HTMLElement; release: () => void };
  private composing = new Set<HTMLInputElement | HTMLTextAreaElement>();

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
    const size = this.size = doc.createElement('select'); size.setAttribute('aria-label', 'Text size');
    size.className = 'pdf-form-studio-size'; setTooltip(size, 'Text size');
    for (const number of [8, 10, 12, 14, 16, 18, 24, 32, 48]) {
      const option = doc.createElement('option'); option.value = String(number); option.textContent = `${number} pt`; size.append(option);
    }
    size.value = String(this.fontSize); this.registerDomEvent(size, 'change', () => {
      this.fontSize = Number(size.value);
      const field = this.session?.snapshot.fields.find(field => field.name === this.selected && field.owned);
      if (field) {
        try {
          this.session!.updateBox(field.name, field.widgets[0]!.rect, { fontSize: this.fontSize, multiline: true });
          for (const entry of this.layers.values()) for (const control of entry.controls.values()) {
            if (control.input.dataset.pdfField === field.name) this.growField(entry, control);
          }
          this.scheduleSave();
        } catch (error) { this.showError(error); }
      }
    });
    this.editControls.append(size);
    this.saveButton = button(this.editControls, 'Save PDF', 'save', () => { void this.save(); });
    this.removeButton = button(this.editControls, 'Remove text box', 'trash-2', () => {
      if (this.selected) { this.focused = undefined; this.session?.delete(this.selected); this.selected = undefined; this.updateStatus(); this.refresh(); this.scheduleSave(); }
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
      if (event.target instanceof doc.defaultView!.Node && !native.element.contains(event.target)) {
        this.selected = undefined; this.updateStatus(); this.refresh();
      }
    }, true);
    this.registerDomEvent(doc, 'focusin', event => {
      // Keyboard-opened dialogs also move focus deliberately. Never restore
      // a PDF input over the quick switcher, command palette or another note.
      if (this.focused && event.target !== this.focused.input) this.focused = undefined;
      if (event.target instanceof doc.defaultView!.HTMLElement && this.toolbar.contains(event.target) && this.session) {
        this.releaseFocus(); this.focusInteraction = { input: event.target, release: this.session.beginInteraction() };
      }
    });
    this.registerDomEvent(this.toolbar, 'focusout', event => {
      if (this.focusInteraction?.input === event.target) this.releaseFocus();
      if (this.loaded && this.session?.dirty) this.scheduleSave();
    });
    // Live Preview handles shortcuts before an embedded input's bubble phase.
    // Claim Save at the window capture phase, scoped to this editor's controls.
    this.registerDomEvent(doc.defaultView!, 'keydown', event => {
      if (!this.editing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      const target = event.target;
      if (!(target instanceof doc.defaultView!.Node) || ![...this.layers.values()].some(entry => entry.layer.contains(target))) return;
      event.preventDefault(); event.stopImmediatePropagation(); void this.save();
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
    const wasEditing = this.editing;
    try {
      await this.openSession();
      if (!this.loaded || !this.session) return;
      if (this.editing) { this.editing = false; this.focused = undefined; this.releaseFocus(); await this.session.save(); }
      else this.editing = true;
      this.updateStatus(); this.refresh();
    } catch (error) {
      if (wasEditing) { this.editing = true; this.refresh(); }
      this.showError(error);
    }
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
    const selected = session?.snapshot.fields.find(field => field.name === this.selected && field.owned);
    this.size.value = String(selected?.fontSize ?? this.fontSize);
    this.toggle.replaceChildren();
    setIcon(this.toggle, this.editing ? 'check' : 'type');
    setTooltip(this.toggle, this.editing ? 'Done editing' : 'Edit text — click or drag on the PDF to add text');
    this.toggle.setAttribute('aria-pressed', String(this.editing));
    this.editControls.hidden = !this.editing;
    this.native.element.classList.toggle('pdf-form-studio-editing', this.editing);
    this.saveButton.disabled = !session?.dirty || session.status === 'conflict';
    this.removeButton.disabled = !this.editing || !selected || selected.readOnly || session?.status === 'conflict';
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
    const release = this.session?.beginInteraction(); menu.onHide(() => release?.());
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
    this.timer = this.native.element.ownerDocument.defaultView!.setTimeout(() => {
      this.timer = undefined;
      void this.session?.saveWhenIdle().catch(error => this.showError(error));
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
    for (const [div, entry] of this.layers) if (!alive.has(div) || !entry.layer.isConnected) {
      if (this.focusInteraction && entry.layer.contains(this.focusInteraction.input)) this.releaseFocus();
      entry.cancelPlacement?.();
      for (const control of entry.controls.values()) control.dispose?.();
      entry.layer.remove(); this.layers.delete(div);
    }
    if (!this.session) return;
    for (const page of pages) {
      let entry = this.layers.get(page.div);
      if (!entry) {
        const layer = page.div.ownerDocument.createElement('div'); layer.className = 'pdf-form-studio-layer';
        page.div.append(layer);
        entry = { page, layer, controls: new Map() }; this.layers.set(page.div, entry); this.bindPlacement(entry);
      }
      entry.page = page;
      entry.layer.hidden = !this.editing;
      if (!this.editing) continue;
      const fieldWidgets = this.session.snapshot.fields.flatMap(field => field.widgets.flatMap((widget, index) =>
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
        if (!control.preview) this.positionField(entry, control, field, widget.rect, widget.rotation);
        if (!this.composing.has(control.input) && control.input.value !== field.value) control.input.value = field.value;
        control.input.disabled = field.readOnly;
        control.input.readOnly = this.session.status === 'conflict' || (field.owned && page.div.ownerDocument.activeElement !== control.input);
        control.frame.classList.toggle('is-selected', field.name === this.selected && field.owned);
        control.frame.classList.toggle('is-locked', this.session.status === 'conflict' || field.readOnly || (field.owned && field.widgets.length !== 1));
      }
      // A vault write makes the native viewer recreate pages. Keep typing in the
      // replacement control instead of sending subsequent keys to the note.
      const active = page.div.ownerDocument.activeElement;
      if (resume?.page === page.number && this.editing && (!active || active === page.div.ownerDocument.body || active === resume.input)) {
        const input = [...entry.controls.values()].find(control => control.input.dataset.pdfField === resume.name)?.input;
        if (input && !input.disabled) {
          const start = resume.input.selectionStart; const end = resume.input.selectionEnd;
          input.focus({ preventScroll: true });
          if (start !== null && end !== null) input.setSelectionRange(start, end);
        }
      }
    }
  }

  private positionField(entry: PageLayer, control: FieldControl, field: TextField, rect: Rect, rotation: number): void {
    const { frame, input } = control;
    const [left, top, right, bottom] = screenRectangle(entry.page.viewport, rect);
    // PDF widget appearance rotation is counterclockwise; viewport/CSS is clockwise.
    const angle = ((entry.page.viewport.rotation - rotation) % 360 + 360) % 360;
    frame.style.left = `${angle === 90 || angle === 180 ? right : left}px`;
    frame.style.top = `${angle === 180 || angle === 270 ? bottom : top}px`;
    frame.style.width = `${angle === 90 || angle === 270 ? bottom - top : right - left}px`;
    frame.style.height = `${angle === 90 || angle === 270 ? right - left : bottom - top}px`;
    frame.style.transformOrigin = 'top left'; frame.style.transform = `rotate(${angle}deg)`;
    input.style.fontSize = `${field.fontSize * entry.page.viewport.scale}px`;
    input.style.padding = `${entry.page.viewport.scale}px`;
  }

  private mountField(entry: PageLayer, field: TextField, key: string): void {
    const doc = entry.layer.ownerDocument;
    const frame = doc.createElement('div'); frame.className = 'pdf-form-studio-box';
    frame.classList.toggle('is-added', field.owned);
    const input = field.owned || field.multiline ? doc.createElement('textarea') : doc.createElement('input');
    const control: FieldControl = { frame, input };
    if (input instanceof doc.defaultView!.HTMLInputElement) input.type = 'text';
    input.className = 'pdf-form-studio-field'; input.dataset.pdfField = field.name;
    input.value = field.value; input.setAttribute('aria-label', field.owned ? 'PDF answer' : field.name);
    if (field.owned) input.placeholder = ' ';
    input.spellcheck = false;
    if (field.maxLength !== undefined) input.maxLength = field.maxLength;
    input.addEventListener('focus', () => {
      this.releaseFocus();
      this.focusInteraction = { input, release: this.session!.beginInteraction() };
      this.focused = { input, page: entry.page.number, name: field.name };
      input.readOnly = this.session?.status === 'conflict';
      this.selected = field.name; this.updateStatus(); this.refresh();
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
      // Native PDF reloads blur the control before detaching it. Explicit clicks,
      // Tab and Escape clear the focus record; this blur must keep it for refresh.
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
    frame.append(input); entry.layer.append(frame); entry.controls.set(key, control);
    if (field.owned) control.dispose = this.bindBox(entry, control, field.name);
  }

  private growField(entry: PageLayer, control: FieldControl): void {
    const field = this.session?.snapshot.fields.find(field => field.name === control.input.dataset.pdfField);
    if (!field?.owned || field.readOnly || field.widgets.length !== 1 || this.session?.status === 'conflict' || this.composing.has(control.input)) return;
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
      lineHeight: style.lineHeight, padding: style.padding, border: '0', boxSizing: 'border-box',
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'hidden', margin: '0'
    });
    measure.tabIndex = -1; measure.setAttribute('aria-hidden', 'true'); doc.body.append(measure);
    const height = Math.max(measure.scrollHeight + 1, (field.fontSize * 1.2 + 2) * entry.page.viewport.scale);
    measure.remove();
    const viewport = entry.page.viewport;
    const angle = ((viewport.rotation - widget.rotation) % 360 + 360) % 360;
    const screen = growBox(screenRectangle(viewport, widget.rect), [0, 0, viewport.width, viewport.height], height, angle);
    this.session!.updateBox(field.name, pdfRectangle(viewport, [screen[0], screen[1]], [screen[2], screen[3]]), { multiline: true });
    const overflow = height > control.input.clientHeight + 1;
    control.frame.classList.toggle('is-overflow', overflow);
    control.frame.title = overflow ? 'Text reaches the page edge. Widen the box or reduce the text size.' : '';
  }

  private bindBox(entry: PageLayer, control: FieldControl, name: string): () => void {
    const { frame, input } = control;
    const doc = frame.ownerDocument;
    frame.tabIndex = 0; frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', 'Text box. Drag to move; double-click or press Enter to edit.');
    const labels: Record<ResizeHandle, string> = {
      n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left'
    };
    for (const handle of Object.keys(labels) as ResizeHandle[]) {
      const button = doc.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.className = 'pdf-form-studio-handle'; button.dataset.resize = handle;
      button.setAttribute('aria-label', `Resize text box from ${labels[handle]}`); frame.append(button);
    }
    for (const edge of ['n', 'e', 's', 'w']) {
      const border = doc.createElement('div'); border.className = 'pdf-form-studio-move-edge'; border.dataset.edge = edge;
      border.setAttribute('aria-hidden', 'true'); frame.append(border);
    }
    const select = () => {
      this.selected = name; this.updateStatus(); this.refresh();
    };
    frame.addEventListener('focus', () => {
      this.releaseFocus(); this.focusInteraction = { input: frame, release: this.session!.beginInteraction() }; select();
    });
    frame.addEventListener('blur', () => {
      if (this.focusInteraction?.input === frame) this.releaseFocus();
      if (this.loaded && this.session?.dirty) this.scheduleSave();
    });
    frame.addEventListener('dblclick', event => {
      if (doc.activeElement === input || this.session?.status === 'conflict' || (event.target as HTMLElement).dataset.resize) return;
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
      if (event.button !== 0 || !this.editing || this.session?.status === 'conflict') return;
      if (event.target === input && doc.activeElement === input) return;
      const field = this.session?.snapshot.fields.find(field => field.name === name);
      if (!field || field.readOnly || field.widgets.length !== 1) return;
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
      const angle = ((viewport.rotation - widget.rotation) % 360 + 360) % 360;
      const minimum: [number, number] = [40 * viewport.scale, (field.fontSize * 1.2 + 2) * viewport.scale];
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
    frame.addEventListener('pointercancel', () => cancel()); frame.addEventListener('lostpointercapture', () => cancel());
    frame.addEventListener('keydown', event => {
      if (event.target !== frame) return;
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); input.focus({ preventScroll: true }); return; }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); this.selected = undefined; frame.blur(); this.updateStatus(); this.refresh(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.save(); return; }
      const field = this.session?.snapshot.fields.find(field => field.name === name);
      if (!field || field.readOnly || field.widgets.length !== 1 || this.session?.status === 'conflict') return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); this.session?.delete(name); this.selected = undefined; this.scheduleSave(); return;
      }
      const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = direction[event.key];
      if (!delta) return;
      event.preventDefault();
      const widget = field.widgets[0]!;
      const viewport = entry.page.viewport; const step = viewport.scale * (event.shiftKey ? 10 : 1);
      const handle = event.altKey ? (delta[0] ? 'e' : 's') : undefined;
      const rect = transformBox(screenRectangle(viewport, widget.rect), [0, 0, viewport.width, viewport.height], [delta[0] * step, delta[1] * step], handle,
        [40 * viewport.scale, (field.fontSize * 1.2 + 2) * viewport.scale]);
      this.session!.updateBox(name, pdfRectangle(viewport, [rect[0], rect[1]], [rect[2], rect[3]]));
      if (handle) this.growField(entry, control);
      this.scheduleSave();
    });
    return () => cancel(false);
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
      if (event.target !== entry.layer || event.button !== 0 || !this.editing || !this.session || this.session.status === 'conflict') return;
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
        this.selected = field.name; this.refresh(); entry.controls.get(`${field.name}:0`)?.input.focus({ preventScroll: true });
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
    entry.cancelPlacement = cancel;
  }

  onunload(): void {
    this.loaded = false;
    this.releaseFocus();
    if (this.timer !== undefined) this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    this.unsubscribe?.();
    // Commit edits when a note/embed closes; errors remain in the shared session.
    if (this.session?.dirty) void this.session.saveWhenIdle().catch(() => {});
    for (const entry of this.layers.values()) {
      entry.cancelPlacement?.(); for (const control of entry.controls.values()) control.dispose?.(); entry.layer.remove();
    }
    this.layers.clear(); this.toolbar.remove(); this.message.remove();
    this.composing.clear();
    this.native.element.classList.remove('pdf-form-studio-view', 'pdf-form-studio-editing');
    for (const [input, readOnly] of this.nativeInputs) input.readOnly = readOnly;
    this.nativeInputs.clear();
  }
}
