import { PDFArray, PDFDict, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';

/** Follow actual PDF references, including appearance-stream resources. */
export function referencedObjects(pdf: PDFDocument, roots: (PDFObject | undefined)[]): Set<PDFRef> {
  const refs = new Set<PDFRef>(), visited = new Set<PDFObject>(), pending = [...roots];
  while (pending.length) {
    const object = pending.pop(); if (!object || visited.has(object)) continue; visited.add(object);
    if (object instanceof PDFRef) { refs.add(object); pending.push(pdf.context.lookup(object)); }
    else if (object instanceof PDFStream) pending.push(object.dict);
    else if (object instanceof PDFDict) { for (const value of object.values()) pending.push(value); }
    else if (object instanceof PDFArray) { for (const value of object.asArray()) pending.push(value); }
  }
  return refs;
}

/** Only reclaim replaced appearances; preserve every still-referenced object. */
export function pruneReplacedObjects(pdf: PDFDocument, replaced: Set<PDFRef>): void {
  const trailer = pdf.context.trailerInfo;
  const live = referencedObjects(pdf, [pdf.catalog, trailer.Root, trailer.Info, trailer.Encrypt, trailer.ID]);
  for (const ref of replaced) if (!live.has(ref)) pdf.context.delete(ref);
}
