import { PDFDocument, PDFHexString, PDFString, PDFDict, PDFArray, PDFName, PDFNumber, PDFRef, PDFStream, PDFTextField, StandardFonts, rgb, setFontAndSize, setFillingRgbColor } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { multilineAppearance } from './text-appearance.ts';
import { readInk, verifyInk, writeInk } from './ink-engine.ts';
import type { InkStroke } from './ink-engine.ts';
import { defaultColor, validColor } from './text-format.ts';
import type { FontFamily, PdfColor, PdfFonts, TextFormat } from './text-format.ts';
import { referencedObjects, pruneReplacedObjects } from './object-references.ts';
import { validRuledLayout } from './ruled-text.ts';
import type { RuledLayout } from './ruled-text';

export const FIELD_PREFIX = 'pdf-form-studio-';
export type Rect = [number, number, number, number];
export interface TextWidget {
  page: number; rect: Rect; rotation: number;
  appearance?: { borderWidth: number; borderStyle: 'solid' | 'dashed' | 'inset' | 'outset' | 'underline'; borderColor?: PdfColor; backgroundColor?: PdfColor };
  fontSize?: number;
  color?: PdfColor;
}
export interface TextField {
  name: string;
  value: string;
  fontSize: number;
  fontFamily: FontFamily;
  color: PdfColor;
  multiline: boolean;
  readOnly: boolean;
  owned: boolean;
  autoSize?: true;
  alignment?: 'left' | 'center' | 'right';
  maxLength?: number;
  widgets: TextWidget[];
  ruled?: RuledLayout;
}
export interface TextSnapshot { pages: Rect[]; fields: TextField[]; strokes: InkStroke[] }
export interface AddedField { name: string; page: number; rect: Rect; fontSize: number; multiline: boolean; rotation: number; ruled?: RuledLayout }
export interface BoxUpdate { rect: Rect; fontSize: number; multiline: boolean; ruled?: RuledLayout }
export interface TextChanges {
  values: Map<string, string>; added: Map<string, AddedField>; boxes: Map<string, BoxUpdate>; deleted: Set<string>;
  strokes: Map<string, InkStroke>; deletedStrokes: Set<string>;
  formats: Map<string, TextFormat>;
}

async function loadWritable(bytes: Uint8Array): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm?.has(PDFName.of('XFA'))) throw new Error('XFA PDFs are read only in this version.');
  const pending = pdf.context.enumerateIndirectObjects().map(([, object]) => object), visited = new Set();
  while (pending.length) {
    const object = pending.pop()!;
    if (visited.has(object)) continue; visited.add(object);
    if (object instanceof PDFDict && (object.has(PDFName.of('ByteRange')) || object.get(PDFName.of('FT'))?.toString() === '/Sig' || object.get(PDFName.of('Type'))?.toString() === '/Sig')) {
      throw new Error('PDFs containing signature fields are read only in this version.');
    }
    if (object instanceof PDFDict) pending.push(...object.values());
    if (object instanceof PDFArray) pending.push(...object.asArray());
  }
  validateTree(pdf, pdf.catalog.lookup(PDFName.of('Pages')), 'page');
  const roots = acroForm?.lookup(PDFName.of('Fields'));
  if (acroForm?.has(PDFName.of('Fields')) && !(roots instanceof PDFArray)) throw new Error('Malformed PDF form fields.');
  const reachable = roots instanceof PDFArray ? validateTree(pdf, roots, 'form') : new Set<PDFDict | PDFArray>();
  const recovered = recoverTextWidgets(pdf, reachable), fields = pdf.getForm().getFields();
  const textWidgets = new Set(fields.flatMap(field => field instanceof PDFTextField ? field.acroField.getWidgets().map(widget => widget.dict) : []));
  if ([...recovered].some(widget => !textWidgets.has(widget))) throw new Error('Malformed PDF orphan form: incompatible field and widget types.');
  const names = new Set<string>();
  for (const field of fields) {
    const name = field.getName();
    if (field instanceof PDFTextField && !name) throw new Error('The PDF contains an unnamed text field. Editing would be ambiguous.');
    if (names.has(name)) throw new Error('The PDF contains duplicate field names. Editing would be ambiguous.');
    names.add(name);
  }
  return pdf;
}

/** Bound recursive library traversal before entering page/form trees. */
function validateTree(pdf: PDFDocument, root: unknown, kind: string): Set<PDFDict | PDFArray> {
  const pending = [{ value: root, depth: 0 }], seen = new Set<PDFDict | PDFArray>();
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value instanceof PDFArray) {
      if (seen.has(value)) throw new Error(`Malformed PDF ${kind} tree: cyclic array.`);
      seen.add(value); for (const child of value.asArray()) pending.push({ value: pdf.context.lookup(child), depth }); continue;
    }
    if (!(value instanceof PDFDict) || depth > 128 || seen.has(value)) throw new Error(`Malformed PDF ${kind} tree: cyclic, repeated or excessively deep entries.`);
    seen.add(value);
    const parents = new Set<PDFDict>([value]); let parent = value.lookup(PDFName.of('Parent'));
    if (value.has(PDFName.of('Parent')) && !(parent instanceof PDFDict)) throw new Error(`Malformed PDF ${kind} parent chain.`);
    while (parent instanceof PDFDict) {
      if (parents.has(parent) || parents.size > 128) throw new Error(`Malformed PDF ${kind} parent chain.`);
      parents.add(parent); const hasParent = parent.has(PDFName.of('Parent')); parent = parent.lookup(PDFName.of('Parent'));
      if (hasParent && !(parent instanceof PDFDict)) throw new Error(`Malformed PDF ${kind} parent chain.`);
    }
    const children = value.lookup(PDFName.of('Kids'));
    if (children !== undefined) {
      if (!(children instanceof PDFArray)) throw new Error(`Malformed PDF ${kind} children.`);
      pending.push({ value: children, depth: depth + 1 });
    }
  }
  return seen;
}

/** Some PDFs store real field/widgets only in page Annots. Repair this copy, never the source on open. */
function recoverTextWidgets(pdf: PDFDocument, reachable: Set<PDFDict | PDFArray>): Set<PDFDict> {
  const recovered = new Set<PDFDict>();
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots();
    for (const entry of annotations?.asArray() ?? []) {
      const widget = pdf.context.lookup(entry);
      if (!(widget instanceof PDFDict) || widget.get(PDFName.of('Subtype')) !== PDFName.of('Widget') || reachable.has(widget)) continue;
      let root = widget, type: unknown;
      const parents = new Set<PDFDict>();
      for (;;) {
        if (parents.has(root) || parents.size > 128) throw new Error('Malformed PDF orphan form parent chain.');
        parents.add(root);
        type ??= root.lookup(PDFName.of('FT'));
        const parent = root.lookup(PDFName.of('Parent'));
        if (!root.has(PDFName.of('Parent'))) break;
        if (!(parent instanceof PDFDict)) throw new Error('Malformed PDF orphan form parent chain.');
        root = parent;
      }
      if (type !== PDFName.of('Tx')) continue; // Preserve unsupported controls without making them editable.
      const tree = validateTree(pdf, root, 'orphan form');
      if (!tree.has(widget) || [...tree].some(object => reachable.has(object))) {
        throw new Error('Malformed PDF orphan form: inconsistent parent or shared children.');
      }
      // PDF-LIB ignores direct child fields. Do not silently recover only part of a hierarchy.
      for (const object of tree) if (object instanceof PDFArray && object.asArray().some(child => !(child instanceof PDFRef))) {
        throw new Error('Malformed PDF orphan form children: expected indirect references.');
      }
      for (const object of tree) if (object instanceof PDFDict) {
        const children = object.lookup(PDFName.of('Kids'));
        if (children instanceof PDFArray && children.asArray().some(child => pdf.context.lookup(child, PDFDict).lookup(PDFName.of('Parent')) !== object)) {
          throw new Error('Malformed PDF orphan form: inconsistent child parent.');
        }
      }
      const ref = pdf.context.getObjectRef(root) ?? pdf.context.register(root);
      pdf.getForm().acroForm.addField(ref);
      recovered.add(widget);
      for (const object of tree) reachable.add(object);
    }
  }
  return recovered;
}

function editableText(field: PDFTextField): boolean {
  return !field.isReadOnly() && !field.isPassword() && !field.isRichFormatted()
    && field.acroField.getWidgets().every(widget => !(widget.getFlags() & (1 | 2 | 32 | 64 | 128 | 256 | 512)));
}

/** Names alone are not proof of ownership: authored forms can use our prefix. */
function ownedText(field: PDFTextField): boolean {
  if (!field.getName().startsWith(FIELD_PREFIX)) return false;
  const kind = field.acroField.dict.get(PDFName.of('PFSKind'))?.toString();
  if (kind) return kind === '/Text';
  // Earlier releases wrote UUID names and PFSFont metadata, without a kind marker.
  return /^pdf-form-studio-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(field.getName())
    && ['/sans', '/serif', '/mono'].includes(field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() ?? '');
}

function widgetColor(components?: number[]): PdfColor | undefined {
  if (!components?.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
  if (components.length === 1) return [components[0]!, components[0]!, components[0]!];
  if (components.length === 3) return components as PdfColor;
  if (components.length === 4) return components.slice(0, 3).map(value => 1 - Math.min(1, value + components[3]!)) as PdfColor;
  return undefined;
}

function inheritedAppearance(pdf: PDFDocument, field: PDFTextField): string {
  return field.acroField.getDefaultAppearance()
    ?? field.acroField.dict.context.lookupMaybe(field.acroField.getInheritableAttribute(PDFName.of('DA')), PDFString, PDFHexString)?.decodeText()
    ?? pdf.getForm().acroForm.dict.lookupMaybe(PDFName.of('DA'), PDFString, PDFHexString)?.decodeText() ?? '';
}

function originalFont(pdf: PDFDocument, field: PDFTextField): string | undefined {
  const widget = field.acroField.getWidgets()[0];
  const name = /\/([^\s]+)\s+[\d.]+\s+Tf/.exec(widget?.getDefaultAppearance() ?? inheritedAppearance(pdf, field))?.[1];
  if (!name) return undefined;
  const normal = widget?.getAppearances()?.normal;
  const resources = [normal instanceof PDFStream ? normal.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) : undefined,
    pdf.context.lookupMaybe(field.acroField.getInheritableAttribute(PDFName.of('DR')), PDFDict),
    pdf.getForm().acroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict)];
  for (const resource of resources) {
    const font = resource?.lookupMaybe(PDFName.of('Font'), PDFDict)?.lookupMaybe(PDFName.of(name), PDFDict);
    const base = font?.get(PDFName.of('BaseFont'));
    if (base instanceof PDFName) return base.decodeText().replace(/^[A-Z]{6}\+/, '');
  }
  return undefined;
}

export async function readTextPdf(bytes: Uint8Array): Promise<TextSnapshot> {
  const pdf = await loadWritable(bytes);
  const pages = pdf.getPages();
  const fields: TextField[] = [];
  for (const field of pdf.getForm().getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const da = inheritedAppearance(pdf, field), owned = ownedText(field);
    const widgets: TextWidget[] = [];
    for (const widget of field.acroField.getWidgets()) {
      const pageIndex = pages.findIndex(page => {
        if (widget.P()?.toString() === page.ref.toString()) return true;
        const annotations = page.node.Annots();
        return annotations?.asArray().some(ref => pdf.context.lookup(ref) === widget.dict) ?? false;
      });
      if (pageIndex < 0) throw new Error(`Cannot locate the page for field ${field.getName()}.`);
      const { x, y, width, height } = widget.getRectangle();
      const characteristics = widget.getAppearanceCharacteristics(), border = widget.getBorderStyle();
      const borderArray = widget.dict.lookupMaybe(PDFName.of('Border'), PDFArray);
      const style = border?.dict.get(PDFName.of('S'))?.toString();
      const widgetDa = widget.getDefaultAppearance();
      const widgetSize = Number(/([\d.]+)\s+Tf/.exec(widgetDa ?? '')?.[1]) || Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 14;
      const color = defaultColor(widgetDa ?? da);
      widgets.push({ page: pageIndex + 1, rect: [x, y, x + width, y + height], rotation: characteristics?.getRotation() ?? 0,
        ...(!owned ? { appearance: { borderWidth: border?.getWidth() ?? borderArray?.lookupMaybe(2, PDFNumber)?.asNumber() ?? 0,
          borderStyle: style === '/D' ? 'dashed' : style === '/I' ? 'inset' : style === '/B' ? 'outset' : style === '/U' ? 'underline' : 'solid',
          borderColor: widgetColor(characteristics?.getBorderColor()), backgroundColor: widgetColor(characteristics?.getBackgroundColor()) } } : {}),
        ...(!owned && widgetSize !== (Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) || 14) ? { fontSize: widgetSize } : {}),
        ...(!owned && color.some((value, i) => value !== defaultColor(da)[i]) ? { color } : {}) });
    }
    const size = /([\d.]+)\s+Tf/.exec(da)?.[1];
    const stored = field.acroField.dict.lookupMaybe(PDFName.of('PFSRuled'), PDFArray);
    const spacing = stored?.lookupMaybe(0, PDFNumber)?.asNumber(), rows = stored?.lookupMaybe(1, PDFNumber)?.asNumber();
    const ruled = spacing !== undefined && rows !== undefined && owned
      && field.isMultiline() && widgets.length === 1 && widgets[0]!.rotation === 0 && validRuledLayout({ spacing, rows }, widgets[0]!.rect) ? { spacing, rows } : undefined;
    fields.push({
      name: field.getName(), value: field.getText() ?? '', fontSize: Number(size) || 14,
      fontFamily: field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() === '/serif' || originalFont(pdf, field)?.startsWith('Times') ? 'serif'
        : field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() === '/mono' || originalFont(pdf, field)?.startsWith('Courier') ? 'mono' : 'sans', color: defaultColor(da),
      multiline: field.isMultiline(), readOnly: !editableText(field),
      owned, alignment: field.getAlignment() === 1 ? 'center' : field.getAlignment() === 2 ? 'right' : 'left',
      ...(!owned && size !== undefined && Number(size) === 0 ? { autoSize: true as const } : {}),
      maxLength: field.getMaxLength(), widgets, ...(ruled ? { ruled } : {})
    });
  }
  return {
    pages: pages.map(page => {
      const box = page.getCropBox();
      return [box.x, box.y, box.x + box.width, box.y + box.height];
    }), fields, strokes: readInk(pdf)
  };
}

/** Always serializes the session seed plus its complete change set, preventing repeated font/field accumulation. */
export async function writeTextPdf(seed: Uint8Array, changes: TextChanges, fontBytes: PdfFonts): Promise<Uint8Array> {
  const pdf = await loadWritable(seed);
  pdf.registerFontkit(fontkit);
  const form = pdf.getForm();
  const replaced = referencedObjects(pdf, form.getFields().flatMap(field =>
    changes.values.has(field.getName()) || changes.boxes.has(field.getName()) || changes.deleted.has(field.getName())
      ? field.acroField.getWidgets().flatMap(widget => widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.values() ?? []) : []));
  const embedded = new Map<FontFamily, PDFFont>();
  const getFont = async (family: FontFamily): Promise<PDFFont> => {
    let font = embedded.get(family);
    if (!font) { font = await pdf.embedFont(fontBytes instanceof Uint8Array ? fontBytes : fontBytes[family], { subset: true }); embedded.set(family, font); }
    return font;
  };
  for (const name of changes.deleted) {
    const field = form.getFieldMaybe(name);
    if (!(field instanceof PDFTextField) || !ownedText(field) || !editableText(field)) throw new Error('Only editable text boxes created by this plugin can be deleted.');
    if (field) {
      // PDF-LIB 1.17 removes appearance refs instead of separate widget refs.
      // Capture the exact page entries before it deletes their dictionaries.
      const widgets = new Set(field.acroField.getWidgets().map(widget => widget.dict));
      const entries = pdf.getPages().map(page => ({ annotations: page.node.Annots(),
        refs: new Set(page.node.Annots()?.asArray().filter(ref => widgets.has(pdf.context.lookup(ref) as PDFDict)) ?? []) }));
      form.removeField(field);
      for (const { annotations, refs } of entries) if (annotations) {
        for (let i = annotations.size() - 1; i >= 0; i--) if (refs.has(annotations.get(i))) annotations.remove(i);
      }
    }
  }
  for (const added of changes.added.values()) {
    if (!added.name.startsWith(FIELD_PREFIX) || form.getFieldMaybe(added.name)) throw new Error('Invalid or duplicate text box ID.');
    const page = pdf.getPages()[added.page - 1];
    if (!page) throw new Error('The target PDF page no longer exists.');
    const [x1, y1, x2, y2] = added.rect;
    if (![x1, y1, x2, y2, added.fontSize].every(Number.isFinite) || x2 <= x1 || y2 <= y1) throw new Error('Invalid text box geometry.');
    const field = form.createTextField(added.name);
    field.acroField.dict.set(PDFName.of('PFSKind'), PDFName.of('Text'));
    if (added.multiline) field.enableMultiline();
    field.addToPage(page, { x: x1, y: y1, width: x2 - x1, height: y2 - y1, borderWidth: 0,
      backgroundColor: undefined, borderColor: undefined, textColor: rgb(0.05, 0.05, 0.05), font: await getFont('sans') });
    field.setFontSize(added.fontSize);
    if (added.ruled) {
      if (!added.multiline || added.rotation || !validRuledLayout(added.ruled, added.rect)) throw new Error('Invalid ruled answer layout.');
      field.acroField.dict.set(PDFName.of('PFSRuled'), pdf.context.obj([added.ruled.spacing, added.ruled.rows]));
    }
    // Rotate the widget appearance to follow the user's current viewport orientation.
    if (added.rotation) field.acroField.getWidgets()[0]?.getOrCreateAppearanceCharacteristics().setRotation(added.rotation);
  }
  for (const [name, box] of changes.boxes) {
    if (changes.deleted.has(name)) continue;
    const field = form.getTextField(name);
    if (!ownedText(field)) throw new Error('Only added text boxes can be moved or resized.');
    const widgets = field.acroField.getWidgets();
    if (widgets.length !== 1 || field.isReadOnly()) throw new Error('This text box cannot be resized.');
    const [x1, y1, x2, y2] = box.rect;
    if (![...box.rect, box.fontSize].every(Number.isFinite) || x2 <= x1 || y2 <= y1 || box.fontSize <= 0) throw new Error('Invalid text box geometry.');
    widgets[0]!.setRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    field.setFontSize(box.fontSize);
    if (box.multiline) field.enableMultiline(); else field.disableMultiline();
    if (box.ruled) {
      if (!box.multiline || !validRuledLayout(box.ruled, box.rect)) throw new Error('Invalid ruled answer layout.');
      field.acroField.dict.set(PDFName.of('PFSRuled'), pdf.context.obj([box.ruled.spacing, box.ruled.rows]));
    } else field.acroField.dict.delete(PDFName.of('PFSRuled'));
  }
  for (const [name, value] of changes.values) {
    if (changes.deleted.has(name)) continue;
    const field = form.getTextField(name);
    const owned = ownedText(field), originalDa = inheritedAppearance(pdf, field);
    const widgetDefaults = field.acroField.getWidgets().map(widget => widget.getDefaultAppearance());
    const baseFont = originalFont(pdf, field);
    const family = changes.formats.get(name)?.fontFamily ?? (field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() === '/serif' || baseFont?.startsWith('Times') ? 'serif'
      : field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() === '/mono' || baseFont?.startsWith('Courier') ? 'mono' : 'sans');
    let font: PDFFont;
    if (!owned && !changes.formats.has(name) && Object.values(StandardFonts).includes(baseFont as StandardFonts)) {
      font = await pdf.embedFont(baseFont as StandardFonts);
      const supported = new Set(font.getCharacterSet());
      if ([...value].some(character => ![9, 10, 13].includes(character.codePointAt(0)!) && !supported.has(character.codePointAt(0)!))) font = await getFont(family);
    } else font = await getFont(family);
    const supported = new Set(font.getCharacterSet());
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (code !== 10 && code !== 13 && code !== 9 && !supported.has(code)) {
        throw new Error(`The PDF font cannot render U+${code.toString(16).toUpperCase()}. Your text is kept here; replace the unsupported character before saving.`);
      }
    }
    if (!editableText(field)) throw new Error(`Field ${name} is read only or unsupported.`);
    const maximum = field.getMaxLength();
    if (maximum !== undefined && value.length > maximum) throw new Error(`Field ${name} allows at most ${maximum} characters.`);
    field.setText(value);
    const format = changes.formats.get(name);
    const color = format?.color ?? defaultColor(originalDa);
    const originalSize = /([\d.]+)\s+Tf/.exec(originalDa)?.[1];
    const size = format?.autoSize ? 0 : format?.fontSize ?? changes.boxes.get(name)?.fontSize ?? (originalSize !== undefined ? Number(originalSize) : 14);
    if (!Number.isFinite(size) || size < 0 || size > 200 || !validColor(color)) throw new Error('Invalid text formatting.');
    const da = `${setFillingRgbColor(...color)}\n${setFontAndSize(font.name, size)}`;
    field.acroField.setDefaultAppearance(da); field.acroField.dict.set(PDFName.of('PFSFont'), PDFName.of(family));
    // Keep each authored widget's size/color overrides when only its value changes.
    const widgetDas = field.acroField.getWidgets().map((widget, index) => {
      const original = widgetDefaults[index] ?? originalDa;
      const widgetSize = /([\d.]+)\s+Tf/.exec(original)?.[1];
      const next = !owned && (!format || format.preserveWidgetSizes) ? `${setFillingRgbColor(...(format?.color ?? defaultColor(original)))}\n${setFontAndSize(font.name, widgetSize !== undefined ? Number(widgetSize) : size)}` : da;
      widget.setDefaultAppearance(next); return next;
    });
    field.acroField.dict.set(PDFName.of('PFSKind'), PDFName.of(owned ? 'Text' : 'Form'));
    // Capture stream refs now: PDF-LIB mutates the AP dictionary in place.
    for (const ref of referencedObjects(pdf, field.acroField.getWidgets().flatMap(widget => widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.values() ?? []))) replaced.add(ref);
    field.updateAppearances(font, owned && field.isMultiline() ? multilineAppearance : undefined);
    // PDF-LIB resolves auto-size (0) while drawing. Retain that form option for future edits.
    if (!owned && (!format || format.preserveWidgetSizes)) {
      field.acroField.setDefaultAppearance(da);
      field.acroField.getWidgets().forEach((widget, index) => widget.setDefaultAppearance(widgetDas[index]!));
    }
  }
  writeInk(pdf, changes.strokes, changes.deletedStrokes);
  await pdf.flush();
  // Embedded fonts may only resolve after flush; expand the captured refs then.
  pruneReplacedObjects(pdf, referencedObjects(pdf, [...replaced]));
  const bytes = await pdf.save({ updateFieldAppearances: false });
  // Reopen and verify logical values, widget appearances, and page count before any vault write.
  const verified = await PDFDocument.load(bytes, { updateMetadata: false });
  if (verified.getPageCount() !== pdf.getPageCount()) throw new Error('PDF page verification failed.');
  verifyInk(verified, changes.strokes, changes.deletedStrokes);
  for (const [name, value] of changes.values) {
    if (changes.deleted.has(name)) continue;
    const field = verified.getForm().getTextField(name);
    if ((field.getText() ?? '') !== value) throw new Error(`PDF value verification failed for ${name}.`);
    for (const widget of field.acroField.getWidgets()) {
      if (!(widget.getAppearances()?.normal instanceof PDFStream)) throw new Error(`PDF appearance verification failed for ${name}.`);
    }
  }
  for (const [name, format] of changes.formats) {
    if (changes.deleted.has(name)) continue;
    const field = verified.getForm().getTextField(name);
    const da = field.acroField.getDefaultAppearance() ?? '';
    if (field.acroField.dict.get(PDFName.of('PFSFont'))?.toString() !== '/' + format.fontFamily
      || Math.abs(Number(/([\d.]+)\s+Tf/.exec(da)?.[1]) - (format.autoSize ? 0 : format.fontSize)) > 0.001
      || defaultColor(da).some((value, i) => Math.abs(value - format.color[i]!) > 0.001)) throw new Error('PDF text formatting verification failed.');
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
  const layouts = new Map([...changes.added.values()].map(item => [item.name, item.ruled]));
  for (const [name, box] of changes.boxes) layouts.set(name, box.ruled);
  for (const [name, expected] of layouts) {
    if (changes.deleted.has(name)) continue;
    const layout = verified.getForm().getTextField(name).acroField.dict.lookupMaybe(PDFName.of('PFSRuled'), PDFArray);
    if (expected ? !layout || Math.abs(layout.lookup(0, PDFNumber).asNumber() - expected.spacing) > 0.001 || layout.lookup(1, PDFNumber).asNumber() !== expected.rows : !!layout) {
      throw new Error(`PDF ruled layout verification failed for ${name}.`);
    }
  }
  return bytes;
}

/** Display copy only: keep foreign annotations and editable widgets; own ink is painted live. */
export async function renderTextPdf(seed: Uint8Array): Promise<Uint8Array> {
  const pdf = await loadWritable(seed);
  // Text widgets are painted by the stable editable layer. Preserve other
  // controls and foreign annotations in the background, including checkboxes.
  const textWidgets = new Set(pdf.getForm().getFields().flatMap(field => field instanceof PDFTextField && editableText(field) ? field.acroField.getWidgets().map(widget => widget.dict) : []));
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots(); if (!annotations) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const dict = annotations.lookup(i);
      if (dict instanceof PDFDict && textWidgets.has(dict)) { annotations.remove(i); continue; }
      if (dict instanceof PDFDict && ['/Marker', '/Scribble'].includes(dict.get(PDFName.of('PFSKind'))?.toString() ?? '')
        && dict.get(PDFName.of('Subtype'))?.toString() === '/Ink'
        && !((dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) & (1 | 2 | 32 | 256))
        && readInkId(dict)?.startsWith('pdf-form-studio-ink-')) annotations.remove(i);
    }
  }
  return pdf.save({ updateFieldAppearances: false });
}
function readInkId(dict: PDFDict): string | undefined {
  const value = dict.lookup(PDFName.of('NM'));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}
