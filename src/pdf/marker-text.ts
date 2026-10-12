import type { Point } from './ink-engine.ts';
import { hitsStroke, simplifyStroke } from './ink-geometry.ts';

export interface TextWord { start: Point; end: Point; height: number; order: number }
export interface TextBand { points: Point[]; width: number }

/** Only words actually crossed by the gesture participate; separate rows never share a path. */
export function snapTextBands(points: Point[], words: TextWord[]): TextBand[] {
  if (!points.length || words.length > 5000) return [];
  const path = simplifyStroke(points, 0.5), bands: TextBand[] = [];
  for (const word of [...words].sort((a, b) => a.order - b.order)) {
    if (!Number.isFinite(word.height) || word.height < 1 || word.height > 30 || ![...word.start, ...word.end].every(Number.isFinite)
      || !hitsStroke(path, word.start, word.end, word.height / 2)) continue;
    const last = bands.at(-1), dx = word.end[0] - word.start[0], dy = word.end[1] - word.start[1], length = Math.hypot(dx, dy);
    if (length < 0.1) continue;
    const u: Point = [dx / length, dy / length];
    if (last) {
      const a = last.points[0]!, b = last.points[1]!, gap: Point = [word.start[0] - b[0], word.start[1] - b[1]];
      const along = gap[0] * u[0] + gap[1] * u[1], across = Math.abs(gap[0] * u[1] - gap[1] * u[0]);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l && ((b[0] - a[0]) * u[0] + (b[1] - a[1]) * u[1]) / l > 0.999 && across < Math.min(last.width, word.height) * 0.25
        && along >= -0.1 && along <= word.height * 1.5 && Math.abs(last.width - word.height) < 1) {
        last.points[1] = [...word.end]; continue;
      }
    }
    bands.push({ points: [[...word.start], [...word.end]], width: word.height });
  }
  return bands;
}
