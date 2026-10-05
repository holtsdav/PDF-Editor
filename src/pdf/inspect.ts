/** Small boundary shared with Obsidian's bundled PDF.js and upstream integration tests. */
export interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<{
    getAnnotations(options: { intent: string }): Promise<unknown[]>;
  }>;
  getFieldObjects(): Promise<unknown>;
  getMetadata(): Promise<{ info: unknown }>;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export interface PdfLibrary {
  version?: string;
  getDocument(options: {
    data: Uint8Array;
    isEvalSupported: boolean;
    enableXfa: boolean;
  }): PdfLoadingTask;
}

export interface FormFieldSummary {
  name: string;
  type: string;
  pages: number[];
  readOnly: boolean;
  inFieldTree: boolean;
}

export interface PdfInspection {
  pages: number;
  scannedPages: number;
  hasXfa: boolean;
  hasAcroForm: boolean;
  fields: FormFieldSummary[];
  signatureWidgets: number;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asPdfLibrary(value: unknown): PdfLibrary {
  if (!isRecord(value) || typeof value.getDocument !== 'function') {
    throw new Error('This Obsidian version does not expose a compatible PDF.js loader.');
  }
  return value as unknown as PdfLibrary;
}

/** Reads both canonical form fields and visible widgets; never writes PDF bytes. */
export async function inspectDocument(document: PdfDocument, pageLimit = 200): Promise<PdfInspection> {
  if (!Number.isInteger(pageLimit) || pageLimit < 1) throw new Error('Page limit must be a positive integer.');
  const [{ info }, rawFields] = await Promise.all([document.getMetadata(), document.getFieldObjects()]);
  const metadata = isRecord(info) ? info : {};
  const entries: [string, unknown][] = rawFields instanceof Map
    ? [...rawFields.entries()] as [string, unknown][]
    : isRecord(rawFields) ? Object.entries(rawFields) : [];
  const canonicalNames = new Set(entries.map(([name]) => name));
  const fields = new Map<string, FormFieldSummary>();
  for (const [name, raw] of entries) {
    const first = Array.isArray(raw) ? raw.find(isRecord) : undefined;
    fields.set(name, {
      name,
      type: isRecord(first) && typeof first.type === 'string' ? first.type : 'Unknown',
      pages: [],
      readOnly: isRecord(first) && first.readonly === true,
      inFieldTree: true
    });
  }

  const scannedPages = Math.min(document.numPages, pageLimit);
  let signatureWidgets = 0;
  for (let page = 1; page <= scannedPages; page++) {
    const annotations = await (await document.getPage(page)).getAnnotations({ intent: 'display' });
    for (const annotation of annotations) {
      if (!isRecord(annotation) || annotation.subtype !== 'Widget') continue;
      if (annotation.fieldType === 'Sig') signatureWidgets++;
      const name = typeof annotation.fieldName === 'string' && annotation.fieldName
        ? annotation.fieldName
        : `Unnamed widget (${page}:${String(annotation.id)})`;
      const existing = fields.get(name);
      const summary: FormFieldSummary = existing ?? {
        name, type: 'Unknown', pages: [], readOnly: false, inFieldTree: canonicalNames.has(name)
      };
      if (typeof annotation.fieldType === 'string') summary.type = annotation.fieldType;
      summary.readOnly ||= annotation.readOnly === true;
      if (!summary.pages.includes(page)) summary.pages.push(page);
      fields.set(name, summary);
    }
  }

  const warnings: string[] = [];
  if (scannedPages < document.numPages) warnings.push(`Only the first ${scannedPages} pages were inspected for widgets.`);
  if (metadata.IsXFAPresent === true) warnings.push('XFA data is present. XFA editing is outside the planned first release.');
  if (signatureWidgets > 0) warnings.push('Signature widgets are present. This does not establish whether the PDF is digitally signed.');
  if ([...fields.values()].some(field => !field.inFieldTree)) {
    warnings.push('Some widgets were not returned by PDF.js field discovery. A writer must verify the raw AcroForm tree before editing.');
  }
  return {
    pages: document.numPages,
    scannedPages,
    hasXfa: metadata.IsXFAPresent === true,
    hasAcroForm: metadata.IsAcroFormPresent === true,
    fields: [...fields.values()],
    signatureWidgets,
    warnings
  };
}
