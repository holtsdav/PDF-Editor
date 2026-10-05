import type { RecognizedShape } from './ink-assist.ts';
import type { Point } from './ink-engine.ts';
import type { Rect } from './text-engine.ts';

/** Always transform the original fit: repeated pointer samples cannot accumulate drift. */
export class HeldShape {
  private shape: RecognizedShape;
  private pointer: Point;
  constructor(shape: RecognizedShape, pointer: Point) { this.shape = shape; this.pointer = pointer; }

  resize(pointer: Point, bounds: Rect, minimum = 2): RecognizedShape {
    const source = this.shape.points, delta: Point = [pointer[0] - this.pointer[0], pointer[1] - this.pointer[1]];
    let target: Point[];
    if (this.shape.kind === 'line') {
      const first = source[0]!, last = source.at(-1)!;
      const end: Point = [last[0] + delta[0], last[1] + delta[1]];
      target = Math.hypot(end[0] - first[0], end[1] - first[1]) >= minimum ? [[...first], end] : source;
    } else if (this.shape.kind === 'arrow') {
      const anchor = source[0]!, old = this.pointer;
      const a: Point = [old[0] - anchor[0], old[1] - anchor[1]], b: Point = [pointer[0] - anchor[0], pointer[1] - anchor[1]];
      const squared = a[0] ** 2 + a[1] ** 2;
      const c = squared ? (a[0] * b[0] + a[1] * b[1]) / squared : 1;
      const s = squared ? (a[0] * b[1] - a[1] * b[0]) / squared : 0;
      target = Math.hypot(...b) < minimum ? source : source.map(([x, y]) => [anchor[0] + (x - anchor[0]) * c - (y - anchor[1]) * s, anchor[1] + (x - anchor[0]) * s + (y - anchor[1]) * c]);
    } else {
      // Rectangle axes preserve its drawn rotation; other loops use page axes.
      const edge: Point = this.shape.kind === 'rectangle' ? [source[1]![0] - source[0]![0], source[1]![1] - source[0]![1]] : [1, 0];
      const size = Math.hypot(...edge), u: Point = [edge[0] / size, edge[1] / size], v: Point = [-u[1], u[0]];
      const project = ([x, y]: Point): Point => [x * u[0] + y * u[1], x * v[0] + y * v[1]];
      const local = source.map(project), p = project(this.pointer), d = project(delta);
      const x = local.map(p => p[0]), y = local.map(p => p[1]);
      const left = Math.min(...x), right = Math.max(...x), bottom = Math.min(...y), top = Math.max(...y);
      const anchor: Point = [p[0] >= (left + right) / 2 ? left : right, p[1] >= (bottom + top) / 2 ? bottom : top];
      const sx = Math.max(minimum / (right - left), 1 + d[0] / (anchor[0] === left ? right - left : left - right));
      const sy = Math.max(minimum / (top - bottom), 1 + d[1] / (anchor[1] === bottom ? top - bottom : bottom - top));
      if (this.shape.kind === 'circle') {
        const center: Point = [(left + right) / 2, (bottom + top) / 2];
        const radius = Math.hypot(p[0] - center[0], p[1] - center[1]);
        const scale = Math.max(minimum / (right - left), radius ? Math.hypot(p[0] + d[0] - center[0], p[1] + d[1] - center[1]) / radius : 1);
        target = local.map(([x, y]) => [center[0] + (x - center[0]) * scale, center[1] + (y - center[1]) * scale]);
      } else target = local.map(([x, y]) => [anchor[0] + (x - anchor[0]) * sx, anchor[1] + (y - anchor[1]) * sy]);
      target = target.map(([x, y]) => [x * u[0] + y * v[0], x * u[1] + y * v[1]]);
    }
    const inside = (points: Point[]) => points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3]);
    if (!inside(target)) {
      // Interpolate the entire transform to the page edge, preserving its shape.
      let low = 0, high = 1;
      const at = (t: number): Point[] => source.map(([x, y], i) => [x + (target[i]![0] - x) * t, y + (target[i]![1] - y) * t]);
      for (let i = 0; i < 32; i++) { const mid = (low + high) / 2; if (inside(at(mid))) low = mid; else high = mid; }
      target = at(low);
    }
    return { kind: this.shape.kind, points: target };
  }
}
