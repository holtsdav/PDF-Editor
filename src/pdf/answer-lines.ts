import type { Rect } from './text-engine.ts';

export interface PagePixels { width: number; height: number; data: Uint8ClampedArray }
export interface AnswerLine { rect: Rect }

/** Local raster heuristic, not OCR. Returns suggestions only; never writes a PDF. */
export function detectAnswerLines(image: PagePixels, pageWidth: number, pageHeight: number): AnswerLine[] {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 2_000_000
    || data.length !== width * height * 4 || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) return [];
  const sx = width / pageWidth, sy = height / pageHeight;
  const dark = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const i = (y * width + x) * 4;
    return data[i + 3]! > 128 && data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722 < 175;
  };
  const minimum = Math.max(30, Math.round(45 * sx)), gap = Math.max(2, Math.round(4 * sx));
  const runs: { left: number; right: number; top: number; bottom: number }[] = [];
  for (let y = 0; y < height; y++) {
    let start = -1, last = -1, count = 0;
    const flush = () => {
      if (start < 0 || last - start < minimum || count / (last - start + 1) < 0.58) return;
      if (count / (last - start + 1) < 0.84) {
        // Broken rules have regular, substantial dashes. Glyph baselines have
        // short, uneven segments and must never become answer suggestions.
        const segments: number[] = []; let length = 0;
        for (let x = start; x <= last + 1; x++) {
          if (dark(x, y)) length++;
          else if (length) { segments.push(length); length = 0; }
        }
        const middle = [...segments].sort((a, b) => a - b)[Math.floor(segments.length / 2)] ?? 0;
        if (segments.length < 4 || middle < 4 * sx || segments.filter(length => Math.abs(length - middle) <= Math.max(2, 1.5 * sx)).length / segments.length < 0.85) return;
      }
      let previous: typeof runs[number] | undefined;
      for (let i = runs.length - 1; i >= 0; i--) {
        const candidate = runs[i]!;
        if (y - candidate.bottom <= Math.max(2, 2 * sy) && Math.abs(candidate.left - start) < 4 * sx && Math.abs(candidate.right - last) < 4 * sx) { previous = candidate; break; }
      }
      if (previous) previous.bottom = y;
      else if (runs.length < 1000) runs.push({ left: start, right: last, top: y, bottom: y });
    };
    for (let x = 0; x < width; x++) {
      if (dark(x, y)) { if (start < 0) start = x; last = x; count++; }
      else if (start >= 0 && x - last > gap) { flush(); start = -1; count = 0; }
    }
    flush();
  }
  const suggestions: AnswerLine[] = [];
  for (const candidate of runs) {
    const run = { ...candidate };
    // Raster gap tolerance can join a nearby frame edge to an inset answer
    // rule. Remove only a narrow, detached vertical fragment: connected table
    // borders have no real white gap and must retain their crossing rejection.
    const verticalBorder = (x: number): boolean => {
      const aboveDepth = Math.max(4, Math.round(14 * sy)), belowDepth = aboveDepth;
      let above = 0, below = 0;
      for (let d = 2; d < 2 + aboveDepth; d++) if (dark(x, run.top - d)) above++;
      for (let d = 2; d < 2 + belowDepth; d++) if (dark(x, run.bottom + d)) below++;
      return above > aboveDepth * 0.7 && below > belowDepth * 0.7;
    };
    const onRule = (x: number): boolean => {
      for (let y = run.top; y <= run.bottom; y++) if (dark(x, y)) return true;
      return false;
    };
    const detachedEdge = (edge: number, direction: number): number => {
      const maximum = Math.max(2, Math.ceil(2 * sx));
      let x = edge, thickness = 0;
      while (thickness < maximum && onRule(x) && verticalBorder(x)) { thickness++; x += direction; }
      if (!thickness || onRule(x)) return edge;
      let whitespace = 0;
      while (whitespace <= gap && !onRule(x)) { whitespace++; x += direction; }
      return whitespace >= Math.ceil(2 * sx) && whitespace <= gap && onRule(x) ? x : edge;
    };
    run.left = detachedEdge(run.left, 1); run.right = detachedEdge(run.right, -1);
    if (run.right - run.left < minimum) continue;
    if ((run.bottom - run.top + 1) / sy > 3 || run.top / sy < 20 || (height - run.bottom) / sy < 12
      || run.left / sx < 8 || (width - run.right) / sx < 8) continue;
    let top = Math.max(0, run.top - Math.round(18 * sy));
    const bottom = run.top - Math.max(1, Math.round(2 * sy));
    // Crop shallow label tails at either end, without turning underlined headings into fields.
    const occupiedColumn = (x: number) => {
      let count = 0; for (let y = top; y < bottom; y++) if (dark(x, y)) count++;
      return count >= Math.max(2, 2 * sy);
    };
    const trimLimit = Math.min(Math.round(28 * sx), Math.floor((run.right - run.left) * 0.15));
    const occupied = [];
    for (let x = run.left; x <= run.right; x++) if (occupiedColumn(x)) occupied.push(x);
    if (occupied.some(x => verticalBorder(x))) continue;
    if (occupied.length >= Math.max(3, 3 * sx) && occupied.every(x => x < run.left + trimLimit)) run.left = occupied.at(-1)! + Math.ceil(3 * sx);
    else if (occupied.length >= Math.max(3, 3 * sx) && occupied.every(x => x > run.right - trimLimit)) run.right = occupied[0]! - Math.ceil(3 * sx);
    if (run.right - run.left < minimum) continue;
    // Nearby text above an otherwise blank line limits field height. Text directly
    // above a heading's underline leaves too little typing room and is rejected.
    for (let y = bottom - 1; y >= top; y--) {
      let count = 0; for (let x = run.left; x <= run.right; x++) if (dark(x, y)) count++;
      if (count / (run.right - run.left + 1) > 0.04) { top = y + Math.ceil(2 * sy); break; }
    }
    if ((run.top - top) / sy < 10) continue;
    let occupiedPixels = 0, total = 0, crossings = 0;
    for (let x = run.left - Math.ceil(2 * sx); x <= run.right + Math.ceil(2 * sx); x++) {
      let vertical = 0, below = 0;
      for (let y = top; y < bottom; y++) { if (dark(x, y)) { occupiedPixels++; vertical++; } total++; }
      const depth = Math.max(4, Math.round(14 * sy));
      for (let y = run.bottom + 2; y < run.bottom + 2 + depth; y++) if (dark(x, y)) below++;
      if (vertical > (bottom - top) * 0.7 || below > depth * 0.7) crossings++;
    }
    if (!total || occupiedPixels / total > 0.025 || crossings > 0) continue;
    // Pixel coordinates are top-down; caller converts these page-unit boxes to PDF coordinates.
    suggestions.push({ rect: [run.left / sx, top / sy, (run.right + 1) / sx, run.top / sy] });
    if (suggestions.length >= 100) break;
  }
  return suggestions;
}
