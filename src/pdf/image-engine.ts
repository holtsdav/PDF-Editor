import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import type { PDFDocument, PDFPage, PDFRef } from 'pdf-lib';
import { decodePDFRawStream } from 'pdf-lib';
import type { Rect } from './text-engine.ts';
import { referencedObjects, pruneReplacedObjects } from './object-references.ts';
import { pdfDate } from './mark-engine.ts';

/**
 * Pasted pictures as standard /Stamp annotations whose appearance draws the image,
 * so every PDF reader shows them. PNG bytes are kept alongside (PFSData) so the
 * editor can show and copy the original; JPEG bytes are the image stream itself.
 */
export const IMAGE_PREFIX = 'pdf-form-studio-image-';
export type ImageMime = 'image/png' | 'image/jpeg';
export type QuarterTurn = 0 | 90 | 180 | 270;
export interface PdfImage {
  id: string;
  page: number;
  /** Visible box on the page (already turned). */
  box: Rect;
  /** Counter-clockwise quarter turns, as in PDF space. */
  rotation?: QuarterTurn;
  /** Key into the image store (content hash). */
  source: string;
  modified: string;
  locked?: true;
}
export interface StoredImage {
  bytes: Uint8Array;
  mime: ImageMime;
}

const store = new Map<string, StoredImage>();

export function imageMime(bytes: Uint8Array): ImageMime | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}

/** Pixel size from a PNG header or a JPEG frame marker. */
export function imageSize(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = imageMime(bytes);
  if (mime === 'image/png' && bytes.length >= 24) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [view.getUint16(i + 7), view.getUint16(i + 5)];
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}

/** Remember image bytes and return their content key. */
export function storeImage(bytes: Uint8Array): string {
  const mime = imageMime(bytes);
  if (!mime) {
    throw new Error('Only PNG and JPEG pictures can be placed in a PDF.');
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i]!, 0x01000193);
  }
  const key = `${mime === 'image/png' ? 'png' : 'jpg'}-${bytes.length}-${(hash >>> 0).toString(16)}`;
  if (!store.has(key)) {
    store.set(key, { bytes: bytes.slice(), mime });
  }
  return key;
}

export function storedImage(source: string): StoredImage | undefined {
  return store.get(source);
}

export function validateImage(image: PdfImage, bounds: Rect): void {
  const box = image.box;
  if (
    !image.id.startsWith(IMAGE_PREFIX) ||
    box?.length !== 4 ||
    !box.every(Number.isFinite) ||
    box[2] - box[0] < 2 ||
    box[3] - box[1] < 2 ||
    box[0] < bounds[0] - 0.01 ||
    box[1] < bounds[1] - 0.01 ||
    box[2] > bounds[2] + 0.01 ||
    box[3] > bounds[3] + 0.01 ||
    ![undefined, 0, 90, 180, 270].includes(image.rotation) ||
    !store.has(image.source) ||
    !/^D:\d{14}/.test(image.modified)
  ) {
    throw new Error('Invalid picture. Keep it inside its PDF page.');
  }
}

function text(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}
function owned(dict: PDFDict): boolean {
  return (
    !!text(dict, 'NM')?.startsWith(IMAGE_PREFIX) &&
    dict.get(PDFName.of('PFSKind'))?.toString() === '/Image'
  );
}
function bounds(page: PDFPage): Rect {
  const box = page.getCropBox();
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}
function streamBytes(stream: PDFStream): Uint8Array {
  return stream instanceof PDFRawStream && !stream.dict.get(PDFName.of('Filter'))
    ? stream.contents
    : decodePDFRawStream(stream as PDFRawStream).decode();
}

/** The original picture bytes of one of our stamps. */
function originalBytes(dict: PDFDict): Uint8Array | undefined {
  const data = dict.lookup(PDFName.of('PFSData'));
  if (data instanceof PDFStream) {
    return streamBytes(data);
  }
  // JPEG: the image XObject stream is the JPEG file.
  const ap = dict.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : undefined;
  const resources =
    normal instanceof PDFStream ? normal.dict.lookup(PDFName.of('Resources')) : undefined;
  const objects =
    resources instanceof PDFDict ? resources.lookup(PDFName.of('XObject')) : undefined;
  const image = objects instanceof PDFDict ? objects.lookup(PDFName.of('Im0')) : undefined;
  if (
    image instanceof PDFRawStream &&
    image.dict.get(PDFName.of('Filter'))?.toString() === '/DCTDecode'
  ) {
    return image.contents;
  }
  return undefined;
}

export function readImages(pdf: PDFDocument): PdfImage[] {
  const images: PdfImage[] = [];
  const ids = new Set<string>();
  pdf.getPages().forEach((page, index) => {
    for (const entry of page.node.Annots()?.asArray() ?? []) {
      const dict = pdf.context.lookup(entry);
      if (!(dict instanceof PDFDict) || !owned(dict)) {
        continue;
      }
      const id = text(dict, 'NM')!;
      if (ids.has(id)) {
        throw new Error('The PDF contains duplicate picture IDs.');
      }
      ids.add(id);
      const bytes = originalBytes(dict);
      const rect = dict.lookup(PDFName.of('Rect'));
      const box = rect instanceof PDFArray ? rect.asArray().map((_, i) => rect.lookup(i)) : [];
      if (!bytes || box.length !== 4 || !box.every((value) => value instanceof PDFNumber)) {
        throw new Error('Invalid picture in this PDF.');
      }
      const turn = dict.lookupMaybe(PDFName.of('PFSRotation'), PDFNumber)?.asNumber() ?? 0;
      const image: PdfImage = {
        id,
        page: index + 1,
        box: box.map((value) => (value as PDFNumber).asNumber()) as Rect,
        ...(turn ? { rotation: turn as QuarterTurn } : {}),
        source: storeImage(bytes),
        modified: text(dict, 'M') ?? pdfDate(new Date(0)),
        ...((dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) & 128
          ? { locked: true as const }
          : {}),
      };
      validateImage(image, bounds(page));
      images.push(image);
    }
  });
  return images;
}

const decimal = (value: number) => String(Math.round(value * 1000) / 1000);

/** Image placement in the stamp's own space for a box of w × h and a quarter turn. */
function placement(w: number, h: number, rotation: QuarterTurn = 0): number[] {
  switch (rotation) {
    case 90:
      return [0, h, -w, 0, w, 0];
    case 180:
      return [-w, 0, 0, -h, w, h];
    case 270:
      return [0, -h, w, 0, 0, h];
    default:
      return [w, 0, 0, h, 0, 0];
  }
}

function ownedEntries(pdf: PDFDocument): { page: PDFPage; dict: PDFDict; id: string }[] {
  return pdf.getPages().flatMap((page) =>
    (page.node.Annots()?.asArray() ?? []).flatMap((entry) => {
      const dict = pdf.context.lookup(entry);
      return dict instanceof PDFDict && owned(dict) ? [{ page, dict, id: text(dict, 'NM')! }] : [];
    }),
  );
}

function remove(page: PDFPage, dict: PDFDict): void {
  const annotations = page.node.Annots();
  if (!annotations) {
    return;
  }
  for (let i = annotations.size() - 1; i >= 0; i--) {
    if (annotations.lookup(i) === dict) {
      annotations.remove(i);
    }
  }
}

export async function writeImages(
  pdf: PDFDocument,
  changed: Map<string, PdfImage>,
  deleted: Set<string>,
): Promise<void> {
  const entries = ownedEntries(pdf);
  const context = pdf.context;
  const touched = entries.filter((entry) => changed.has(entry.id) || deleted.has(entry.id));
  const replaced = referencedObjects(
    pdf,
    touched.flatMap((entry) => [
      entry.dict.get(PDFName.of('AP')),
      entry.dict.get(PDFName.of('PFSData')),
    ]),
  );
  for (const entry of touched) {
    remove(entry.page, entry.dict);
  }
  const embedded = new Map<string, { image: PDFRef; data?: PDFRef }>();
  for (const image of changed.values()) {
    if (deleted.has(image.id)) {
      continue;
    }
    const page = pdf.getPages()[image.page - 1];
    if (!page) {
      throw new Error('The picture page no longer exists.');
    }
    validateImage(image, bounds(page));
    const stored = store.get(image.source)!;
    let refs = embedded.get(image.source);
    if (!refs) {
      const picture =
        stored.mime === 'image/png'
          ? await pdf.embedPng(stored.bytes)
          : await pdf.embedJpg(stored.bytes);
      refs = {
        image: picture.ref,
        ...(stored.mime === 'image/png'
          ? { data: context.register(context.stream(stored.bytes, { Subtype: 'PFSImage' })) }
          : {}),
      };
      embedded.set(image.source, refs);
    }
    const [x0, y0, x1, y1] = image.box;
    const w = x1 - x0;
    const h = y1 - y0;
    const ap = context.register(
      context.flateStream(
        `q ${placement(w, h, image.rotation).map(decimal).join(' ')} cm /Im0 Do Q`,
        {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, w, h],
          Resources: { XObject: { Im0: refs.image } },
        },
      ),
    );
    const dict = context.obj({
      Type: 'Annot',
      Subtype: 'Stamp',
      Name: 'PFSImage',
      NM: PDFHexString.fromText(image.id),
      P: page.ref,
      F: image.locked ? 4 | 128 : 4,
      Rect: image.box,
      T: PDFHexString.fromText('PDF Editor'),
      M: PDFString.of(image.modified),
      CreationDate: PDFString.of(image.modified),
      PFSKind: 'Image',
      AP: { N: ap },
    });
    if (refs.data) {
      dict.set(PDFName.of('PFSData'), refs.data);
    }
    if (image.rotation) {
      dict.set(PDFName.of('PFSRotation'), PDFNumber.of(image.rotation));
    }
    page.node.addAnnot(context.register(dict));
  }
  pruneReplacedObjects(pdf, replaced);
}

export function verifyImages(
  pdf: PDFDocument,
  changed: Map<string, PdfImage>,
  deleted: Set<string>,
): void {
  const saved = new Map(readImages(pdf).map((image) => [image.id, image]));
  for (const id of deleted) {
    if (saved.has(id) && !changed.has(id)) {
      throw new Error('PDF picture deletion verification failed.');
    }
  }
  for (const image of changed.values()) {
    if (deleted.has(image.id)) {
      continue;
    }
    const output = saved.get(image.id);
    if (
      !output ||
      output.page !== image.page ||
      output.source !== image.source ||
      (output.rotation ?? 0) !== (image.rotation ?? 0) ||
      !!output.locked !== !!image.locked ||
      output.box.some((value, index) => Math.abs(value - image.box[index]!) > 0.01)
    ) {
      throw new Error('PDF picture verification failed.');
    }
  }
}

/** Display copy: our pictures are painted live by the editor. */
export function stripImages(pdf: PDFDocument): void {
  for (const entry of ownedEntries(pdf)) {
    remove(entry.page, entry.dict);
  }
}
