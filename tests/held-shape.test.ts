import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape, levelPolygon } from '../src/pdf/ink-assist.ts';
import { HeldShape } from '../src/pdf/held-shape.ts';
import type { Point } from '../src/pdf/ink-engine.ts';

test('near-circular loops become exact circles, distinct from elongated ellipses', () => {
  for (const ratio of [1, 1.1, 1.2]) {
    const points: Point[] = Array.from({ length: 97 }, (_, i) => [200 + 50 * Math.cos(i / 96 * Math.PI * 2), 200 + 50 / ratio * Math.sin(i / 96 * Math.PI * 2)]);
    const shape = recognizeShape(points)!; assert.equal(shape.kind, 'circle');
    const center: Point = [(Math.min(...shape.points.map(p => p[0])) + Math.max(...shape.points.map(p => p[0]))) / 2, (Math.min(...shape.points.map(p => p[1])) + Math.max(...shape.points.map(p => p[1]))) / 2];
    const radii = shape.points.map(([x, y]) => Math.hypot(x - center[0], y - center[1]));
    assert(Math.max(...radii) - Math.min(...radii) < 0.001);
  }
  assert.equal(recognizeShape(Array.from({ length: 97 }, (_, i) => [200 + 80 * Math.cos(i / 96 * Math.PI * 2), 200 + 30 * Math.sin(i / 96 * Math.PI * 2)]))?.kind, 'ellipse');
});
test('held line endpoint follows movement, stays snapped and reverses without accumulated drift', () => {
  const base = { kind: 'line' as const, points: [[30, 40], [120, 80]] as Point[] }, hold = new HeldShape(base, [120, 80]);
  assert.deepEqual(hold.resize([200, 150], [0, 0, 600, 800]).points, [[30, 40], [200, 150]]);
  for (let i = 0; i < 1000; i++) hold.resize([120 + i % 300, 100], [0, 0, 600, 800]);
  assert.deepEqual(hold.resize([120, 80], [0, 0, 600, 800]), base);
});
test('held closed shapes resize in both directions and stay inside the page without changing kind', () => {
  const inputs: Point[][] = [
    [[100, 100], [220, 100], [220, 200], [100, 200], [100, 100]],
    [[100, 100], [180, 220], [240, 100], [100, 100]],
    Array.from({ length: 97 }, (_, i) => [200 + 60 * Math.cos(i / 96 * Math.PI * 2), 200 + 60 * Math.sin(i / 96 * Math.PI * 2)]),
    Array.from({ length: 97 }, (_, i) => [200 + 80 * Math.cos(i / 96 * Math.PI * 2), 200 + 30 * Math.sin(i / 96 * Math.PI * 2)]),
    [[100, 100], [220, 100], [190, 80], [220, 100], [190, 120]]
  ];
  for (const points of inputs) {
    const shape = recognizeShape(points)!, pointer = points.at(-1)!, hold = new HeldShape(shape, pointer);
    for (const delta of [[50, 40], [-50, -30], [2000, 2000], [-2000, -2000]]) {
      const resized = hold.resize([pointer[0] + delta[0]!, pointer[1] + delta[1]!], [0, 0, 600, 800]);
      assert.equal(resized.kind, shape.kind); assert.notDeepEqual(resized.points, shape.points);
      assert(resized.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 600 && y >= 0 && y <= 800));
      if (shape.kind !== 'arrow') assert.deepEqual(resized.points[0], resized.points.at(-1));
    }
    assert.deepEqual(hold.resize(pointer, [0, 0, 600, 800]).points, shape.points);
  }
});


test('near-level polygons snap to exact page axes and stay level while held; intentional rotations remain', () => {
  for (const kind of ['rectangle', 'triangle'] as const) for (const degrees of [-7, -3, 3, 7, 87, 93, 15, 35]) {
    const vertices: Point[] = kind === 'rectangle' ? [[-70, -30], [70, -30], [70, 30], [-70, 30], [-70, -30]] : [[-70, -30], [70, -30], [0, 65], [-70, -30]];
    const angle = degrees * Math.PI / 180, points = vertices.map<Point>(([x, y]) => [200 + x * Math.cos(angle) - y * Math.sin(angle), 200 + x * Math.sin(angle) + y * Math.cos(angle)]);
    const shape = levelPolygon({ kind, points });
    const near = Math.abs(degrees) <= 7 || Math.abs(degrees - 90) <= 7;
    const axisEdge = (input: Point[]) => input.slice(1).some((p, i) => Math.min(Math.abs(p[0] - input[i]![0]), Math.abs(p[1] - input[i]![1])) < 1e-8);
    assert.equal(axisEdge(shape.points), near, `${kind} ${degrees}`);
    if (near) {
      const held = new HeldShape(shape, shape.points.at(-1)!);
      assert(axisEdge(held.resize([shape.points[0]![0] + 40, shape.points[0]![1] + 30], [0, 0, 600, 800]).points));
    } else assert.deepEqual(shape.points, points);
  }
});


test('recognition itself levels slightly tilted rectangles and triangles', () => {
  for (const input of [ [[100, 100], [250, 100], [250, 180], [100, 180], [100, 100]], [[100, 100], [260, 100], [180, 220], [100, 100]] ] as Point[][]) {
    const angle = 4 * Math.PI / 180;
    const shape = recognizeShape(input.map<Point>(([x, y]) => [200 + (x - 180) * Math.cos(angle) - (y - 150) * Math.sin(angle), 200 + (x - 180) * Math.sin(angle) + (y - 150) * Math.cos(angle)]))!;
    assert(shape.kind === 'rectangle' || shape.kind === 'triangle');
    assert(shape.points.slice(1).some((p, i) => Math.abs(p[1] - shape.points[i]![1]) < 1e-8));
  }
});
