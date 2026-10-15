import { validColor } from './text-format.ts';
import type { FontFamily, PdfColor } from './text-format';
export const MAX_TOOLBAR_TOP_OFFSET = 160;
export const MAX_AUTO_DETECT_PAGES = 300;
export interface ToolPreferences {
  fontSize: number;
  letterSpacing: number;
  lineSpacing: number;
  trashImportedOriginals: boolean;
  textAlignment: 'left' | 'center' | 'right';
  textFamily: FontFamily;
  textColor: PdfColor;
  penColor: PdfColor;
  markerColor: PdfColor;
  penWidth: number;
  markerWidth: number;
  toolbarTopOffset: number;
  floatingToolbar: boolean;
  autoDetectPageLimit: number;
  keepOriginalBackups: boolean;
  smoothPen: boolean;
  holdShapes: boolean;
  holdHighlighter: boolean;
  snapToText: boolean;
  autoDetectLines: boolean;
  flowAnswerLines: boolean;
}
/** Normalize persisted tool defaults, replacing malformed or out-of-range values with supported defaults. */
export function loadToolPreferences(value: unknown): ToolPreferences {
  const result: ToolPreferences = {
    fontSize: 14,
    letterSpacing: 0,
    lineSpacing: 1.2,
    trashImportedOriginals: false,
    textAlignment: 'left',
    textFamily: 'sans',
    textColor: [0.05, 0.05, 0.05],
    penColor: [0.085, 0.085, 0.085],
    markerColor: [1, 0.84, 0],
    penWidth: 2,
    markerWidth: 14,
    toolbarTopOffset: 0,
    floatingToolbar: true,
    autoDetectPageLimit: 50,
    keepOriginalBackups: true,
    smoothPen: true,
    holdShapes: false,
    holdHighlighter: true,
    snapToText: false,
    autoDetectLines: false,
    flowAnswerLines: true,
  };
  if (!value || typeof value !== 'object') {
    return result;
  }
  const saved = value as Record<string, unknown>;
  for (const key of ['textColor', 'penColor', 'markerColor'] as const) {
    const color: unknown = saved[key];
    if (!Array.isArray(color) || color.length !== 3) {
      continue;
    }
    const red: unknown = color[0];
    const green: unknown = color[1];
    const blue: unknown = color[2];
    if (typeof red !== 'number' || typeof green !== 'number' || typeof blue !== 'number') {
      continue;
    }
    const components: PdfColor = [red, green, blue];
    if (validColor(components)) {
      result[key] = components;
    }
  }
  for (const key of ['fontSize', 'penWidth', 'markerWidth'] as const) {
    const n = saved[key];
    if (
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n >= 1 &&
      n <= (key === 'fontSize' ? 96 : 30)
    ) {
      result[key] = n;
    }
  }
  if (
    typeof saved.letterSpacing === 'number' &&
    Number.isFinite(saved.letterSpacing) &&
    saved.letterSpacing >= 0 &&
    saved.letterSpacing <= 20
  ) {
    result.letterSpacing = saved.letterSpacing;
  }
  if (
    typeof saved.lineSpacing === 'number' &&
    Number.isFinite(saved.lineSpacing) &&
    saved.lineSpacing >= 0.8 &&
    saved.lineSpacing <= 3
  ) {
    result.lineSpacing = saved.lineSpacing;
  }
  if (
    saved.textAlignment === 'left' ||
    saved.textAlignment === 'center' ||
    saved.textAlignment === 'right'
  ) {
    result.textAlignment = saved.textAlignment;
  }
  const offset = saved.toolbarTopOffset;
  if (
    typeof offset === 'number' &&
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset <= MAX_TOOLBAR_TOP_OFFSET
  ) {
    result.toolbarTopOffset = offset;
  }
  const pageLimit = saved.autoDetectPageLimit;
  if (
    typeof pageLimit === 'number' &&
    Number.isInteger(pageLimit) &&
    pageLimit >= 1 &&
    pageLimit <= MAX_AUTO_DETECT_PAGES
  ) {
    result.autoDetectPageLimit = pageLimit;
  }
  if (saved.textFamily === 'sans' || saved.textFamily === 'serif' || saved.textFamily === 'mono') {
    result.textFamily = saved.textFamily;
  }
  for (const key of [
    'trashImportedOriginals',
    'floatingToolbar',
    'keepOriginalBackups',
    'smoothPen',
    'holdShapes',
    'holdHighlighter',
    'snapToText',
    'autoDetectLines',
    'flowAnswerLines',
  ] as const) {
    if (typeof saved[key] === 'boolean') {
      result[key] = saved[key];
    }
  }
  return result;
}
