export type FontFamily = 'sans' | 'serif' | 'mono';
export type PdfColor = [number, number, number];
export interface TextFormat { fontFamily: FontFamily; fontSize: number; color: PdfColor; alignment?: 'left' | 'center' | 'right'; letterSpacing?: number; lineSpacing?: number; autoSize?: true; preserveWidgetSizes?: true }
export const DEFAULT_LINE_SPACING = 1.2;
/** Accept only finite tracking in PDF points and leading multipliers within supported limits. */
export function validSpacing(letter = 0, line = DEFAULT_LINE_SPACING): boolean {
  return Number.isFinite(letter) && letter >= 0 && letter <= 20 && Number.isFinite(line) && line >= 0.8 && line <= 3;
}
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
/** Keep combining marks with their base when measuring and drawing tracked text. */
export function textGraphemes(text: string): string[] { return [...graphemes.segment(text)].map(part => part.segment); }
/** CSS tracking includes the trailing space; use identical widths for wrapping and alignment. */
export function spacedWidth(text: string, measure: (text: string) => number, letter = 0): number {
  return letter ? textGraphemes(text).reduce((sum, part) => sum + measure(part) + letter, 0) : measure(text);
}
export type PdfFonts = Uint8Array | Record<FontFamily, Uint8Array>;
export const fontNames: Record<FontFamily, string> = { sans: 'Sans', serif: 'Serif', mono: 'Mono' };
export const fontFaces: Record<FontFamily, string> = { sans: 'PDF Form Studio Text', serif: 'PDF Form Studio Serif', mono: 'PDF Form Studio Mono' };
export function validColor(color: PdfColor): boolean { return color.length === 3 && color.every(value => Number.isFinite(value) && value >= 0 && value <= 1); }
export function cssColor(color: PdfColor): string { return '#' + color.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join(''); }
export function parseColor(hex: string): PdfColor { return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255) as PdfColor; }
export function defaultColor(appearance: string): PdfColor {
  const matches = [...appearance.matchAll(/((?:[\d.]+\s+){1,4})(rg|g|k)\b/g)];
  const last = matches.at(-1), values = last?.[1]?.trim().split(/\s+/).map(Number) ?? [];
  const color = last?.[2] === 'g' && values.length === 1 ? [values[0]!, values[0]!, values[0]!] as PdfColor
    : last?.[2] === 'k' && values.length === 4 ? values.slice(0, 3).map(value => 1 - Math.min(1, value + values[3]!)) as PdfColor
      : last?.[2] === 'rg' && values.length === 3 ? values as PdfColor : [0.05, 0.05, 0.05] as PdfColor;
  return validColor(color) ? color : [0.05, 0.05, 0.05];
}
