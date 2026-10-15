import type { NativePage } from '../compat/native-pdf';
import type { TextWord } from '../pdf/marker-text';

/** Measure PDF.js's own rendered glyph ranges, rather than guessing advances from string lengths. */
export function measureTextWords(layer: HTMLElement, page: NativePage): TextWord[] {
  try {
    return measure(layer, page);
  } catch {
    return [];
  }
}

function measure(layer: HTMLElement, page: NativePage): TextWord[] {
  let measured = 0;
  const words: TextWord[] = [];
  const doc = layer.ownerDocument;
  const box = page.div.getBoundingClientRect();
  const v = page.viewport;
  if (!box.width || !box.height) {
    return words;
  }
  const pdf = (x: number, y: number): [number, number] => {
    const p = v.convertToPdfPoint(
      ((x - box.left) * v.width) / box.width,
      ((y - box.top) * v.height) / box.height,
    );
    return [p[0]!, p[1]!];
  };
  for (const span of layer.querySelectorAll<HTMLElement>('span')) {
    const node = span.firstChild;
    if (!node || node.nodeType !== 3 || !span.textContent) {
      continue;
    }
    const angle =
      page.viewport.rotation +
      Number(/rotate\(([-\d.]+)deg\)/.exec(span.style.transform)?.[1] ?? 0);
    // Axis-aligned ranges are reliable for quarter turns; uncertain/skewed text stays freehand.
    if (!Number.isFinite(angle) || Math.abs(angle / 90 - Math.round(angle / 90)) > 0.001) {
      continue;
    }
    const quarter = ((Math.round(angle / 90) % 4) + 4) % 4;
    const vertical = quarter % 2 === 1;
    for (const match of span.textContent.matchAll(/\S+/gu)) {
      if (++measured > 5000) {
        return [];
      }
      const range = doc.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      if (typeof range.getBoundingClientRect !== 'function') {
        return [];
      }
      const r = range.getBoundingClientRect();
      if (
        !r.width ||
        !r.height ||
        r.left < box.left - 0.1 ||
        r.top < box.top - 0.1 ||
        r.right > box.right + 0.1 ||
        r.bottom > box.bottom + 0.1
      ) {
        continue;
      }
      const height =
        (vertical ? (r.width * v.width) / box.width : (r.height * v.height) / box.height) / v.scale;
      const a = vertical ? pdf(r.left + r.width / 2, r.top) : pdf(r.left, r.top + r.height / 2);
      const b = vertical ? pdf(r.left + r.width / 2, r.bottom) : pdf(r.right, r.top + r.height / 2);
      words.push({
        start: quarter < 2 ? a : b,
        end: quarter < 2 ? b : a,
        height,
        order: words.length,
      });
    }
  }
  return words;
}
