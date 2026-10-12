import test from 'node:test';
import assert from 'node:assert/strict';
import { snapTextBands } from '../src/pdf/marker-text.ts';
import { resizeInkFrame, resizeInkPoints } from '../src/pdf/ink-geometry.ts';
import type { TextWord } from '../src/pdf/marker-text.ts';

test('text snapping merges adjacent crossed words, separates rows and leaves uncrossed text alone', () => {
  const words: TextWord[] = [
    { start: [20, 100], end: [50, 100], height: 12, order: 0 }, { start: [55, 100], end: [90, 100], height: 12, order: 1 },
    { start: [20, 75], end: [90, 75], height: 12, order: 2 }, { start: [150, 75], end: [190, 75], height: 12, order: 3 }
  ];
  const bands = snapTextBands([[25, 100], [85, 100], [85, 75], [25, 75]], words);
  assert.deepEqual(bands, [{ points: [[20, 100], [90, 100]], width: 12 }, { points: [[20, 75], [90, 75]], width: 12 }]);
  assert.deepEqual(snapTextBands([[1, 1], [10, 1]], words), []);
  assert.deepEqual(snapTextBands([[25, 100]], []), []);
});
test('vertical text uses its PDF-space direction without connecting columns', () => {
  const words: TextWord[] = [{ start: [100, 20], end: [100, 60], height: 14, order: 0 }, { start: [125, 20], end: [125, 60], height: 14, order: 1 }];
  assert.equal(snapTextBands([[100, 30], [100, 50]], words).length, 1);
});
test('ink resizing preserves the opposite anchor and proportional shape at page boundaries', () => {
  const frame = resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [500, 500], 'se', 4, true);
  assert.deepEqual(frame, [100, 100, 300, 200]);
  const points = resizeInkPoints([[102, 102], [198, 148]], [100, 100, 200, 150], frame);
  assert.deepEqual(points, [[102, 102], [298, 198]]);
  const collapsed = resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [-500, -500], 'se', 4);
  assert(collapsed[2] > collapsed[0] && collapsed[3] > collapsed[1]);
});

test('proportional corner resizing can shrink with a single-axis gesture', () => {
  assert.deepEqual(resizeInkFrame([100, 100, 200, 150], [0, 0, 300, 300], [-20, 0], 'se', 4, true), [100, 100, 180, 140]);
});
