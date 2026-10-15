import {
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHeader,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectParser,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import type { PDFObject, SaveOptions } from 'pdf-lib';

const MAX_OBJECT_COUNT = 1_000_000;
const MAX_GENERATION = 65535;
const FOOTER_SCAN_BYTES = 2048;
const OBJECT_HEADER_SCAN_BYTES = 128;
// A generous lower bound keeps malformed subsection counts from driving large loops.
const MIN_INDEX_ENTRY_BYTES = 10;

const classicSerialization = new WeakSet<PDFDocument>();
const decoder = new TextDecoder('latin1');

interface IndexEntry {
  offset: number;
  generation: number;
  active: boolean;
}

interface ClassicSection {
  entries: Map<number, IndexEntry>;
  trailer: PDFDict;
}

interface ClassicIndex {
  entries: Map<number, IndexEntry>;
  trailers: PDFDict[];
  objectCount: number;
}

/** Missing footers use library repair; a recognized invalid pointer must fail. */
function readFooterOffset(bytes: Uint8Array): number | undefined {
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - FOOTER_SCAN_BYTES)));
  const footer = /startxref[\s\0]+([^\s\0]+)[\s\0]+%%EOF[\s\0]*$/.exec(tail);
  if (!footer) {
    return undefined;
  }

  const offset = Number(footer[1]);
  if (
    !/^\+?\d+$/.test(footer[1]!) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= bytes.length
  ) {
    throw new Error('Invalid PDF cross-reference offset.');
  }
  return offset;
}

function hasClassicIndex(bytes: Uint8Array, offset: number): boolean {
  return /^xref[\s\0]/.test(decoder.decode(bytes.subarray(offset, offset + 5)));
}

/** Recognize a cross-reference stream only at its exact indexed byte offset. */
function hasStreamIndex(bytes: Uint8Array, offset: number): boolean {
  const header = /^(\d+)[\s\0]+(\d+)[\s\0]+obj\b/.exec(
    decoder.decode(bytes.subarray(offset, offset + OBJECT_HEADER_SCAN_BYTES)),
  );
  if (
    !header ||
    !Number.isSafeInteger(Number(header[1])) ||
    Number(header[1]) < 1 ||
    Number(header[2]) > MAX_GENERATION
  ) {
    return false;
  }

  try {
    const object = PDFObjectParser.forBytes(
      bytes.subarray(offset + header[0].length),
      PDFContext.create(),
    ).parseObject();
    return (
      object instanceof PDFStream && object.dict.get(PDFName.of('Type')) === PDFName.of('XRef')
    );
  } catch {
    return false;
  }
}

function isPdfWhitespace(byte: number | undefined): boolean {
  // PDF whitespace: NUL, tab, line feed, form feed, carriage return and space.
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function readIndexInteger(token: string): number {
  const value = Number(token);
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(value)) {
    throw new Error('Invalid PDF object index.');
  }
  return value;
}

/** Read one section without decoding unrelated binary streams or expanding object streams. */
function readClassicSection(
  bytes: Uint8Array,
  offset: number,
  context: PDFContext,
): ClassicSection {
  let cursor = offset + 4;
  const readToken = (): string => {
    for (;;) {
      while (cursor < bytes.length && isPdfWhitespace(bytes[cursor])) {
        cursor++;
      }
      if (bytes[cursor] !== 37) {
        break;
      }
      // Skip percent-prefixed PDF comments, retaining the existing tolerant reading policy.
      while (cursor < bytes.length && bytes[cursor] !== 13 && bytes[cursor] !== 10) {
        cursor++;
      }
    }
    const start = cursor;
    while (cursor < bytes.length && !isPdfWhitespace(bytes[cursor])) {
      cursor++;
    }
    return decoder.decode(bytes.subarray(start, cursor));
  };

  const entries = new Map<number, IndexEntry>();
  for (;;) {
    const firstToken = readToken();
    if (firstToken === 'trailer') {
      break;
    }

    const firstObject = readIndexInteger(firstToken);
    const entryCount = readIndexInteger(readToken());
    // Zero entries are legal: hybrid and trailer-only updates can use `xref 0 0`.
    if (
      firstObject + entryCount > MAX_OBJECT_COUNT ||
      entryCount > (bytes.length - cursor) / MIN_INDEX_ENTRY_BYTES
    ) {
      throw new Error('Unsupported PDF object index size.');
    }

    for (let number = firstObject; number < firstObject + entryCount; number++) {
      const objectOffset = readIndexInteger(readToken());
      const generation = readIndexInteger(readToken());
      const state = readToken();
      if (
        entries.has(number) ||
        generation > MAX_GENERATION ||
        !['n', 'f'].includes(state) ||
        (state === 'n' && (number === 0 || objectOffset >= bytes.length))
      ) {
        throw new Error('Invalid PDF object index entry.');
      }
      entries.set(number, { offset: objectOffset, generation, active: state === 'n' });
    }
  }

  const trailer = PDFObjectParser.forBytes(bytes.subarray(cursor), context).parseObject();
  if (!(trailer instanceof PDFDict)) {
    throw new Error('Invalid PDF trailer.');
  }
  return { entries, trailer };
}

function validateEntryRange(entries: Map<number, IndexEntry>, objectCount: number): void {
  for (const number of entries.keys()) {
    if (number >= objectCount) {
      throw new Error('Invalid PDF object index size.');
    }
  }
}

function readObjectCount(section: ClassicSection): number | undefined {
  const size = section.trailer.get(PDFName.of('Size'), true);
  if (size === undefined) {
    return undefined;
  }
  const count = size instanceof PDFNumber ? size.asNumber() : undefined;
  if (
    count === undefined ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_OBJECT_COUNT
  ) {
    throw new Error('Invalid PDF object index size.');
  }
  validateEntryRange(section.entries, count);
  return count;
}

/** Collect newest entries first; undefined means the existing library path is required. */
function readClassicIndex(
  bytes: Uint8Array,
  firstOffset: number,
  context: PDFContext,
): ClassicIndex | undefined {
  const entries = new Map<number, IndexEntry>();
  const trailers: PDFDict[] = [];
  const visited = new Set<number>();
  let offset = firstOffset;
  let objectCount = 0;

  for (;;) {
    visited.add(offset);
    const section = readClassicSection(bytes, offset, context);
    const sectionCount = readObjectCount(section);
    // Missing Size cannot establish scope. Hybrid and mixed table/stream indexes
    // need the library's compressed-object loading rather than this classic-only path.
    if (sectionCount === undefined || section.trailer.has(PDFName.of('XRefStm'))) {
      return undefined;
    }
    if (trailers.length === 0) {
      objectCount = sectionCount;
    }
    trailers.push(section.trailer);

    // A newer free entry or generation change must also shadow the older object.
    for (const [number, entry] of section.entries) {
      if (!entries.has(number)) {
        entries.set(number, entry);
      }
    }

    const previous = section.trailer.get(PDFName.of('Prev'), true);
    if (previous === undefined) {
      break;
    }
    const previousOffset = previous instanceof PDFNumber ? previous.asNumber() : undefined;
    // Linearized layouts can link forward. Detect cycles without imposing physical ordering.
    if (
      previousOffset === undefined ||
      !Number.isSafeInteger(previousOffset) ||
      previousOffset < 0 ||
      previousOffset >= bytes.length ||
      visited.has(previousOffset)
    ) {
      throw new Error('Invalid PDF previous cross-reference offset.');
    }
    if (!hasClassicIndex(bytes, previousOffset)) {
      if (!hasStreamIndex(bytes, previousOffset)) {
        throw new Error('Invalid PDF previous cross-reference offset.');
      }
      return undefined;
    }
    offset = previousOffset;
  }

  validateEntryRange(entries, objectCount);
  return { entries, trailers, objectCount };
}

function inheritedTrailerValue(trailers: PDFDict[], key: string): PDFObject | undefined {
  const name = PDFName.of(key);
  for (const trailer of trailers) {
    const value = trailer.get(name, true);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readIndexedObject(
  bytes: Uint8Array,
  context: PDFContext,
  number: number,
  entry: IndexEntry,
): PDFObject {
  const header = /^(\d+)[\s\0]+(\d+)[\s\0]+obj\b/.exec(
    decoder.decode(bytes.subarray(entry.offset, entry.offset + OBJECT_HEADER_SCAN_BYTES)),
  );
  if (!header || Number(header[1]) !== number || Number(header[2]) !== entry.generation) {
    throw new Error('PDF object index does not match the referenced object.');
  }
  const object = PDFObjectParser.forBytes(
    bytes.subarray(entry.offset + header[0].length),
    context,
  ).parseObject();
  context.assign(PDFRef.of(number, entry.generation), object);
  return object;
}

/** Build only indexed objects; obsolete compressed payloads remain opaque on later saves. */
function loadIndexedObjects(pdf: PDFDocument, bytes: Uint8Array, index: ClassicIndex): void {
  const context = pdf.context;
  const header = /%PDF-(\d+)\.(\d+)/.exec(decoder.decode(bytes.subarray(0, 1024)));
  if (!header) {
    throw new Error('Invalid PDF header.');
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    context.delete(ref);
  }
  context.header = PDFHeader.forVersion(Number(header[1]), Number(header[2]));

  const activeEntries = [...index.entries]
    .filter(([, entry]) => entry.active)
    .sort((a, b) => a[1].offset - b[1].offset);
  for (const [number, entry] of activeEntries) {
    const object = readIndexedObject(bytes, context, number, entry);
    if (
      object instanceof PDFStream &&
      ['ObjStm', 'XRef'].includes(object.dict.get(PDFName.of('Type'))?.toString().slice(1) ?? '')
    ) {
      classicSerialization.add(pdf);
    }
  }
  context.largestObjectNumber = Math.max(context.largestObjectNumber, index.objectCount - 1);
  context.trailerInfo = {
    Root: inheritedTrailerValue(index.trailers, 'Root'),
    Info: inheritedTrailerValue(index.trailers, 'Info'),
    ID: inheritedTrailerValue(index.trailers, 'ID'),
  };
}

function populateCatalog(pdf: PDFDocument): void {
  const context = pdf.context;
  const root = context.lookup(context.trailerInfo.Root);
  if (
    !(root instanceof PDFDict) ||
    root.get(PDFName.of('Type')) !== PDFName.of('Catalog') ||
    !(context.trailerInfo.Root instanceof PDFRef)
  ) {
    throw new Error('Invalid active PDF catalog.');
  }
  // The new document's empty page/form caches must use the active catalog before traversal.
  for (const key of pdf.catalog.keys()) {
    pdf.catalog.delete(key);
  }
  for (const [key, value] of root.entries()) {
    pdf.catalog.set(key, value);
  }
  context.assign(context.trailerInfo.Root, pdf.catalog);
}

/** Honor classic indexes instead of expanding obsolete object streams left by other editors. */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  const offset = readFooterOffset(bytes);
  if (offset === undefined) {
    return PDFDocument.load(bytes, { updateMetadata: false });
  }
  if (!hasClassicIndex(bytes, offset)) {
    if (!hasStreamIndex(bytes, offset)) {
      throw new Error('Invalid PDF cross-reference offset.');
    }
    return PDFDocument.load(bytes, { updateMetadata: false });
  }

  const pdf = await PDFDocument.create({ updateMetadata: false });
  const index = readClassicIndex(bytes, offset, pdf.context);
  if (!index) {
    return PDFDocument.load(bytes, { updateMetadata: false });
  }
  const encryption = inheritedTrailerValue(index.trailers, 'Encrypt');
  if (encryption !== undefined && encryption !== PDFNull) {
    throw new Error('Encrypted PDFs are read only in this version.');
  }
  loadIndexedObjects(pdf, bytes, index);
  populateCatalog(pdf);
  return pdf;
}

/** Keep obsolete compressed payloads opaque on later saves without changing their bytes. */
export function pdfSaveOptions(pdf: PDFDocument): SaveOptions {
  return {
    updateFieldAppearances: false,
    ...(classicSerialization.has(pdf) ? { useObjectStreams: false } : {}),
  };
}
