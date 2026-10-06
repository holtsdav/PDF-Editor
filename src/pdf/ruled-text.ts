import type { Rect } from './text-engine';

export interface RuledLayout { spacing: number; rows: number }
export interface DetectedLine { page: number; rect: Rect }

export function validRuledLayout(layout: RuledLayout, rect: Rect): boolean {
  const firstHeight = rect[3] - rect[1] - (layout.rows - 1) * layout.spacing;
  return Number.isInteger(layout.rows) && layout.rows >= 2 && layout.rows <= 10000
    && Number.isFinite(layout.spacing) && layout.spacing >= 10 && layout.spacing <= 48
    && firstHeight >= 10 && firstHeight <= layout.spacing + 1;
}

/** Extend downwards in whole rows, retaining the top anchor and page bounds. */
export function growRuledBlock(rect: Rect, layout: RuledLayout, rows: number, fontSize: number, bounds: Rect): { rect: Rect; layout?: RuledLayout } {
  const firstHeight = Math.max(rect[3] - rect[1] - (layout.rows - 1) * layout.spacing, fontSize * 1.2 + 2);
  const spacing = Math.max(layout.spacing, firstHeight - 1);
  if (spacing > 48 || firstHeight > rect[3] - bounds[1]) {
    // An oversized font no longer fits the printed pitch; keep an ordinary box.
    return { rect: [rect[0], Math.max(bounds[1], rect[3] - Math.max(rect[3] - rect[1], rows * (fontSize * 1.2) + 2)), rect[2], rect[3]] };
  }
  const capacity = Math.floor((rect[3] - bounds[1] - firstHeight + 0.001) / spacing) + 1;
  const count = Math.min(10000, capacity, Math.max(layout.rows, rows));
  if (count < 2) return { rect: [rect[0], bounds[1], rect[2], rect[3]] };
  return { rect: [rect[0], Math.max(bounds[1], rect[3] - firstHeight - (count - 1) * spacing), rect[2], rect[3]], layout: { spacing, rows: count } };
}

/** Join only neighboring, aligned blanks on one page; occupied lines are barriers. */
export function ruledAnswerBlock(lines: DetectedLine[], target: DetectedLine, occupied: (line: DetectedLine) => boolean): { rect: Rect; layout: RuledLayout } | undefined {
  const sorted = lines.filter(line => line.page === target.page).sort((a, b) => b.rect[1] - a.rect[1] || a.rect[0] - b.rect[0]);
  const index = sorted.findIndex(line => line.rect.every((n, i) => Math.abs(n - target.rect[i]!) < 0.001));
  if (index < 0 || occupied(sorted[index]!)) return;
  const joins = (a: DetectedLine, b: DetectedLine, spacing?: number): boolean => {
    const pitch = a.rect[1] - b.rect[1], ah = a.rect[3] - a.rect[1], bh = b.rect[3] - b.rect[1];
    return !occupied(a) && !occupied(b) && Math.abs(a.rect[0] - b.rect[0]) <= 2 && Math.abs(a.rect[2] - b.rect[2]) <= 2
      && Math.abs(ah - bh) <= 3 && pitch >= Math.max(ah, bh) - 1 && pitch <= Math.min(ah, bh) + 8
      && pitch >= 10 && pitch <= 48 && (spacing === undefined || Math.abs(pitch - spacing) <= 1);
  };
  let first = index, last = index;
  let spacing = index + 1 < sorted.length && joins(sorted[index]!, sorted[index + 1]!) ? sorted[index]!.rect[1] - sorted[index + 1]!.rect[1]
    : index > 0 && joins(sorted[index - 1]!, sorted[index]!) ? sorted[index - 1]!.rect[1] - sorted[index]!.rect[1] : undefined;
  if (spacing === undefined) return;
  while (first > 0 && joins(sorted[first - 1]!, sorted[first]!, spacing)) first--;
  while (last + 1 < sorted.length && joins(sorted[last]!, sorted[last + 1]!, spacing)) last++;
  const rows = last - first + 1;
  // Fit the full span rather than accumulating the first rasterized gap.
  // Fractional printed pitch alternates between neighboring pixel distances.
  spacing = (sorted[first]!.rect[1] - sorted[last]!.rect[1]) / (rows - 1);
  for (let i = first; i <= last; i++) if (Math.abs(sorted[i]!.rect[1] - (sorted[first]!.rect[1] - (i - first) * spacing)) > 1) return;
  const left = Math.max(...sorted.slice(first, last + 1).map(line => line.rect[0]));
  const right = Math.min(...sorted.slice(first, last + 1).map(line => line.rect[2]));
  const rect: Rect = [left, sorted[last]!.rect[1], right, sorted[first]!.rect[3]];
  const layout = { spacing, rows };
  return validRuledLayout(layout, rect) ? { rect, layout } : undefined;
}
