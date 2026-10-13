import { Component, setIcon } from 'obsidian';
import { cssColor, parseColor, fontFaces } from '../pdf/text-format';
import type { FontFamily, PdfColor } from '../pdf/text-format';

export const colors = [['Black', '#161616'], ['Gray', '#64748b'], ['Red', '#c62828'], ['Orange', '#ee7900'], ['Yellow', '#ffd600'], ['Green', '#22813e'], ['Blue', '#1769ce'], ['Purple', '#8347b5']] as const;
interface SpacingOptions {
  letter: number; line: number; disabled?: boolean; lineLocked?: boolean;
  begin(): boolean; preview(letter: number, line: number): boolean; finish(cancel: boolean): void;
  change(letter: number, line: number): void;
}
interface Options { title: string; color: PdfColor; changeColor(color: PdfColor): void; widths?: { values: number[]; value: number; change(value: number): void }; text?: { font: FontFamily; size: number; disabled?: boolean; alignment: 'left' | 'center' | 'right'; align(value: 'left' | 'center' | 'right'): void; spacing: SpacingOptions; change(font: FontFamily, size: number): void }; toggles?: { label: string; description: string; value: boolean; change(value: boolean): void }[]; close(): void }

/** Parse a finite decimal with a point or comma; leave range validation to each spacing control. */
export function parseSpacing(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value.trim())) return;
  const number = Number(value.trim().replace(',', '.')); return Number.isFinite(number) ? number : undefined;
}

/** Document-local portal: remains usable in clipped embeds and pop-out windows. */
export class ToolPopover extends Component {
  readonly element: HTMLElement;
  private abortScrub?: () => void;
  /** Cancel the current preview and report whether an active pointer interaction was released. */
  cancelScrub(): boolean { if (!this.abortScrub) return false; this.abortScrub(); return true; }
  /** Mount controls in the anchor's window and register their listeners and portal for lifecycle disposal. */
  constructor(anchor: HTMLElement, options: Options) {
    super(); const doc = anchor.ownerDocument;
    const el = this.element = doc.createElement('div'); el.className = 'pfs-tool-popover';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', options.title); el.tabIndex = -1;
    const header = el.createDiv({ cls: 'pfs-popover-heading' }); header.createSpan({ text: options.title });
    const close = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Close tool settings' } }); setIcon(close, 'x');
    this.registerDomEvent(close, 'click', () => options.close());
    const preview = el.createDiv({ cls: 'pfs-brush-preview', attr: { 'aria-hidden': 'true' } });
    const sample = preview.createSpan(); let color = options.color, width = options.widths?.value ?? 2;
    const updatePreview = () => { sample.style.background = cssColor(color); sample.style.height = `${Math.min(24, width)}px`; sample.style.opacity = options.title === 'Highlighter' ? '0.5' : '1'; };
    if (options.text) preview.hidden = true;
    el.createDiv({ cls: 'pfs-property-label', text: 'Color' });
    const palette = el.createDiv({ cls: 'pfs-color-grid', attr: { role: 'group', 'aria-label': 'Color' } });
    const updateColors = () => { for (const button of palette.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.color === cssColor(color))); };
    for (const [name, hex] of colors) {
      const b = palette.createEl('button', { cls: 'pfs-swatch', attr: { 'aria-label': name, title: name } }); b.dataset.color = hex;
      b.disabled = !!options.text?.disabled;
      b.style.setProperty('--swatch', hex); const check = b.createSpan({ cls: 'pfs-swatch-check' }); setIcon(check, 'check');
      this.registerDomEvent(b, 'click', () => { color = parseColor(hex); options.changeColor(color); updateColors(); updatePreview(); });
    }
    updateColors(); updatePreview();
    if (options.widths) {
      el.createDiv({ cls: 'pfs-property-label', text: 'Thickness' });
      const widths = el.createDiv({ cls: 'pfs-widths', attr: { role: 'group', 'aria-label': 'Line thickness' } });
      for (const value of options.widths.values) {
        const b = widths.createEl('button', { cls: 'pfs-width-option', attr: { 'aria-label': `${value} point line`, 'aria-pressed': String(value === width) } });
        const track = b.createSpan({ cls: 'pfs-width-track' }); const stroke = track.createSpan(); stroke.style.height = `${Math.min(18, value)}px`;
        b.createSpan({ text: `${value} pt` });
        this.registerDomEvent(b, 'click', () => { width = value; options.widths!.change(value); for (const item of widths.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); updatePreview(); });
      }
    }
    if (options.text) {
      const text = options.text; let font = text.font, size = text.size;
      el.createDiv({ cls: 'pfs-property-label', text: 'Typeface' });
      const fonts = el.createDiv({ cls: 'pfs-fonts', attr: { role: 'group', 'aria-label': 'Typeface' } });
      for (const [value, name] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']] as const) {
        const b = fonts.createEl('button', { text: name, attr: { 'aria-pressed': String(font === value) } }); b.style.fontFamily = `"${fontFaces[value]}"`;
        b.disabled = !!text.disabled;
        this.registerDomEvent(b, 'click', () => { font = value; text.change(font, size); for (const item of fonts.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); });
      }
      el.createDiv({ cls: 'pfs-property-label', text: 'Text size' });
      const sizes = el.createDiv({ cls: 'pfs-text-sizes', attr: { role: 'group', 'aria-label': 'Text size' } });
      for (const value of [10, 12, 14, 16, 18, 24, 32, 48]) {
        const b = sizes.createEl('button', { text: String(value), attr: { 'aria-label': `${value} point text`, 'aria-pressed': String(size === value) } });
        b.disabled = !!text.disabled;
        this.registerDomEvent(b, 'click', () => { size = value; text.change(font, size); for (const item of sizes.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); });
      }
      el.createDiv({ cls: 'pfs-property-label', text: 'Alignment' });
      const alignment = el.createDiv({ cls: 'pfs-alignment', attr: { role: 'group', 'aria-label': 'Text alignment' } });
      for (const value of ['left', 'center', 'right'] as const) {
        const b = alignment.createEl('button', { attr: { 'aria-label': `Align ${value}`, title: `Align ${value}`, 'aria-pressed': String(text.alignment === value) } });
        setIcon(b, `align-${value}`); b.disabled = !!text.disabled;
        this.registerDomEvent(b, 'click', () => { text.align(value); for (const item of alignment.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); });
      }
      this.spacingControls(el, text.spacing);
    }
    for (const toggle of options.toggles ?? []) {
      const row = el.createEl('button', { cls: 'pfs-assist-toggle', attr: { role: 'switch', 'aria-label': toggle.label, 'aria-checked': String(toggle.value) } });
      const copy = row.createSpan(); copy.createEl('strong', { text: toggle.label }); copy.createSpan({ cls: 'pfs-assist-description', text: toggle.description });
      row.createSpan({ cls: 'pfs-switch-track', attr: { 'aria-hidden': 'true' } });
      let value = toggle.value;
      this.registerDomEvent(row, 'click', () => { value = !value; toggle.change(value); row.setAttribute('aria-checked', String(value)); });
    }
    doc.body.append(el);
    const position = () => { const rect = anchor.getBoundingClientRect(); const view = doc.defaultView!;
      el.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(rect.bottom + 8, view.innerHeight - el.offsetHeight - 8))}px`; };
    position(); if (!options.text) el.focus({ preventScroll: true });
    this.registerDomEvent(doc, 'pointerdown', event => { if (!el.contains(event.target as Node) && !anchor.contains(event.target as Node)) options.close(); }, true);
    this.registerDomEvent(doc.defaultView!, 'resize', position);
    this.registerDomEvent(el, 'keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (this.cancelScrub()) return; options.close(); anchor.focus({ preventScroll: true }); return; }
      const buttons = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')], index = buttons.indexOf(doc.activeElement as HTMLElement);
      if (doc.activeElement?.tagName === 'INPUT' && event.key !== 'Tab') return;
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Tab') { event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    });
    this.register(() => el.remove());
  }

  /** Build editable spacing values and captured horizontal scrubs with one commit or a restored preview. */
  private spacingControls(parent: HTMLElement, options: SpacingOptions): void {
    const doc = parent.ownerDocument, win = doc.defaultView!;
    const row = parent.createDiv({ cls: 'pfs-spacing-row', attr: { role: 'group', 'aria-label': 'Text spacing' } });
    let letter = options.letter, line = options.line;
    const values: HTMLInputElement[] = [];
    const display = () => { values[0]!.value = String(letter); values[1]!.value = String(line); };
    for (const [index, label, icon, unit, minimum, maximum, step, precision] of [
      [0, 'Letter spacing', 'between-vertical-start', 'pt', 0, 20, 0.1, 0.02],
      [1, 'Line spacing', 'between-horizontal-start', '×', 0.8, 3, 0.05, 0.005]
    ] as const) {
      const group = row.createDiv({ cls: 'pfs-spacing-control' });
      const scrub = group.createEl('button', { cls: 'pfs-spacing-scrub', attr: { 'aria-label': `${label}: drag horizontally to adjust`, title: `${label} · drag left or right` } });
      setIcon(scrub, icon);
      const input = group.createEl('input', { cls: 'pfs-spacing-value', attr: { type: 'text', inputmode: 'decimal', 'aria-label': `${label} (${unit === 'pt' ? 'PDF points' : 'multiplier'})`, 'aria-description': `Range ${minimum} to ${maximum}. Up and Down adjust by ${step}.`, spellcheck: 'false' } });
      group.createSpan({ cls: 'pfs-spacing-unit', text: unit, attr: { 'aria-hidden': 'true' } });
      values.push(input); input.value = String(index ? line : letter);
      scrub.disabled = input.disabled = !!options.disabled || (index === 1 && !!options.lineLocked);
      if (index === 1 && options.lineLocked) scrub.title = input.title = 'Ruled answers follow their printed line pitch. Resize the box to use ordinary line spacing.';
      const apply = (value: number) => { if (index) line = value; else letter = value; display(); options.change(letter, line); };
      const commit = () => {
        const value = parseSpacing(input.value);
        const valid = value !== undefined && value >= minimum && value <= maximum;
        input.setAttribute('aria-invalid', String(!valid)); if (valid) apply(value);
      };
      this.registerDomEvent(input, 'change', commit);
      this.registerDomEvent(input, 'keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); const value = parseSpacing(input.value) ?? (index ? line : letter);
          apply(Math.max(minimum, Math.min(maximum, Math.round((value + (event.key === 'ArrowUp' ? step : -step)) * 100) / 100)));
        }
      });
      let drag: { id: number; x: number; start: number; letter: number; line: number; active: boolean } | undefined;
      let suppressClick = false;
      const finish = (cancel: boolean) => {
        const previous = drag; drag = undefined; this.abortScrub = undefined;
        if (!previous) return;
        if (scrub.hasPointerCapture(previous.id)) scrub.releasePointerCapture(previous.id);
        if (previous.active) {
          suppressClick = true;
          if (cancel) { letter = previous.letter; line = previous.line; display(); }
          options.finish(cancel);
        }
        group.classList.remove('is-scrubbing');
      };
      this.registerDomEvent(scrub, 'pointerdown', event => {
        if (event.button !== 0 || scrub.disabled) return;
        event.preventDefault(); this.cancelScrub(); suppressClick = false;
        drag = { id: event.pointerId, x: event.clientX, start: index ? line : letter, letter, line, active: false };
        this.abortScrub = () => finish(true); scrub.setPointerCapture(event.pointerId);
      });
      this.registerDomEvent(scrub, 'pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        const distance = event.clientX - drag.x;
        if (!drag.active) {
          if (Math.abs(distance) < 4) return;
          if (!options.begin()) { finish(true); return; }
          drag.active = true; group.classList.add('is-scrubbing');
        }
        const value = Math.max(minimum, Math.min(maximum, Math.round((drag.start + distance * precision) * 100) / 100));
        if (index) line = value; else letter = value; display();
        if (!options.preview(letter, line)) finish(true);
      });
      this.registerDomEvent(scrub, 'pointerup', event => { if (drag?.id === event.pointerId) { const click = !drag.active; finish(false); if (click) { input.focus({ preventScroll: true }); input.select(); } } });
      this.registerDomEvent(scrub, 'click', () => { if (suppressClick) { suppressClick = false; return; } input.focus({ preventScroll: true }); input.select(); });
      this.registerDomEvent(scrub, 'pointercancel', () => finish(true));
      this.registerDomEvent(scrub, 'lostpointercapture', () => { if (drag) finish(true); });
      this.registerDomEvent(win, 'blur', () => finish(true));
      this.register(() => finish(true));
    }
  }
}
