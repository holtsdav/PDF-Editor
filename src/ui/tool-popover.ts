import { Component, setIcon } from 'obsidian';
import { cssColor, parseColor, fontFaces } from '../pdf/text-format';
import type { FontFamily, PdfColor } from '../pdf/text-format';

export const colors = [['Black', '#161616'], ['Gray', '#64748b'], ['Red', '#c62828'], ['Orange', '#ee7900'], ['Yellow', '#ffd600'], ['Green', '#22813e'], ['Blue', '#1769ce'], ['Purple', '#8347b5']] as const;
interface Options { title: string; color: PdfColor; changeColor(color: PdfColor): void; widths?: { values: number[]; value: number; change(value: number): void }; text?: { font: FontFamily; size: number; change(font: FontFamily, size: number): void }; toggles?: { label: string; description: string; value: boolean; change(value: boolean): void }[]; close(): void }

/** Document-local portal: remains usable in clipped embeds and pop-out windows. */
export class ToolPopover extends Component {
  readonly element: HTMLElement;
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
        this.registerDomEvent(b, 'click', () => { font = value; text.change(font, size); for (const item of fonts.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); });
      }
      el.createDiv({ cls: 'pfs-property-label', text: 'Text size' });
      const sizes = el.createDiv({ cls: 'pfs-text-sizes', attr: { role: 'group', 'aria-label': 'Text size' } });
      for (const value of [10, 12, 14, 16, 18, 24, 32, 48]) {
        const b = sizes.createEl('button', { text: String(value), attr: { 'aria-label': `${value} point text`, 'aria-pressed': String(size === value) } });
        this.registerDomEvent(b, 'click', () => { size = value; text.change(font, size); for (const item of sizes.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === b)); });
      }
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
    position(); el.focus({ preventScroll: true });
    this.registerDomEvent(doc, 'pointerdown', event => { if (!el.contains(event.target as Node) && !anchor.contains(event.target as Node)) options.close(); }, true);
    this.registerDomEvent(doc.defaultView!, 'resize', position);
    this.registerDomEvent(el, 'keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); options.close(); anchor.focus({ preventScroll: true }); return; }
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Tab') { event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    });
    this.register(() => el.remove());
  }
}
