import type { Point } from './ink-engine.ts';

/** Iterative Ramer–Douglas–Peucker keeps endpoints and corners without a recursive stack. */
export function simplifyStroke(points: Point[], tolerance = 0.3): Point[] {
  if (points.length < 3) return points.map(point => [...point]);
  const keep = new Set([0, points.length - 1]); const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!; const a = points[start]!, b = points[end]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    let maximum = tolerance * tolerance, index = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!;
      const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
      const distance = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (distance > maximum) { maximum = distance; index = i; }
    }
    if (index >= 0) { keep.add(index); stack.push([start, index], [index, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(index => [...points[index]!]);
}
