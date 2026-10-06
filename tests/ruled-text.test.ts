import test from 'node:test';
import assert from 'node:assert/strict';
import { growRuledBlock, ruledAnswerBlock, validRuledLayout } from '../src/pdf/ruled-text.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';
import type { DetectedLine } from '../src/pdf/ruled-text.ts';

const line = (y: number, page = 1, x = 70): DetectedLine => ({ page, rect: [x, y, x + 300, y + 18] });
test('aligned consecutive lines form one fixed writing block from any clicked row', () => {
  const rows = [620, 596, 572, 548].map(y => line(y));
  for (const target of rows) assert.deepEqual(ruledAnswerBlock([...rows].reverse(), target, () => false), { rect: [70, 548, 370, 638], layout: { spacing: 24, rows: 4 } });
});
test('grouping stops at occupied lines, page boundaries, column offsets and question gaps', () => {
  const rows = [line(620), line(596), line(572), line(548), line(500), line(476, 1, 100), line(452, 2)];
  assert.deepEqual(ruledAnswerBlock(rows, rows[0]!, l => l === rows[2]), { rect: [70, 596, 370, 638], layout: { spacing: 24, rows: 2 } });
  assert.equal(ruledAnswerBlock(rows, rows[2]!, l => l === rows[2]), undefined);
  for (const i of [3, 4, 5, 6]) assert.equal(ruledAnswerBlock(rows, rows[i]!, l => l === rows[2]), undefined);
  assert.equal(ruledAnswerBlock([line(620), line(596), line(569)], line(596), () => false)?.layout.rows, 2);
});
test('fractional printed pitch remains aligned over a long block at multiple raster resolutions', () => {
  for (const scale of [1, 1.5, 2]) {
    const rows = Array.from({ length: 20 }, (_, i) => line(Math.round((650 - i * 20.16) * scale) / scale));
    for (const target of rows) {
      const block = ruledAnswerBlock(rows, target, () => false)!;
      assert.equal(block.layout.rows, 20); assert(Math.abs(block.layout.spacing - 20.16) < 0.06);
    }
  }
});
test('invalid stored layouts never become a ruled answer block', () => {
  for (const layout of [{ spacing: NaN, rows: 3 }, { spacing: 24, rows: 0 }, { spacing: 24, rows: 2.5 }, { spacing: 100, rows: 3 }, { spacing: 24, rows: 1000 }]) assert.equal(validRuledLayout(layout, [70, 572, 370, 638]), false);
});
test('plugin settings migrate old preferences and reject untyped toggle values', () => {
  assert.equal(loadToolPreferences(null).autoDetectLines, false); assert.equal(loadToolPreferences(null).flowAnswerLines, true);
  assert.equal(loadToolPreferences(null).toolbarTopOffset, 0);
  assert.equal(loadToolPreferences(null).autoDetectPageLimit, 25);
  assert.equal(loadToolPreferences(null).keepOriginalBackups, true);
  const loaded = loadToolPreferences({ autoDetectLines: true, flowAnswerLines: false, penWidth: 5 });
  assert.equal(loaded.autoDetectLines, true); assert.equal(loaded.flowAnswerLines, false); assert.equal(loaded.penWidth, 5);
  assert.equal(loadToolPreferences({ autoDetectLines: 'true', flowAnswerLines: 0 }).autoDetectLines, false);
  assert.equal(loadToolPreferences({ flowAnswerLines: 0 }).flowAnswerLines, true);
  assert.equal(loadToolPreferences({ toolbarTopOffset: 72 }).toolbarTopOffset, 72);
  for (const toolbarTopOffset of [-1, 161, 4.5, Infinity, '32']) assert.equal(loadToolPreferences({ toolbarTopOffset }).toolbarTopOffset, 0);
  assert.equal(loadToolPreferences({ autoDetectPageLimit: 50 }).autoDetectPageLimit, 50);
  for (const autoDetectPageLimit of [0, 101, 4.5, Infinity, '32']) assert.equal(loadToolPreferences({ autoDetectPageLimit }).autoDetectPageLimit, 25);
  assert.equal(loadToolPreferences({ keepOriginalBackups: false }).keepOriginalBackups, false);
  for (const keepOriginalBackups of ['false', 0, null]) assert.equal(loadToolPreferences({ keepOriginalBackups }).keepOriginalBackups, true);
});

test('fractional-pitch growth retains CropBox bounds and whole rows without upward movement', () => {
  const rect: [number, number, number, number] = [70, 227.68, 370, 286];
  const layout = { spacing: 20.16, rows: 3 };
  const grown = growRuledBlock(rect, layout, 6, 13, [40, 100, 500, 700]);
  assert.equal(grown.rect[3], 286); assert.equal(grown.layout?.rows, 6); assert(validRuledLayout(grown.layout!, grown.rect));
  assert(Math.abs(grown.rect[1] - 167.2) < 0.001);
  const edge = growRuledBlock(grown.rect, grown.layout!, 100, 13, [40, 100, 500, 700]);
  assert.equal(edge.layout?.rows, 9); assert(edge.rect[1] >= 100); assert(validRuledLayout(edge.layout!, edge.rect));
});
