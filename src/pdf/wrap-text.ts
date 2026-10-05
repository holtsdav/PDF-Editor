/** Word-wrap with a grapheme fallback for long words, preserving logical PDF text. */
export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let remaining = paragraph;
    if (!remaining) { lines.push(''); continue; }
    while (remaining) {
      if (measure(remaining) <= width) { lines.push(remaining); break; }
      const segments = [...segmenter.segment(remaining)].map(part => part.segment);
      let low = 1; let high = segments.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(segments.slice(0, middle).join('')) <= width) low = middle;
        else high = middle - 1;
      }
      let count = low;
      // Prefer a word boundary; split an oversized word by grapheme instead.
      for (let index = count - 1; index > 0; index--) {
        if (/\s/.test(segments[index]!)) { count = index + 1; break; }
      }
      const line = segments.slice(0, count).join('');
      lines.push(line.trimEnd()); remaining = remaining.slice(line.length);
    }
  }
  return lines;
}
