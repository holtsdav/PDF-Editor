import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFStream,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import type { PDFDocument, PDFFont, PDFField, PDFWidgetAnnotation } from 'pdf-lib';
import type { Rect } from './text-engine.ts';
import type { PdfColor } from './text-format.ts';

/** Checkboxes, radio buttons, dropdowns and single-select list boxes from an authored PDF form. */
export type ChoiceKind = 'checkbox' | 'radio' | 'dropdown' | 'list';
export interface ChoiceOption {
  /** Exported value written to the PDF. */
  value: string;
  /** Text shown to the user. */
  label: string;
}
export interface ChoiceWidget {
  page: number;
  rect: Rect;
  rotation: number;
  /** Button "on" state name for checkboxes and radio buttons. */
  onValue?: string;
  /** Human-readable label of this button (radio export value when present). */
  label?: string;
  /** Mark shown when a button is on, mapped from its ZapfDingbats caption. */
  mark?: string;
  borderColor?: PdfColor;
  backgroundColor?: PdfColor;
  borderWidth?: number;
  fontSize?: number;
}
export interface ChoiceField {
  name: string;
  kind: ChoiceKind;
  /** Button on-state name, selected export value, or '' for off/none. */
  value: string;
  options: ChoiceOption[];
  readOnly: boolean;
  widgets: ChoiceWidget[];
}

const HIDDEN_FLAGS = 1 | 2 | 32 | 256;
// ZapfDingbats captions commonly used by form authors for button marks.
const MARKS: Record<string, string> = {
  '4': '✔',
  '8': '✘',
  l: '●',
  n: '■',
  u: '◆',
  H: '★',
};

type ChoicePdfField = PDFCheckBox | PDFRadioGroup | PDFDropdown | PDFOptionList;

function isChoice(field: PDFField): field is ChoicePdfField {
  return (
    field instanceof PDFCheckBox ||
    field instanceof PDFRadioGroup ||
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList
  );
}

function kindOf(field: ChoicePdfField): ChoiceKind {
  return field instanceof PDFCheckBox
    ? 'checkbox'
    : field instanceof PDFRadioGroup
      ? 'radio'
      : field instanceof PDFDropdown
        ? 'dropdown'
        : 'list';
}

function color(components?: number[]): PdfColor | undefined {
  if (!components?.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    return undefined;
  }
  if (components.length === 1) {
    return [components[0]!, components[0]!, components[0]!];
  }
  if (components.length === 3) {
    return components as PdfColor;
  }
  if (components.length === 4) {
    return components
      .slice(0, 3)
      .map((value) => 1 - Math.min(1, value + components[3]!)) as PdfColor;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function pageOf(pdf: PDFDocument, widget: PDFWidgetAnnotation): number {
  const pages = pdf.getPages();
  const index = pages.findIndex(
    (page) =>
      widget.P()?.toString() === page.ref.toString() ||
      (page.node
        .Annots()
        ?.asArray()
        .some((ref) => pdf.context.lookup(ref) === widget.dict) ??
        false),
  );
  return index + 1;
}

function chosenOptions(field: PDFDropdown | PDFOptionList): ChoiceOption[] {
  return field.acroField.getOptions().map(({ value, display }) => ({
    value: value.decodeText(),
    label: (display ?? value).decodeText(),
  }));
}

function buttonValue(field: PDFCheckBox | PDFRadioGroup): string {
  const value = field.acroField.getValue();
  return value === PDFName.of('Off') ? '' : value.decodeText();
}

function choiceValue(field: PDFDropdown | PDFOptionList): string {
  const values = field.acroField.getValues();
  return values.length === 1 ? values[0]!.decodeText() : '';
}

/** Whether this plugin can change the field safely. Unsupported controls keep their authored appearance. */
function editable(field: ChoicePdfField): boolean {
  if (!field.getName() || field.isReadOnly()) {
    return false;
  }
  const widgets = field.acroField.getWidgets();
  if (!widgets.length || widgets.some((widget) => widget.getFlags() & HIDDEN_FLAGS)) {
    return false;
  }
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    // Buttons without an "on" appearance state cannot show a checked state.
    return widgets.every((widget) => widget.getOnValue() !== undefined);
  }
  return !field.isMultiselect() && field.acroField.getValues().length <= 1;
}

/** Read every checkbox, radio group, dropdown and list box with stable widget positions. */
export function readChoices(pdf: PDFDocument): ChoiceField[] {
  const choices: ChoiceField[] = [];
  for (const field of pdf.getForm().getFields()) {
    if (!isChoice(field)) {
      continue;
    }
    const kind = kindOf(field);
    const exports =
      field instanceof PDFCheckBox || field instanceof PDFRadioGroup
        ? field.acroField.getExportValues()?.map((value) => value.decodeText())
        : undefined;
    const widgets: ChoiceWidget[] = [];
    let located = true;
    field.acroField.getWidgets().forEach((widget, index) => {
      const page = pageOf(pdf, widget);
      if (page < 1) {
        located = false;
        return;
      }
      const { x, y, width, height } = widget.getRectangle();
      const characteristics = widget.getAppearanceCharacteristics();
      const caption = text(characteristics?.dict.lookup(PDFName.of('CA')));
      const onValue = widget.getOnValue()?.decodeText();
      const border = widget.getBorderStyle();
      const borderArray = widget.dict.lookupMaybe(PDFName.of('Border'), PDFArray);
      const da = widget.getDefaultAppearance() ?? field.acroField.getDefaultAppearance() ?? '';
      const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1]);
      widgets.push({
        page,
        rect: [x, y, x + width, y + height],
        rotation: characteristics?.getRotation() ?? 0,
        ...(onValue !== undefined ? { onValue, label: exports?.[index] ?? onValue } : {}),
        ...(kind === 'checkbox' || kind === 'radio'
          ? { mark: MARKS[caption ?? ''] ?? (kind === 'radio' ? '●' : '✔') }
          : {}),
        borderColor: color(characteristics?.getBorderColor()),
        backgroundColor: color(characteristics?.getBackgroundColor()),
        borderWidth: border?.getWidth() ?? borderArray?.lookupMaybe(2, PDFNumber)?.asNumber() ?? 1,
        ...(size > 0 ? { fontSize: size } : {}),
      });
    });
    choices.push({
      name: field.getName(),
      kind,
      value:
        field instanceof PDFCheckBox || field instanceof PDFRadioGroup
          ? buttonValue(field)
          : choiceValue(field),
      options:
        field instanceof PDFDropdown || field instanceof PDFOptionList ? chosenOptions(field) : [],
      readOnly: !located || !editable(field),
      widgets,
    });
  }
  return choices;
}

/** Widget dictionaries the editor paints itself, so the background render must omit them. */
export function editableChoiceWidgets(pdf: PDFDocument): Set<PDFDict> {
  const result = new Set<PDFDict>();
  for (const field of pdf.getForm().getFields()) {
    if (isChoice(field) && editable(field)) {
      for (const widget of field.acroField.getWidgets()) {
        result.add(widget.dict);
      }
    }
  }
  return result;
}

/** Appearance dictionaries that a write replaces, for pruning orphaned streams. */
export function replacedChoiceAppearances(pdf: PDFDocument, changes: Map<string, string>) {
  return pdf
    .getForm()
    .getFields()
    .flatMap((field) =>
      changes.has(field.getName()) &&
      (field instanceof PDFDropdown || field instanceof PDFOptionList)
        ? field.acroField
            .getWidgets()
            .flatMap((widget) => widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.values() ?? [])
        : [],
    );
}

function setButton(field: PDFCheckBox | PDFRadioGroup, value: string): void {
  const widgets = field.acroField.getWidgets();
  const target = value ? PDFName.of(value) : PDFName.of('Off');
  if (value && !widgets.some((widget) => widget.getOnValue() === target)) {
    throw new Error(`"${value}" is not an option of ${field.getName()}.`);
  }
  field.acroField.dict.set(PDFName.of('V'), target);
  for (const widget of widgets) {
    widget.setAppearanceState(widget.getOnValue() === target ? target : PDFName.of('Off'));
  }
}

async function choiceFont(
  pdf: PDFDocument,
  field: PDFDropdown | PDFOptionList,
  labels: string[],
  fallback: () => Promise<PDFFont>,
): Promise<PDFFont> {
  const da =
    field.acroField.getWidgets()[0]?.getDefaultAppearance() ??
    field.acroField.getDefaultAppearance() ??
    text(pdf.getForm().acroForm.dict.lookup(PDFName.of('DA'))) ??
    '';
  const name = /\/([^\s]+)\s+[\d.]+\s+Tf/.exec(da)?.[1];
  const resources = pdf.getForm().acroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict);
  const base = resources
    ?.lookupMaybe(PDFName.of('Font'), PDFDict)
    ?.lookupMaybe(PDFName.of(name ?? ''), PDFDict)
    ?.get(PDFName.of('BaseFont'));
  const standard =
    base instanceof PDFName
      ? base.decodeText().replace(/^[A-Z]{6}\+/, '')
      : StandardFonts.Helvetica;
  if (Object.values(StandardFonts).includes(standard as StandardFonts)) {
    const font = await pdf.embedFont(standard as StandardFonts);
    const supported = new Set(font.getCharacterSet());
    if (labels.every((label) => [...label].every((c) => supported.has(c.codePointAt(0)!)))) {
      return font;
    }
  }
  return fallback();
}

/** Apply choice values to a writable copy and regenerate list appearances. */
export async function writeChoices(
  pdf: PDFDocument,
  changes: Map<string, string>,
  fallbackFont: () => Promise<PDFFont>,
): Promise<void> {
  const form = pdf.getForm();
  for (const [name, value] of changes) {
    const field = form.getFieldMaybe(name);
    if (!field || !isChoice(field) || !editable(field)) {
      throw new Error(`Field ${name} is read only or unsupported.`);
    }
    if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      setButton(field, value);
      if (field.needsAppearancesUpdate()) {
        field.defaultUpdateAppearances();
      }
      continue;
    }
    const options = chosenOptions(field);
    const index = options.findIndex((option) => option.value === value);
    if (value && index < 0 && !(field instanceof PDFDropdown && field.isEditable())) {
      throw new Error(`"${value}" is not an option of ${name}.`);
    }
    if (value) {
      field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(value));
    } else {
      field.acroField.dict.delete(PDFName.of('V'));
    }
    if (field instanceof PDFOptionList && index >= 0) {
      field.acroField.dict.set(PDFName.of('I'), pdf.context.obj([index]));
    } else {
      field.acroField.dict.delete(PDFName.of('I'));
    }
    const shown = options.find((option) => option.value === value)?.label ?? value;
    const font = await choiceFont(
      pdf,
      field,
      [shown, ...options.map((option) => option.label)],
      fallbackFont,
    );
    field.updateAppearances(font);
  }
}

/** Reopened-output check: every requested value must read back exactly. */
export function verifyChoices(pdf: PDFDocument, changes: Map<string, string>): void {
  const form = pdf.getForm();
  for (const [name, value] of changes) {
    const field = form.getFieldMaybe(name);
    if (!field || !isChoice(field)) {
      throw new Error(`PDF value verification failed for ${name}.`);
    }
    const stored =
      field instanceof PDFCheckBox || field instanceof PDFRadioGroup
        ? buttonValue(field)
        : choiceValue(field);
    if (stored !== value) {
      throw new Error(`PDF value verification failed for ${name}.`);
    }
    if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      for (const widget of field.acroField.getWidgets()) {
        const expected = widget.getOnValue()?.decodeText() === value && value ? value : 'Off';
        if (widget.getAppearanceState()?.decodeText() !== expected) {
          throw new Error(`PDF appearance verification failed for ${name}.`);
        }
      }
    } else {
      for (const widget of field.acroField.getWidgets()) {
        if (!(widget.getAppearances()?.normal instanceof PDFStream)) {
          throw new Error(`PDF appearance verification failed for ${name}.`);
        }
      }
    }
  }
}
