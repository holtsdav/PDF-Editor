import { validColor } from './text-format.ts';
import type { FontFamily, PdfColor } from './text-format';
export const MAX_TOOLBAR_TOP_OFFSET = 160;
export interface ToolPreferences { fontSize: number; textFamily: FontFamily; textColor: PdfColor; penColor: PdfColor; markerColor: PdfColor; penWidth: number; markerWidth: number; toolbarTopOffset: number; smoothPen: boolean; holdShapes: boolean; holdHighlighter: boolean; autoDetectLines: boolean; flowAnswerLines: boolean }
export function loadToolPreferences(value: unknown): ToolPreferences {
  const result: ToolPreferences = { fontSize: 14, textFamily: 'sans', textColor: [0.05, 0.05, 0.05], penColor: [0.085, 0.085, 0.085], markerColor: [1, 0.84, 0], penWidth: 2, markerWidth: 14, toolbarTopOffset: 0, smoothPen: true, holdShapes: false, holdHighlighter: true, autoDetectLines: false, flowAnswerLines: true };
  if (!value || typeof value !== 'object') return result;
  const saved = value as Record<string, unknown>;
  for (const key of ['textColor', 'penColor', 'markerColor'] as const) {
    const color = saved[key]; if (Array.isArray(color) && validColor(color as PdfColor)) result[key] = [...color] as PdfColor;
  }
  for (const key of ['fontSize', 'penWidth', 'markerWidth'] as const) { const n = saved[key]; if (typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= (key === 'fontSize' ? 96 : 30)) result[key] = n; }
  const offset = saved.toolbarTopOffset;
  if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && offset <= MAX_TOOLBAR_TOP_OFFSET) result.toolbarTopOffset = offset;
  if (saved.textFamily === 'sans' || saved.textFamily === 'serif' || saved.textFamily === 'mono') result.textFamily = saved.textFamily;
  for (const key of ['smoothPen', 'holdShapes', 'holdHighlighter', 'autoDetectLines', 'flowAnswerLines'] as const) if (typeof saved[key] === 'boolean') result[key] = saved[key];
  return result;
}
