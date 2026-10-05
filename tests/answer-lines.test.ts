import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAnswerLines } from '../src/pdf/answer-lines.ts';
import type { PagePixels } from '../src/pdf/answer-lines.ts';

function image(scale = 1): PagePixels & { ink(x: number, y: number, w: number, h: number): void } {
  const width = 600 * scale, height = 800 * scale, data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data, ink(x, y, w, h) {
    for (let j = y * scale; j < (y + h) * scale; j++) for (let i = x * scale; i < (x + w) * scale; i++) {
      const index = (j * width + i) * 4; data[index] = data[index + 1] = data[index + 2] = 0;
    }
  } };
}
test('answer lines merge their raster rows once and retain geometry at different resolutions', () => {
  for (const scale of [1, 2]) {
    const pixels = image(scale); pixels.ink(70, 150, 280, 1); pixels.ink(70, 220, 350, 2);
    const lines = detectAnswerLines(pixels, 600, 800);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => line.rect), [[70, 132, 350, 150], [70, 202, 420, 220]]);
  }
});
test('answer line detection excludes table borders, occupied headings, thick rules and page edges', () => {
  const pixels = image();
  pixels.ink(70, 150, 280, 1); pixels.ink(70, 130, 1, 40); pixels.ink(349, 130, 1, 40);
  pixels.ink(70, 220, 280, 1); pixels.ink(85, 205, 180, 8);
  pixels.ink(70, 400, 280, 1); pixels.ink(70, 450, 280, 1); pixels.ink(70, 400, 1, 51); pixels.ink(349, 400, 1, 51);
  pixels.ink(70, 300, 280, 6); pixels.ink(0, 550, 600, 1); pixels.ink(70, 5, 280, 1);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});
test('fragmented underscore runs tolerate small gaps but do not merge ordinary text or short strokes', () => {
  const pixels = image();
  for (let x = 70; x < 350; x += 10) pixels.ink(x, 150, 9, 1);
  for (let x = 70; x < 350; x += 10) pixels.ink(x, 220, 4, 1);
  pixels.ink(70, 300, 20, 1);
  assert.equal(detectAnswerLines(pixels, 600, 800).length, 1);
});
test('blank, transparent and invalid images are harmless and large scans are bounded', () => {
  const pixels = image(); assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
  pixels.data.fill(0); assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
  assert.deepEqual(detectAnswerLines({ ...pixels, width: NaN }, 600, 800), []);
  assert.deepEqual(detectAnswerLines(pixels, 0, 800), []);
  assert.deepEqual(detectAnswerLines({ width: 2000, height: 2000, data: new Uint8ClampedArray() }, 600, 800), []);
});


test('short dashes and gray scans are detected, with nearby labels limiting the typing area', () => {
  const pixels = image();
  for (let x = 80; x < 320; x += 10) pixels.ink(x, 150, 7, 1);
  pixels.ink(80, 220, 240, 1); pixels.ink(80, 198, 240, 7);
  pixels.ink(80, 300, 240, 1); pixels.ink(75, 285, 15, 10);
  // A lighter anti-aliased scanned rule.
  pixels.ink(80, 400, 240, 1);
  for (let x = 80; x < 320; x++) { const i = (400 * pixels.width + x) * 4; pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 165; }
  const lines = detectAnswerLines(pixels, 600, 800);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[1]!.rect, [80, 206, 320, 220]);
  assert(lines[2]!.rect[0] >= 92, 'typing area clears a label attached at its left edge');
});


test('irregular glyph-like baseline fragments never turn a printed sentence into an answer line', () => {
  const pixels = image();
  for (let x = 80, i = 0; x < 350; i++) { const width = [2, 3, 5, 8, 2, 4][i % 6]!; pixels.ink(x, 150, width, 1); x += width + 2; }
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});


test('a one-sided vertical table edge is not mistaken for a short label tail', () => {
  const pixels = image(); pixels.ink(80, 150, 300, 1); pixels.ink(80, 130, 1, 40);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});


test('inset answer rules inside a frame stay fillable while the frame edges remain excluded', () => {
  for (const scale of [1, 2]) for (const inset of [3, 4, 5]) {
    const pixels = image(scale);
    pixels.ink(70, 120, 401, 1); pixels.ink(70, 300, 401, 1);
    pixels.ink(70, 120, 1, 181); pixels.ink(470, 120, 1, 181);
    pixels.ink(75, 130, 110, 8); // label, above the first answer's typing area
    for (const y of [180, 210, 240]) pixels.ink(70 + inset, y, 400 - inset * 2, 1);
    const lines = detectAnswerLines(pixels, 600, 800);
    assert.equal(lines.length, 3, `scale ${scale}, inset ${inset}`);
    assert.deepEqual(lines.map(line => line.rect), [180, 210, 240].map(y => [70 + inset, y - 18, 470 - inset, y]));
  }
});
test('a detached frame fragment is trimmed on either side, but connected or interior crossings remain rejected', () => {
  for (const side of ['left', 'right']) {
    const pixels = image(); pixels.ink(83, 150, 294, 1);
    pixels.ink(side === 'left' ? 80 : 379, 120, 1, 70);
    const lines = detectAnswerLines(pixels, 600, 800); assert.equal(lines.length, 1); assert.deepEqual(lines[0]!.rect, [83, 132, 377, 150]);
  }
  for (const x of [80, 200, 379]) {
    const pixels = image(); pixels.ink(80, 150, 300, 1); pixels.ink(x, 120, 1, 70);
    assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
  }
});
test('border trimming cannot remove wide vertical bars or an occupied heading', () => {
  const pixels = image(); pixels.ink(80, 120, 6, 70); pixels.ink(88, 150, 290, 1);
  pixels.ink(80, 240, 1, 70); pixels.ink(83, 270, 294, 1); pixels.ink(100, 255, 180, 10);
  assert.deepEqual(detectAnswerLines(pixels, 600, 800), []);
});
