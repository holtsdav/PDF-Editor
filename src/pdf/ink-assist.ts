import { getStrokePoints } from 'perfect-freehand';
import type { Point } from './ink-engine.ts';
import { simplifyStroke } from './ink-geometry.ts';

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const length = (p: Point[]) => p.slice(1).reduce((sum, point, i) => sum + distance(point, p[i]!), 0);
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy;
  return distance(p, mix(a, b, squared ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared)) : 0));
}

/** Even arc-length samples make fitting independent of pointer speed/dwell. */
export function resampleInk(points: Point[], step: number): Point[] {
  if (!points.length) return [];
  const result: Point[] = [[...points[0]!]]; let remaining = step;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1]!; const b = points[i]!; let span = distance(a, b);
    while (span >= remaining && result.length < 12000) { a = mix(a, b, remaining / span); result.push(a); span -= remaining; remaining = step; }
    remaining -= span;
  }
  if (distance(result.at(-1)!, points.at(-1)!) > 0.001) result.push([...points.at(-1)!]);
  return result;
}

/** Constant-width centerline: preview, hit testing and PDF use these same points. */
export function smoothInk(points: Point[], enabled: boolean): Point[] {
  if (!enabled || points.length < 3 || length(points) < 3) return points.map(p => [...p]);
  const sampled = resampleInk(points, Math.max(0.8, length(points) / 3000));
  const stabilized = getStrokePoints(sampled, { size: 1, streamline: 0.45, last: true }).map(p => p.point);
  if (stabilized.length < 3) return points.map(p => [...p]);
  // A small corner-cutting pass rounds sample jitter, without filling a stroke
  // outline or introducing different on-screen and exported path geometries.
  const result: Point[] = [[...points[0]!]];
  for (let i = 0; i < stabilized.length - 1; i++) { result.push(mix(stabilized[i]!, stabilized[i + 1]!, 0.25), mix(stabilized[i]!, stabilized[i + 1]!, 0.75)); }
  result.push([...points.at(-1)!]);
  return simplifyStroke(result, 0.08);
}

export interface RecognizedShape { kind: 'line' | 'rectangle' | 'triangle' | 'ellipse' | 'circle' | 'arrow'; points: Point[] }

/** Keep deliberate rotations; remove small hand-drawn tilts around page axes. */
export function levelPolygon(shape: RecognizedShape, tolerance = 8 * Math.PI / 180): RecognizedShape {
  if (shape.kind !== 'rectangle' && shape.kind !== 'triangle') return shape;
  const vertices = shape.points.slice(0, -1);
  const edges = vertices.map((p, i) => {
    const q = vertices[(i + 1) % vertices.length]!;
    const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const turn = Math.round(angle / (Math.PI / 2)) * Math.PI / 2 - angle;
    return { turn, length: Math.hypot(q[0] - p[0], q[1] - p[1]) };
  }).sort((a, b) => b.length - a.length);
  const edge = edges[0]; if (!edge || Math.abs(edge.turn) > tolerance) return shape;
  const center = vertices.reduce<Point>((sum, p) => [sum[0] + p[0] / vertices.length, sum[1] + p[1] / vertices.length], [0, 0]);
  const c = Math.cos(edge.turn), s = Math.sin(edge.turn);
  const points = vertices.map<Point>(([x, y]) => [center[0] + (x - center[0]) * c - (y - center[1]) * s, center[1] + (x - center[0]) * s + (y - center[1]) * c]);
  points.push([...points[0]!]);
  return { ...shape, points };
}

function fits(source: Point[], target: Point[], diagonal: number, rms = 0.035, maximum = 0.075): boolean {
  const errors = source.map(p => Math.min(...target.slice(1).map((b, i) => segmentDistance(p, target[i]!, b))));
  return Math.max(...errors) < diagonal * maximum && Math.sqrt(errors.reduce((sum, v) => sum + v * v, 0) / errors.length) < diagonal * rms;
}

/** Find the actual loop, allowing a short lead-in or finishing hook. The bounds
 * on discarded travel and closure gap prevent closing a C, spiral or scribble. */
function closedLoop(points: Point[], diagonal: number): Point[] | null {
  const end = points.length - 1, allowance = Math.floor(end * 0.2);
  let best: { start: number; end: number; score: number } | undefined;
  for (let a = 0; a <= allowance; a++) for (let b = end - allowance; b <= end; b++) {
    const trimmed = (a + end - b) / end;
    if (trimmed > 0.2) continue;
    const gap = distance(points[a]!, points[b]!) / diagonal;
    if (gap > 0.14) continue;
    const score = gap + trimmed * 0.35;
    if (!best || score < best.score) best = { start: a, end: b, score };
  }
  if (!best) return null;
  const loop = points.slice(best.start, best.end + 1);
  const joint = mix(loop[0]!, loop.at(-1)!, 0.5);
  loop[0] = joint; loop[loop.length - 1] = joint;
  return resampleInk(loop, length(loop) / 96);
}
function corners(points: Point[], diagonal: number, tolerance = 0.07): Point[] {
  const far = points.reduce((best, p, i) => distance(p, points[0]!) > distance(points[best]!, points[0]!) ? i : best, 0);
  const rotated = [...points.slice(far), ...points.slice(0, far), points[far]!];
  const result = simplifyStroke(rotated, diagonal * tolerance).slice(0, -1);
  let changed = true;
  while (changed && result.length > 3) {
    changed = false;
    for (let i = 0; i < result.length; i++) if (segmentDistance(result[i]!, result[(i + result.length - 1) % result.length]!, result[(i + 1) % result.length]!) < diagonal * tolerance) {
      result.splice(i, 1); changed = true; break;
    }
  }
  return result;
}

/** Conservative geometric fitting with explicit rejection, not a classifier that
 * always returns a best guess. Called only after a deliberate stationary hold. */
export function recognizeShape(input: Point[], marker = false, minimum = 12): RecognizedShape | null {
  if (input.length < 2 || input.some(p => !p.every(Number.isFinite))) return null;
  const travel = length(input), first = input[0]!, last = input.at(-1)!, chord = distance(first, last);
  if (travel < minimum) return null;
  if (marker) return chord >= minimum ? { kind: 'line', points: [[...first], [...last]] } : null;
  let points = resampleInk(input, travel / 96);
  let xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
  let diagonal = Math.hypot(width, height);
  if (diagonal < minimum) return null;
  if (chord >= minimum && travel / chord < 1.12 && fits(points, [first, last], diagonal)) return { kind: 'line', points: [[...first], [...last]] };

  // Single-stroke arrow: shaft -> tip -> wing -> tip -> opposite wing.
  const arrow = simplifyStroke(input, diagonal * 0.03);
  if (arrow.length === 5 || arrow.length === 6) {
    const [a, tip, wing, returnTip, other] = arrow as [Point, Point, Point, Point, Point];
    const shaft = distance(a, tip), u: Point = [(tip[0] - a[0]) / shaft, (tip[1] - a[1]) / shaft];
    const project = (p: Point): Point => [(p[0] - tip[0]) * u[0] + (p[1] - tip[1]) * u[1], -(p[0] - tip[0]) * u[1] + (p[1] - tip[1]) * u[0]];
    const c = project(wing), d = project(other);
    if (shaft >= minimum && distance(returnTip, tip) < shaft * 0.09 && (arrow.length === 5 || distance(arrow[5]!, tip) < shaft * 0.09)
      && c[0] < -shaft * 0.08 && d[0] < -shaft * 0.08 && c[0] > -shaft * 0.5 && d[0] > -shaft * 0.5
      && c[1] * d[1] < 0 && Math.min(Math.abs(c[1]), Math.abs(d[1])) > shaft * 0.06
      && Math.max(Math.abs(c[1]), Math.abs(d[1])) < shaft * 0.4 && Math.abs(c[0] - d[0]) < shaft * 0.15) {
      const back = (c[0] + d[0]) / 2, side = (Math.abs(c[1]) + Math.abs(d[1])) / 2;
      const wingAt = (sign: number): Point => [tip[0] + back * u[0] - side * sign * u[1], tip[1] + back * u[1] + side * sign * u[0]];
      const target: Point[] = [a, tip, wingAt(Math.sign(c[1])), tip, wingAt(Math.sign(d[1]))];
      if (fits(points, target, diagonal)) return { kind: 'arrow', points: target };
    }
  }
  if (width < minimum / 2 || height < minimum / 2) return null;
  const loop = closedLoop(points, diagonal); if (!loop) return null;
  points = loop; xs = points.map(p => p[0]); ys = points.map(p => p[1]);
  diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const loopLength = length(loop);
  const closed: Point[] = [...points, points[0]!];
  const polygon = corners(points, diagonal);
  const area = (vertices: Point[]) => Math.abs(vertices.reduce((s, a, i) => { const b = vertices[(i + 1) % vertices.length]!; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  // Rounded triangle tips can leave extra simplified vertices. Try a coarser
  // candidate, but still require the entire original loop to fit its edges.
  const triangle = polygon.length === 3 ? polygon : corners(points, diagonal, 0.1);
  if (triangle.length === 3 && area(triangle) > diagonal * diagonal * 0.12) {
    const target = [...triangle, triangle[0]!];
    if (fits(closed, target, diagonal, 0.055, 0.12) && loopLength / length(target) > 0.82 && loopLength / length(target) < 1.2) return levelPolygon({ kind: 'triangle', points: target });
  }
  if (polygon.length === 4 && area(polygon) > diagonal * diagonal * 0.15) {
    const edges = polygon.map((a, i) => { const b = polygon[(i + 1) % 4]!, n = distance(a, b); return [(b[0] - a[0]) / n, (b[1] - a[1]) / n] as Point; });
    if (edges.every((a, i) => Math.abs(a[0] * edges[(i + 1) % 4]![0] + a[1] * edges[(i + 1) % 4]![1]) < 0.4)) {
      const u = edges[0]!, v: Point = [-u[1], u[0]];
      const projected = polygon.map(p => [p[0] * u[0] + p[1] * u[1], p[0] * v[0] + p[1] * v[1]] as Point);
      const x = projected.map(p => p[0]), y = projected.map(p => p[1]), left = Math.min(...x), right = Math.max(...x), top = Math.min(...y), bottom = Math.max(...y);
      const target = ([[left, top], [right, top], [right, bottom], [left, bottom], [left, top]] as Point[]).map(([a, b]) => [a * u[0] + b * v[0], a * u[1] + b * v[1]] as Point);
      if (fits(closed, target, diagonal, 0.055, 0.12) && loopLength / length(target) > 0.82 && loopLength / length(target) < 1.2) return levelPolygon({ kind: 'rectangle', points: target });
    }
  }
  // Ellipse fit in principal axes. Reject open loops, corners, retracing and
  // incomplete revolutions rather than turning ordinary handwriting into ovals.
  const mean: Point = [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) { const x = p[0] - mean[0], y = p[1] - mean[1]; xx += x * x; yy += y * y; xy += x * y; }
  const angle = Math.atan2(2 * xy, xx - yy) / 2, c = Math.cos(angle), s = Math.sin(angle);
  const local = points.map(p => [(p[0] - mean[0]) * c + (p[1] - mean[1]) * s, -(p[0] - mean[0]) * s + (p[1] - mean[1]) * c] as Point);
  const lx = local.map(p => p[0]), ly = local.map(p => p[1]);
  const cx = (Math.max(...lx) + Math.min(...lx)) / 2, cy = (Math.max(...ly) + Math.min(...ly)) / 2;
  let rx = (Math.max(...lx) - Math.min(...lx)) / 2, ry = (Math.max(...ly) - Math.min(...ly)) / 2;
  if (Math.min(rx, ry) < minimum / 3 || Math.max(rx, ry) / Math.min(rx, ry) > 6) return null;
  const radial = local.map(p => Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1));
  const angles = local.map(p => Math.atan2((p[1] - cy) / ry, (p[0] - cx) / rx));
  let signed = 0, absolute = 0;
  for (let i = 1; i < angles.length; i++) { const delta = Math.atan2(Math.sin(angles[i]! - angles[i - 1]!), Math.cos(angles[i]! - angles[i - 1]!)); signed += delta; absolute += Math.abs(delta); }
  if (Math.max(...radial) > 0.28 || Math.sqrt(radial.reduce((sum, r) => sum + r * r, 0) / radial.length) > 0.12
    || Math.abs(signed) < 5.5 || Math.abs(signed) > 6.7 || absolute > 7) return null;
  const circle = Math.max(rx, ry) / Math.min(rx, ry) <= 1.25;
  if (circle) rx = ry = (rx + ry) / 2;
  const target: Point[] = Array.from({ length: 97 }, (_, i) => { const a = i / 96 * Math.PI * 2, x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a); return [mean[0] + x * c - y * s, mean[1] + x * s + y * c]; });
  target[target.length - 1] = [...target[0]!];
  return { kind: circle ? 'circle' : 'ellipse', points: target };
}

/** Timer policy independent of browser timers for deterministic hold tests. */
export class DrawHold {
  private anchor?: Point;
  private since = 0;
  update(point: Point, now: number, tolerance: number): boolean {
    if (!this.anchor || distance(point, this.anchor) > tolerance) { this.anchor = [...point]; this.since = now; return true; }
    return false;
  }
  ready(now: number): boolean { return !!this.anchor && now - this.since >= 650; }
}
