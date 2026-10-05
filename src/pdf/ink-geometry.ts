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

function distance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  return x * y < 0 && z * w < 0;
}
/** Continuous hit test prevents a fast eraser from skipping a narrow stroke. */
export function hitsStroke(points: Point[], from: Point, to: Point, radius: number): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[Math.min(i + 1, points.length - 1)]!;
    if (intersects(a, b, from, to) || Math.min(distance(a, from, to), distance(b, from, to), distance(from, a, b), distance(to, a, b)) <= radius) return true;
  }
  return false;
}
