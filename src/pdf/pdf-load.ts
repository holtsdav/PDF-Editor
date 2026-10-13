import { PDFDocument, PDFObjectParser, PDFHeader, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFNull } from 'pdf-lib';
import type { SaveOptions } from 'pdf-lib';

const classicSerialization = new WeakSet<PDFDocument>();
const decoder = new TextDecoder('latin1');

/** Honor self-contained classic object indexes instead of expanding obsolete object streams left by other editors. */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const footer = /startxref\s+(\d+)\s+%%EOF[\s\0]*$/.exec(tail);
  const offset = footer ? Number(footer[1]) : -1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length
    || decoder.decode(bytes.subarray(offset, offset + 4)) !== 'xref') return PDFDocument.load(bytes, { updateMetadata: false });
  const section = decoder.decode(bytes.subarray(offset));
  let cursor = 4;
  const token = (): string => {
    for (;;) {
      while (cursor < section.length && /[\s\0]/.test(section[cursor]!)) cursor++;
      if (section[cursor] !== '%') break;
      while (cursor < section.length && !/[\r\n]/.test(section[cursor]!)) cursor++;
    }
    const start = cursor; while (cursor < section.length && !/[\s\0]/.test(section[cursor]!)) cursor++;
    return section.slice(start, cursor);
  };
  const integer = (value: string): number => {
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) throw new Error('Invalid PDF object index.');
    return number;
  };
  const entries = new Map<number, { offset: number; generation: number; active: boolean }>();
  for (;;) {
    const first = token(); if (first === 'trailer') break;
    const start = integer(first), count = integer(token());
    if (count < 1 || start + count > 1_000_000 || count > section.length / 10) throw new Error('Unsupported PDF object index size.');
    for (let index = start; index < start + count; index++) {
      const objectOffset = integer(token()), generation = integer(token()), state = token();
      if (entries.has(index) || generation > 65535 || !['n', 'f'].includes(state)
        || state === 'n' && (index === 0 || objectOffset >= offset)) throw new Error('Invalid PDF object index entry.');
      entries.set(index, { offset: objectOffset, generation, active: state === 'n' });
    }
  }
  const pdf = await PDFDocument.create({ updateMetadata: false }), context = pdf.context;
  const trailer = PDFObjectParser.forBytes(bytes.subarray(offset + cursor), context).parseObject();
  if (!(trailer instanceof PDFDict)) throw new Error('Invalid PDF trailer.');
  // Incremental and hybrid indexes retain the existing library path. A sparse
  // standalone table may omit unused numbers left by appearance cleanup.
  const size = trailer.lookupMaybe(PDFName.of('Size'), PDFNumber)?.asNumber();
  if (trailer.has(PDFName.of('Prev')) || trailer.has(PDFName.of('XRefStm'))) return PDFDocument.load(bytes, { updateMetadata: false });
  if (size === undefined || !Number.isSafeInteger(size) || size < 1 || size > 1_000_000 || [...entries.keys()].some(index => index >= size)) throw new Error('Invalid PDF object index size.');
  if (trailer.has(PDFName.of('Encrypt')) && trailer.get(PDFName.of('Encrypt')) !== PDFNull) throw new Error('Encrypted PDFs are read only in this version.');
  const header = /%PDF-(\d+)\.(\d+)/.exec(decoder.decode(bytes.subarray(0, 1024)));
  if (!header) throw new Error('Invalid PDF header.');
  for (const [ref] of context.enumerateIndirectObjects()) context.delete(ref);
  context.header = PDFHeader.forVersion(Number(header[1]), Number(header[2]));
  const active = [...entries].filter(([, entry]) => entry.active).sort((a, b) => a[1].offset - b[1].offset);
  const parse = (number: number, entry: { offset: number; generation: number }) => {
    const head = /^(\d+)\s+(\d+)\s+obj\b/.exec(decoder.decode(bytes.subarray(entry.offset, entry.offset + 128)));
    if (!head || Number(head[1]) !== number || Number(head[2]) !== entry.generation) throw new Error('PDF object index does not match the referenced object.');
    const object = PDFObjectParser.forBytes(bytes.subarray(entry.offset + head[0].length), context).parseObject();
    context.assign(PDFRef.of(number, entry.generation), object); return object;
  };
  for (const [number, entry] of active) {
    const object = parse(number, entry);
    if (object instanceof PDFStream && ['ObjStm', 'XRef'].includes(object.dict.get(PDFName.of('Type'))?.toString().slice(1) ?? '')) classicSerialization.add(pdf);
  }
  context.largestObjectNumber = Math.max(context.largestObjectNumber, size - 1);
  context.trailerInfo = { Root: trailer.get(PDFName.of('Root')), Info: trailer.get(PDFName.of('Info')), ID: trailer.get(PDFName.of('ID')) };
  const root = context.lookup(context.trailerInfo.Root);
  if (!(root instanceof PDFDict) || root.get(PDFName.of('Type')) !== PDFName.of('Catalog') || !(context.trailerInfo.Root instanceof PDFRef)) throw new Error('Invalid active PDF catalog.');
  // PDFDocument.create initializes empty caches. Populate its public catalog
  // with the active dictionary before any page or form traversal starts.
  for (const key of pdf.catalog.keys()) pdf.catalog.delete(key);
  for (const [key, value] of root.entries()) pdf.catalog.set(key, value);
  context.assign(context.trailerInfo.Root, pdf.catalog);
  return pdf;
}

/** Keep obsolete compressed payloads opaque on later saves without changing their bytes. */
export function pdfSaveOptions(pdf: PDFDocument): SaveOptions {
  return { updateFieldAppearances: false, ...(classicSerialization.has(pdf) ? { useObjectStreams: false } : {}) };
}
