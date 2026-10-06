import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, beginMarkedContent, endMarkedContent } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { decorativeFooterRules, excludeDecorativeFooters } from '../src/compat/pdf-artifacts.ts';
import type { OperatorList } from '../src/compat/pdf-artifacts.ts';

async function fixture() {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([600, 800]);
  page.pushOperators(beginMarkedContent('Artifact')); page.drawRectangle({ x: 50, y: 40, width: 500, height: 0.5 }); page.pushOperators(endMarkedContent());
  // A legitimate full-width answer closer to the bottom, with no decorative tag.
  page.drawLine({ start: { x: 50, y: 20 }, end: { x: 550, y: 20 }, thickness: 0.5 });
  const task = getDocument({ data: await pdf.save(), isEvalSupported: false }); const doc = await task.promise;
  const pdfPage = await doc.getPage(1); const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  return { task, page: pdfPage, viewport };
}
test('only a PDF-declared decorative footer is excluded; an equally wide lower answer remains', async () => {
  const f = await fixture();
  try {
    const rules = decorativeFooterRules(await f.page.getOperatorList(), OPS, f.viewport);
    assert.equal(rules.length, 1); assert.deepEqual(rules[0], [50, 759.5, 550, 760]);
    const footer = { rect: [50, 742, 550, 760] as [number, number, number, number] };
    const answer = { rect: [50, 762, 550, 780] as [number, number, number, number] };
    assert.deepEqual(excludeDecorativeFooters([footer, answer], rules), [answer]);
    assert.deepEqual(excludeDecorativeFooters([footer, answer], []), [footer, answer]);
  } finally { await f.task.destroy(); }
});
test('transformed nested artifacts and adjacent painted pieces combine without covering unrelated answers', async () => {
  const f = await fixture();
  try {
    const list: OperatorList = { fnArray: [OPS.save, OPS.transform, OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.constructPath, OPS.constructPath, OPS.endMarkedContent, OPS.endMarkedContent, OPS.restore, OPS.constructPath],
      argsArray: [null, [1, 0, 0, 1, 10, 10], ['Artifact'], ['Span', 1], [OPS.fill, [], [40, 30, 280, 30.5]], [OPS.fill, [], [280, 30, 540, 30.5]], null, null, null, [OPS.fill, [], [50, 20, 550, 20.5]]] };
    assert.deepEqual(decorativeFooterRules(list, OPS, f.viewport), [[50, 759.5, 550, 760]]);
  } finally { await f.task.destroy(); }
});
test('legacy or malformed operator bounds, clips, non-footer graphics and untagged rules fail open', async () => {
  const f = await fixture();
  try {
    const list: OperatorList = { fnArray: [OPS.beginMarkedContent, OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.endMarkedContent, OPS.constructPath],
      argsArray: [['Artifact'], [[OPS.rectangle], [50, 40, 500, 0.5], [50, 40, 550, 40.5]], [OPS.fill, [], [50, NaN, 550, 40.5]], [OPS.endPath, [], [50, 40, 550, 40.5]], [OPS.fill, [], [50, 600, 550, 600.5]], null, [OPS.fill, [], [50, 40, 550, 40.5]]] };
    assert.deepEqual(decorativeFooterRules(list, OPS, f.viewport), []);
  } finally { await f.task.destroy(); }
});
