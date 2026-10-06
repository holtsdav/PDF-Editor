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
  const runs: { left: number; right: number; top: number; bottom: number; dotted: boolean; dotWidth: number }[] = [];
  for (let y = 0; y < height; y++) {
    const segments: { left: number; right: number }[] = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (dark(x, y)) { if (start < 0) start = x; }
      else if (start >= 0) { segments.push({ left: start, right: x - 1 }); start = -1; }
    }
    const collect = (maximumGap: number, dotted: boolean) => {
      let group: typeof segments = [];
      const flush = () => {
        if (!group.length) return;
        const left = group[0]!.left, right = group.at(-1)!.right;
        const lengths = group.map(segment => segment.right - segment.left + 1);
        const density = lengths.reduce((sum, length) => sum + length, 0) / (right - left + 1);
        if (right - left < minimum) return;
        const middle = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)]!;
        if (dotted) {
          const spaces = group.slice(1).map((segment, i) => segment.left - group[i]!.right - 1);
          const spacing = [...spaces].sort((a, b) => a - b)[Math.floor(spaces.length / 2)] ?? 0;
          const regular = (values: number[], median: number) => values.filter(value => Math.abs(value - median) <= Math.max(1, sx)).length / values.length >= 0.9;
          if (group.length < 8 || density < 0.12 || density > 0.65 || middle < 0.45 * sx || middle > 2.8 * sx
            || spacing < middle * 0.75 || spacing + middle < 2.8 * sx || spacing + middle > 12 * sx
            || !regular(lengths, middle) || !regular(spaces, spacing)) return;
        } else {
          if (density < 0.58) return;
          // Regular substantial dashes are allowed; irregular glyph baselines are not.
          if (density < 0.84 && (lengths.length < 4 || middle < 4 * sx
            || lengths.filter(length => Math.abs(length - middle) <= Math.max(2, 1.5 * sx)).length / lengths.length < 0.85)) return;
        }
        let previous: typeof runs[number] | undefined;
        for (let i = runs.length - 1; i >= 0; i--) {
          const candidate = runs[i]!;
          if (candidate.dotted === dotted && y - candidate.bottom <= Math.max(2, 2 * sy)
            && Math.abs(candidate.left - left) < 4 * sx && Math.abs(candidate.right - right) < 4 * sx) { previous = candidate; break; }
        }
        if (previous) { previous.bottom = y; previous.dotWidth = Math.max(previous.dotWidth, middle); }
        else if (runs.length < 1000) runs.push({ left, right, top: y, bottom: y, dotted, dotWidth: middle });
      };
      for (const segment of segments) {
        if (group.length && segment.left - group.at(-1)!.right - 1 > maximumGap) { flush(); group = []; }
        group.push(segment);
      }
      flush();
    };
    collect(gap, false); collect(Math.max(gap, Math.round(8 * sx)), true);
  }
  const suggestions: AnswerLine[] = [];
  for (const candidate of runs) {
    const run = { ...candidate };
    // Dots must be compact in both directions; letter stems/dash baselines are not dots.
    if (run.dotted && ((run.bottom - run.top + 1) / sy < run.dotWidth / sx * 0.45
      || (run.bottom - run.top + 1) / sy > run.dotWidth / sx * 2.5)) continue;
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
    // Printed glyphs can have a long dark row at their baseline. A real blank
    // rule has clear paper immediately below it; letters and diagram borders
    // usually continue into that space or rise from one of its endpoints.
    const lowerDepth = Math.max(3, Math.round(5 * sy));
    let lowerInk = 0;
    for (let y = run.bottom + Math.max(3, Math.round(3 * sy)); y < run.bottom + Math.max(3, Math.round(3 * sy)) + lowerDepth; y++)
      for (let x = run.left; x <= run.right; x++) if (dark(x, y)) lowerInk++;
    if (lowerInk / ((run.right - run.left + 1) * lowerDepth) > 0.012) continue;
    const attachedEnd = (edge: number): boolean => {
      const depth = Math.max(6, Math.round(12 * sy)), radius = Math.max(1, Math.round(sx));
      let touches = false;
      for (let y = run.top - Math.max(2, Math.round(2 * sy)); y < run.top; y++)
        for (let x = edge - radius; x <= edge + radius; x++) if (dark(x, y)) touches = true;
      if (!touches) return false;
      let occupiedRows = 0;
      for (let y = run.top - depth; y < run.top - 1; y++) {
        for (let x = edge - Math.max(radius, Math.round(7 * sx)); x <= edge + Math.max(radius, Math.round(7 * sx)); x++) {
          if (dark(x, y)) { occupiedRows++; break; }
        }
      }
      return occupiedRows > depth * 0.6;
    };
    if (attachedEnd(run.left) || attachedEnd(run.right)) continue;
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
    if (suggestions.some(({ rect }) => {
      const left = run.left / sx, right = (run.right + 1) / sx;
      const shorter = Math.min(rect[2] - rect[0], right - left), longer = Math.max(rect[2] - rect[0], right - left);
      return Math.abs(rect[3] - run.top / sy) < 2 && shorter / longer >= 0.85
        && Math.min(rect[2], right) - Math.max(rect[0], left) >= shorter * 0.9;
    })) continue;
    suggestions.push({ rect: [run.left / sx, top / sy, (run.right + 1) / sx, run.top / sy] });
    if (suggestions.length >= 100) break;
  }
  return suggestions;
}
