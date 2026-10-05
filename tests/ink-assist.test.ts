import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { DrawHold, recognizeShape, resampleInk, smoothInk } from '../src/pdf/ink-assist.ts';
import { readTextPdf } from '../src/pdf/text-engine.ts';
import { TextSession } from '../src/pdf/text-session.ts';
import { renamedPdfPath } from '../src/pdf/file-name.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';
import type { Point } from '../src/pdf/ink-engine.ts';

const shapes: Record<string, Point[]> = {
  line: [[0, 0], [20, 1], [50, -1], [100, 0]],
  rectangle: [[0, 0], [100, 0], [100, 70], [0, 70], [0, 0]],
  triangle: [[0, 0], [50, 90], [100, 0], [0, 0]],
  arrow: [[0, 0], [100, 0], [80, -20], [100, 0], [80, 20]],
  ellipse: Array.from({ length: 97 }, (_, i) => [60 + 50 * Math.cos(i / 96 * Math.PI * 2), 80 + 30 * Math.sin(i / 96 * Math.PI * 2)])
};
test('rough drawn loops tolerate rounded corners, imperfect closure and short finishing tails', async () => {
  // Position-normalized geometry from the anonymous development worksheet.
  // These strokes were rejected by 0.7.0 despite passing ideal-shape tests.
  const samples = JSON.parse(await readFile(new URL('./fixtures/rough-shapes.json', import.meta.url), 'utf8')) as { kind: string; points: Point[] }[];
  for (const [i, sample] of samples.entries()) for (const scale of [0.6, 1, 3]) for (const angle of [0, 0.4, 1.57, 2.3]) {
    const points = sample.points.map(([x, y]) => [200 + scale * (x * Math.cos(angle) - y * Math.sin(angle)), 200 + scale * (x * Math.sin(angle) + y * Math.cos(angle))] as Point);
    assert.equal(recognizeShape(points)?.kind, sample.kind, `sample ${i}, scale ${scale}, rotation ${angle}`);
    assert.equal(recognizeShape([...points].reverse())?.kind, sample.kind, `reversed sample ${i}`);
    const result = recognizeShape(points)!;
    assert(result.points.every(p => p.every(Number.isFinite)));
    assert.deepEqual(result.points[0], result.points.at(-1));
  }
});
test('shape fitting handles rotated, reversed and unevenly sampled diagrams', () => {
  for (const [kind, source] of Object.entries(shapes)) for (const angle of [0, 0.37, Math.PI / 2, 2.4]) {
    const points = resampleInk(source, 2).map(([x, y], i) => [300 + x * Math.cos(angle) - y * Math.sin(angle) + Math.sin(i) * 0.15, 300 + x * Math.sin(angle) + y * Math.cos(angle) + Math.cos(i) * 0.15] as Point);
    assert.equal(recognizeShape(points)?.kind, kind, `${kind} at ${angle}`);
    if (kind !== 'arrow') assert.equal(recognizeShape([...points].reverse())?.kind, kind);
    const uneven = points.flatMap((p, i) => i % 7 === 0 ? [p, p, p, p, p] : [p]);
    assert.equal(recognizeShape(uneven)?.kind, kind);
  }
});
test('shape fitting rejects letters, open loops, spirals, retracing, tiny taps and ambiguous scribbles', () => {
  const negatives: Point[][] = [[], [[1, 1]], [[0, 0], [2, 1]], [[0, 0], [0, 60], [25, 25], [50, 60], [50, 0]],
    [[0, 0], [50, 70], [0, 70], [50, 0]], [[0, 0], [100, 0], [0, 0], [100, 0]],
    shapes.ellipse!.slice(0, 65),
    Array.from({ length: 100 }, (_, i) => [i * Math.cos(i / 99 * Math.PI * 4), i * Math.sin(i / 99 * Math.PI * 4)])];
  for (const points of negatives) assert.equal(recognizeShape(points), null, JSON.stringify(points.slice(0, 4)));
});
test('highlighter hold straightens a wavy stroke while respecting its actual endpoints and angle', () => {
  const points: Point[] = [[10, 20], [30, 22], [60, 30], [90, 26], [150, 35]];
  assert.deepEqual(recognizeShape(points, true)?.points, [points[0], points.at(-1)]);
  assert.equal(recognizeShape([[1, 1], [2, 2]], true), null);
});
test('hold tolerates small jitter but movement restarts the dwell interval', () => {
  const hold = new DrawHold(); hold.update([0, 0], 0, 2.5);
  assert(!hold.ready(649)); hold.update([1, 1], 500, 2.5); assert(hold.ready(650));
  hold.update([10, 0], 700, 2.5); assert(!hold.ready(1200)); assert(hold.ready(1350));
});
test('smooth ink reduces alternating jitter, keeps endpoints and never changes disabled or tap input', () => {
  const jitter: Point[] = Array.from({ length: 120 }, (_, i) => [i, i === 0 || i === 119 ? 0 : (i % 2 ? 1 : -1)]);
  const smooth = smoothInk(jitter, true);
  assert.deepEqual(smooth[0], jitter[0]); assert.deepEqual(smooth.at(-1), jitter.at(-1));
  assert(smooth.reduce((sum, p) => sum + p[1] ** 2, 0) / smooth.length < 0.45);
  assert.deepEqual(smoothInk(jitter, false), jitter);
  assert.deepEqual(smoothInk([[4, 7]], true), [[4, 7]]);
  assert(smooth.every(p => p.every(Number.isFinite)));
  assert(smooth.every(p => p[0] >= 0 && p[0] <= 119));
});
test('assisted ink remains editable standard ink with the same geometry after saving and reopening', async () => {
  const font = new Uint8Array(await readFile(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)));
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); let bytes = await pdf.save();
  const session = await TextSession.open({ read: async () => bytes, write: async b => { bytes = b; }, backup: async () => 'original.pdf' }, font);
  const input: Point[] = Array.from({ length: 60 }, (_, i) => [50 + i, 100 + Math.sin(i / 8) * 25 + Math.sin(i) * 2]);
  const smooth = smoothInk(input, true), shape = recognizeShape(shapes.ellipse!)!;
  session.addStroke(1, 'scribble', smooth, 2); session.addStroke(1, 'scribble', shape.points, 2); await session.save();
  const reopened = await readTextPdf(bytes);
  assert.equal(reopened.strokes.length, 2);
  for (const [i, points] of [smooth, shape.points].entries()) {
    assert.equal(reopened.strokes[i]!.points.length, points.length);
    reopened.strokes[i]!.points.forEach((point, j) => assert(Math.hypot(point[0] - points[j]![0], point[1] - points[j]![1]) < 0.02));
  }
});
test('header rename stays in the folder and validates names, extension and path traversal', () => {
  assert.equal(renamedPdfPath('School/Old.pdf', ' Algebra '), 'School/Algebra.pdf');
  assert.equal(renamedPdfPath('School/Old.pdf', 'Algebra.PDF'), 'School/Algebra.pdf');
  for (const name of ['', '.pdf', '..', '../Other', 'a/b', 'a\\b', 'name:', 'trailing.']) assert.throws(() => renamedPdfPath('School/Old.pdf', name));
});
test('assistance preferences have safe defaults and persist only actual booleans', () => {
  assert.deepEqual([loadToolPreferences(null).smoothPen, loadToolPreferences(null).holdShapes, loadToolPreferences(null).holdHighlighter], [true, false, true]);
  const saved = loadToolPreferences({ smoothPen: false, holdShapes: true, holdHighlighter: false });
  assert.deepEqual([saved.smoothPen, saved.holdShapes, saved.holdHighlighter], [false, true, false]);
  assert.equal(loadToolPreferences({ holdShapes: 'true' }).holdShapes, false);
});
