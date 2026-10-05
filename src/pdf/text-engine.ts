import { PDFDocument, PDFDict, PDFName, PDFStream, PDFTextField, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { multilineAppearance } from './text-appearance.ts';

export const FIELD_PREFIX = 'pdf-form-studio-';
export type Rect = [number, number, number, number];
export interface TextWidget { page: number; rect: Rect; rotation: number }
export interface TextField {
  name: string;
  value: string;
  fontSize: number;
  multiline: boolean;
  readOnly: boolean;
  owned: boolean;
  maxLength?: number;
  widgets: TextWidget[];
}
export interface TextSnapshot { pages: Rect[]; fields: TextField[] }
export interface AddedField { name: string; page: number; rect: Rect; fontSize: number; multiline: boolean; rotation: number }
export interface BoxUpdate { rect: Rect; fontSize: number; multiline: boolean }
export interface TextChanges { values: Map<string, string>; added: Map<string, AddedField>; boxes: Map<string, BoxUpdate>; deleted: Set<string> }

async function loadWritable(bytes: Uint8Array): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm?.has(PDFName.of('XFA'))) throw new Error('XFA PDFs are read only in this version.');
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && (object.has(PDFName.of('ByteRange')) || object.get(PDFName.of('FT'))?.toString() === '/Sig')) {
      throw new Error('PDFs containing signature fields are read only in this version.');
    }
  }
  return pdf;
}

export async function readTextPdf(bytes: Uint8Array): Promise<TextSnapshot> {
  const pdf = await loadWritable(bytes);
  const pages = pdf.getPages();
  const fields: TextField[] = [];
  for (const field of pdf.getForm().getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const widgets: TextWidget[] = [];
    for (const widget of field.acroField.getWidgets()) {
      const pageIndex = pages.findIndex(page => {
        if (widget.P()?.toString() === page.ref.toString()) return true;
        const annotations = page.node.Annots();
        return annotations?.asArray().some(ref => pdf.context.lookup(ref) === widget.dict) ?? false;
      });
      if (pageIndex < 0) throw new Error(`Cannot locate the page for field ${field.getName()}.`);
      const { x, y, width, height } = widget.getRectangle();
      widgets.push({ page: pageIndex + 1, rect: [x, y, x + width, y + height], rotation: widget.getAppearanceCharacteristics()?.getRotation() ?? 0 });
    }
    const da = field.acroField.getDefaultAppearance() ?? '';
    const size = /([\d.]+)\s+Tf/.exec(da)?.[1];
    fields.push({
      name: field.getName(), value: field.getText() ?? '', fontSize: Number(size) || 14,
      multiline: field.isMultiline(), readOnly: field.isReadOnly() || field.isPassword() || field.isRichFormatted(),
      owned: field.getName().startsWith(FIELD_PREFIX), maxLength: field.getMaxLength(), widgets
    });
  }
  return {
    pages: pages.map(page => {
      const box = page.getCropBox();
      return [box.x, box.y, box.x + box.width, box.y + box.height];
    }), fields
  };
}

/** Always serializes the session seed plus its complete change set, preventing repeated font/field accumulation. */
export async function writeTextPdf(seed: Uint8Array, changes: TextChanges, fontBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await loadWritable(seed);
  pdf.registerFontkit(fontkit);
  const form = pdf.getForm();
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  for (const name of changes.deleted) {
    if (!name.startsWith(FIELD_PREFIX)) throw new Error('Only text boxes created by this plugin can be deleted.');
    const field = form.getFieldMaybe(name);
    if (field) form.removeField(field);
  }
  for (const added of changes.added.values()) {
    if (!added.name.startsWith(FIELD_PREFIX) || form.getFieldMaybe(added.name)) throw new Error('Invalid or duplicate text box ID.');
    const page = pdf.getPages()[added.page - 1];
    if (!page) throw new Error('The target PDF page no longer exists.');
    const [x1, y1, x2, y2] = added.rect;
    if (![x1, y1, x2, y2, added.fontSize].every(Number.isFinite) || x2 <= x1 || y2 <= y1) throw new Error('Invalid text box geometry.');
    const field = form.createTextField(added.name);
    if (added.multiline) field.enableMultiline();
    field.addToPage(page, { x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderWidth: 0,
      backgroundColor: undefined, borderColor: undefined, textColor: rgb(0.05, 0.05, 0.05), font });
    field.setFontSize(added.fontSize);
    // Rotate the widget appearance to follow the user's current viewport orientation.
    if (added.rotation) field.acroField.getWidgets()[0]?.getOrCreateAppearanceCharacteristics().setRotation(added.rotation);
  }
  for (const [name, box] of changes.boxes) {
    if (changes.deleted.has(name)) continue;
    if (!name.startsWith(FIELD_PREFIX)) throw new Error('Only added text boxes can be moved or resized.');
    const field = form.getTextField(name);
    const widgets = field.acroField.getWidgets();
    if (widgets.length !== 1 || field.isReadOnly()) throw new Error('This text box cannot be resized.');
    const [x1, y1, x2, y2] = box.rect;
    if (![...box.rect, box.fontSize].every(Number.isFinite) || x2 <= x1 || y2 <= y1 || box.fontSize <= 0) throw new Error('Invalid text box geometry.');
    widgets[0]!.setRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    field.setFontSize(box.fontSize);
    if (box.multiline) field.enableMultiline(); else field.disableMultiline();
    field.updateAppearances(font, box.multiline ? multilineAppearance : undefined);
  }
  for (const [name, value] of changes.values) {
    if (changes.deleted.has(name)) continue;
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (code !== 10 && code !== 13 && code !== 9 && !supported.has(code)) {
        throw new Error(`The PDF font cannot render U+${code.toString(16).toUpperCase()}. Your text is kept here; replace the unsupported character before saving.`);
      }
    }
    const field = form.getTextField(name);
    if (field.isReadOnly() || field.isPassword() || field.isRichFormatted()) throw new Error(`Field ${name} is read only or unsupported.`);
    const maximum = field.getMaxLength();
    if (maximum !== undefined && value.length > maximum) throw new Error(`Field ${name} allows at most ${maximum} characters.`);
    field.setText(value);
    field.updateAppearances(font, field.getName().startsWith(FIELD_PREFIX) && field.isMultiline() ? multilineAppearance : undefined);
  }
  const bytes = await pdf.save({ updateFieldAppearances: false });
  // Reopen and verify logical values, widget appearances, and page count before any vault write.
  const verified = await PDFDocument.load(bytes, { updateMetadata: false });
  if (verified.getPageCount() !== pdf.getPageCount()) throw new Error('PDF page verification failed.');
  for (const [name, value] of changes.values) {
    if (changes.deleted.has(name)) continue;
    const field = verified.getForm().getTextField(name);
    if ((field.getText() ?? '') !== value) throw new Error(`PDF value verification failed for ${name}.`);
    for (const widget of field.acroField.getWidgets()) {
      if (!(widget.getAppearances()?.normal instanceof PDFStream)) throw new Error(`PDF appearance verification failed for ${name}.`);
    }
  }
  for (const name of changes.deleted) {
    if (verified.getForm().getFieldMaybe(name)) throw new Error(`PDF deletion verification failed for ${name}.`);
  }
  for (const [name, box] of changes.boxes) {
    if (changes.deleted.has(name)) continue;
    const field = verified.getForm().getTextField(name);
    const widget = field.acroField.getWidgets()[0]!;
    const { x, y, width, height } = widget.getRectangle();
    if ([x, y, x + width, y + height].some((value, index) => Math.abs(value - box.rect[index]!) > 0.001)
      || field.isMultiline() !== box.multiline || !(widget.getAppearances()?.normal instanceof PDFStream)) {
      throw new Error(`PDF text box verification failed for ${name}.`);
    }
  }
  return bytes;
}
