import { PDFArray, PDFContext, PDFDict, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';

/**
 * Incremental saving: keep the original PDF bytes and append only the objects this
 * save changed or added, plus a cross-reference section that points back (/Prev) to
 * the previous one. Readers resolve each object from the newest section.
 *
 * Changes are found by recording which dictionaries and arrays pdf-lib mutates after
 * the seed is loaded; an indirect object is rewritten when it, or a direct object
 * inside it, was touched, or when it is new.
 */

/**
 * A save rewrites the whole file once (compacting it) after this many appended
 * revisions, or when appended updates would exceed this share of the first revision.
 */
const MAX_REVISIONS = 12;
const MAX_APPENDED_SHARE = 0.15;

interface Tracker {
  touched: WeakSet<object>;
  assigned: Set<PDFRef>;
  original: Set<PDFRef>;
}
const active = new Set<Tracker>();
let installed = false;

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  const mark = (target: object) => {
    for (const tracker of active) {
      tracker.touched.add(target);
    }
  };
  const wrap = <T extends object>(proto: T, names: (keyof T)[]) => {
    for (const name of names) {
      const original = proto[name] as unknown as (...args: unknown[]) => unknown;
      (proto as Record<keyof T, unknown>)[name] = function (this: object, ...args: unknown[]) {
        if (active.size) {
          mark(this);
        }
        return original.apply(this, args);
      };
    }
  };
  wrap(PDFDict.prototype, ['set', 'delete']);
  wrap(PDFArray.prototype, ['push', 'insert', 'set', 'remove']);
  const assign = PDFContext.prototype.assign;
  PDFContext.prototype.assign = function (this: PDFContext, ref: PDFRef, object: PDFObject) {
    for (const tracker of active) {
      tracker.assigned.add(ref);
    }
    return assign.call(this, ref, object);
  };
}

/**
 * Highest object number the file uses, including object and cross-reference streams
 * that the parser does not keep: new objects must never reuse one of those numbers.
 * The newest trailer's /Size covers every revision; scan the file only without one.
 */
function usedObjectNumbers(seed: Uint8Array): number {
  const section = lastSection(seed);
  if (section) {
    let start = section.offset;
    if (section.classic) {
      start = seed.indexOf(0x74, start); // 't' of "trailer"
      while (start >= 0 && latin1.decode(seed.subarray(start, start + 7)) !== 'trailer') {
        start = seed.indexOf(0x74, start + 1);
      }
    }
    const size =
      start >= 0 ? /\/Size\s+(\d+)/.exec(latin1.decode(seed.subarray(start, start + 4096))) : null;
    if (size) {
      return Math.min(Number(size[1]) - 1, 8_388_606);
    }
  }
  const text = latin1.decode(seed);
  let highest = 0;
  for (const match of text.matchAll(/(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/g)) {
    highest = Math.max(highest, Number(match[1]));
  }
  // Stray matches inside binary data must not push numbers past the PDF limit.
  return Math.min(highest, 8_388_606);
}

/** Start recording changes to a freshly loaded document. */
export function trackChanges(
  pdf: PDFDocument,
  seed: Uint8Array,
): { stop(): void; tracker: Tracker } {
  install();
  const context = pdf.context;
  context.largestObjectNumber = Math.max(context.largestObjectNumber, usedObjectNumbers(seed));
  const tracker: Tracker = {
    touched: new WeakSet(),
    assigned: new Set(),
    original: new Set(pdf.context.enumerateIndirectObjects().map(([ref]) => ref)),
  };
  active.add(tracker);
  return { tracker, stop: () => active.delete(tracker) };
}

function touchedInside(object: PDFObject, tracker: Tracker, seen = new Set<object>()): boolean {
  if (seen.has(object)) {
    return false;
  }
  seen.add(object);
  if (tracker.touched.has(object)) {
    return true;
  }
  if (object instanceof PDFStream) {
    return touchedInside(object.dict, tracker, seen);
  }
  if (object instanceof PDFDict) {
    return object.values().some((value) => touchedInside(value, tracker, seen));
  }
  if (object instanceof PDFArray) {
    return object.asArray().some((value) => touchedInside(value, tracker, seen));
  }
  return false;
}

const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

/** Byte offset of the last cross-reference section and whether it is a classic table. */
function lastSection(seed: Uint8Array): { offset: number; classic: boolean } | undefined {
  const tail = latin1.decode(seed.subarray(Math.max(0, seed.length - 2048)));
  const match = /startxref[\s\0]+(\d+)[\s\0]+%%EOF[\s\0]*$/.exec(tail);
  const offset = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= seed.length) {
    return undefined;
  }
  const head = latin1.decode(seed.subarray(offset, offset + 64));
  if (/^xref\b/.test(head)) {
    return { offset, classic: true };
  }
  return /^\d+\s+\d+\s+obj\b/.test(head) ? { offset, classic: false } : undefined;
}

/** Number of revisions and the end of the first one. */
function revisions(seed: Uint8Array): { count: number; firstEnd: number } {
  let count = 0;
  let firstEnd = seed.length;
  for (let i = seed.indexOf(0x25); i >= 0 && i < seed.length; i = seed.indexOf(0x25, i + 1)) {
    if (seed[i + 1] === 0x25 && latin1.decode(seed.subarray(i, i + 5)) === '%%EOF') {
      if (!count) {
        firstEnd = i + 5;
      }
      count++;
    }
  }
  return { count, firstEnd };
}

function serialize(object: PDFObject): Uint8Array {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  return bytes;
}

/**
 * Seed plus one appended update, or undefined when the seed cannot take one safely
 * (no readable cross-reference footer, too many earlier revisions, nothing changed).
 */
export function incrementalBytes(
  seed: Uint8Array,
  pdf: PDFDocument,
  tracker: Tracker,
): Uint8Array | undefined {
  const section = lastSection(seed);
  const history = revisions(seed);
  if (!section || history.count >= MAX_REVISIONS) {
    return undefined;
  }
  const context = pdf.context;
  const changed = context
    .enumerateIndirectObjects()
    .filter(
      ([ref, object]) =>
        !tracker.original.has(ref) || tracker.assigned.has(ref) || touchedInside(object, tracker),
    )
    .sort(([a], [b]) => a.objectNumber - b.objectNumber);
  const { Root, Info, ID, Encrypt } = context.trailerInfo;
  if (!changed.length || Encrypt || !(Root instanceof PDFRef)) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = seed.length;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    size += bytes.length;
  };
  const last = seed[seed.length - 1];
  if (last !== 0x0a && last !== 0x0d) {
    push(encoder.encode('\n'));
  }
  const offsets = new Map<PDFRef, number>();
  for (const [ref, object] of changed) {
    offsets.set(ref, size);
    push(encoder.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(serialize(object));
    push(encoder.encode('\nendobj\n'));
  }
  const trailer: Record<string, PDFObject> = {
    Root,
    Prev: PDFNumber.of(section.offset),
  };
  if (Info) {
    trailer.Info = Info as PDFObject;
  }
  if (ID) {
    trailer.ID = ID as PDFObject;
  }
  const xrefAt = size;
  if (section.classic) {
    // Subsections of consecutive object numbers, 20 bytes per entry.
    const lines: string[] = ['xref'];
    for (let i = 0; i < changed.length;) {
      let j = i;
      while (
        j + 1 < changed.length &&
        changed[j + 1]![0].objectNumber === changed[j]![0].objectNumber + 1
      ) {
        j++;
      }
      lines.push(`${changed[i]![0].objectNumber} ${j - i + 1}`);
      for (let k = i; k <= j; k++) {
        const [ref] = changed[k]!;
        lines.push(
          `${String(offsets.get(ref)).padStart(10, '0')} ${String(ref.generationNumber).padStart(5, '0')} n\r`,
        );
      }
      i = j + 1;
    }
    const dict = context.obj({ ...trailer, Size: context.largestObjectNumber + 1 });
    push(
      encoder.encode(
        `${lines.join('\n')}\ntrailer\n${dict.toString()}\nstartxref\n${xrefAt}\n%%EOF\n`,
      ),
    );
  } else {
    // A cross-reference stream, itself one more object: [type 1, offset (4 bytes), generation (2 bytes)].
    const own = PDFRef.of(context.largestObjectNumber + 1);
    const entries: [PDFRef, number][] = [
      ...changed.map(([ref]) => [ref, offsets.get(ref)!] as [PDFRef, number]),
      [own, xrefAt],
    ];
    const index: number[] = [];
    for (let i = 0; i < entries.length;) {
      let j = i;
      while (
        j + 1 < entries.length &&
        entries[j + 1]![0].objectNumber === entries[j]![0].objectNumber + 1
      ) {
        j++;
      }
      index.push(entries[i]![0].objectNumber, j - i + 1);
      i = j + 1;
    }
    const data = new Uint8Array(entries.length * 7);
    entries.forEach(([ref, offset], i) => {
      data[i * 7] = 1;
      data[i * 7 + 1] = (offset >>> 24) & 0xff;
      data[i * 7 + 2] = (offset >>> 16) & 0xff;
      data[i * 7 + 3] = (offset >>> 8) & 0xff;
      data[i * 7 + 4] = offset & 0xff;
      data[i * 7 + 5] = (ref.generationNumber >>> 8) & 0xff;
      data[i * 7 + 6] = ref.generationNumber & 0xff;
    });
    const stream = context.flateStream(data, {
      ...trailer,
      Type: 'XRef',
      Size: own.objectNumber + 1,
      W: [1, 4, 2],
      Index: index,
    });
    push(encoder.encode(`${own.objectNumber} 0 obj\n`));
    push(serialize(stream));
    push(encoder.encode(`\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }
  // Many small sessions on a small file would otherwise keep superseded fonts around.
  if (size - history.firstEnd > history.firstEnd * MAX_APPENDED_SHARE) {
    return undefined;
  }
  const output = new Uint8Array(size);
  output.set(seed, 0);
  let at = seed.length;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.length;
  }
  return output;
}
