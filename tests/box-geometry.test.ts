import test from 'node:test';
import assert from 'node:assert/strict';
import { growBox, rotatedHandle, transformBox } from '../src/pdf/box-geometry.ts';
import { wrapText } from '../src/pdf/wrap-text.ts';

test('move and resize keep boxes inside the page while preserving the opposite edge', () => {
  const bounds: [number, number, number, number] = [0, 0, 600, 800];
  const rect: [number, number, number, number] = [100, 200, 300, 250];
  assert.deepEqual(transformBox(rect, bounds, [1000, -1000]), [400, 0, 600, 50]);
  assert.deepEqual(transformBox(rect, bounds, [-1000, -1000], 'nw'), [0, 0, 300, 250]);
  assert.deepEqual(transformBox(rect, bounds, [-1000, -1000], 'se'), [100, 200, 140, 220]);
  assert.deepEqual(transformBox(rect, bounds, [1000, 1000], 'se'), [100, 200, 600, 800]);
});

test('quarter-turn handles and text growth follow local text orientation', () => {
  assert.equal(rotatedHandle('e', 90), 's'); assert.equal(rotatedHandle('nw', 90), 'ne');
  assert.equal(rotatedHandle('s', 180), 'n'); assert.equal(rotatedHandle('s', 270), 'e');
  const rect: [number, number, number, number] = [100, 100, 200, 150];
  const bounds: [number, number, number, number] = [0, 0, 600, 800];
  assert.deepEqual(growBox(rect, bounds, 120, 0), [100, 100, 200, 220]);
  assert.deepEqual(growBox(rect, bounds, 120, 90), [80, 100, 200, 150]);
  assert.deepEqual(growBox(rect, bounds, 120, 180), [100, 30, 200, 150]);
  assert.deepEqual(growBox(rect, bounds, 120, 270), [100, 100, 220, 150]);
  assert.deepEqual(growBox(rect, bounds, 1000, 0), [100, 100, 200, 800]);
});

test('wrapping keeps explicit lines and splits long words without splitting combining characters', () => {
  const measure = (text: string) => [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].length;
  assert.deepEqual(wrapText('First answer\n\nThird line', 12, measure), ['First answer', '', 'Third line']);
  assert.deepEqual(wrapText('A longer answer', 8, measure), ['A', 'longer', 'answer']);
  assert.deepEqual(wrapText('áb́ćd́é', 2, measure), ['áb́', 'ćd́', 'é']);
});
