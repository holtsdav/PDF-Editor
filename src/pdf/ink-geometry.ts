import type { Point } from './ink-engine.ts';
import type { Rect } from './text-engine.ts';
import { transformBox } from './box-geometry.ts';
import type { ResizeHandle } from './box-geometry.ts';

/** Shift-corner resizing retains the aspect ratio and the opposite anchor, even at page edges. */
export function resizeInkFrame(rect: Rect, bounds: Rect, delta: Point, handle: ResizeHandle, minimum: number, proportional = false): Rect {
  const next = transformBox(rect, bounds, delta, handle, [minimum, minimum]);
  if (!proportional || handle.length !== 2) return next;
  const left = handle.includes('w'), top = handle.includes('n');
  const x = left ? rect[2] : rect[0], y = top ? rect[3] : rect[1], width = rect[2] - rect[0], height = rect[3] - rect[1];
  const sx = (next[2] - next[0]) / width, sy = (next[3] - next[1]) / height;
  const requested = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
  const maximum = Math.min((left ? x - bounds[0] : bounds[2] - x) / width, (top ? y - bounds[1] : bounds[3] - y) / height);
  const scale = Math.min(maximum, Math.max(Math.min(maximum, Math.max(minimum / width, minimum / height)), requested));
  return [left ? x - width * scale : x, top ? y - height * scale : y, left ? x : x + width * scale, top ? y : y + height * scale];
}

/** Scale centerline geometry; fixed-width caps retain their space inside the selected frame. */
export function resizeInkPoints(points: Point[], from: Rect, to: Rect): Point[] {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const min: Point = [Math.min(...xs), Math.min(...ys)], max: Point = [Math.max(...xs), Math.max(...ys)];
  return points.map(point => point.map((value, axis) => {
    const low = to[axis]! + min[axis]! - from[axis]!, high = to[axis + 2]! - (from[axis + 2]! - max[axis]!);
    const span = max[axis]! - min[axis]!;
    return span > 0.001 ? low + (value - min[axis]!) / span * Math.max(0, high - low) : (low + high) / 2;
  }) as Point);
}

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
