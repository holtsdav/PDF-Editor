import { adjustDimsForRotation, drawTextField, PDFArray, PDFName, PDFNumber, reduceRotation, rgb, rotateInPlace, setFillingRgbColor, setFontAndSize, TextAlignment } from 'pdf-lib';
import type { AppearanceProviderFor, PDFTextField } from 'pdf-lib';
import { wrapText } from './wrap-text.ts';
import { defaultColor, spacedWidth, textGraphemes, validSpacing } from './text-format.ts';

/** Owned boxes share tracking, leading and wrapping with the editable preview. */
export const multilineAppearance: AppearanceProviderFor<PDFTextField> = (field, widget, font) => {
  const size = Number(/([\d.]+)\s+Tf/.exec(field.acroField.getDefaultAppearance() ?? '')?.[1]) || 14;
  const rectangle = widget.getRectangle();
  const rotation = reduceRotation(widget.getAppearanceCharacteristics()?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const padding = 1; const border = widget.getBorderStyle()?.getWidth() ?? 0;
  const innerWidth = width - 2 * (border + padding);
  const letter = field.acroField.dict.lookupMaybe(PDFName.of('PFSLetterSpacing'), PDFNumber)?.asNumber() ?? 0;
  const lineSpacing = field.acroField.dict.lookupMaybe(PDFName.of('PFSLineSpacing'), PDFNumber)?.asNumber() ?? 1.2;
  if (!validSpacing(letter, lineSpacing)) throw new Error('Invalid text spacing.');
  const measure = (text: string) => spacedWidth(text, part => font.widthOfTextAtSize(part, size), letter);
  const lines = field.isMultiline() ? wrapText(field.getText() ?? '', innerWidth, measure) : [field.getText() ?? ''];
  if (field.isMultiline() && lines.some(text => measure(text) > innerWidth + 0.01)) throw new Error('A character does not fit in this text box. Your text is kept; widen the box before saving.');
  const stored = field.acroField.dict.lookupMaybe(PDFName.of('PFSRuled'), PDFArray);
  const spacing = stored?.lookupMaybe(0, PDFNumber)?.asNumber();
  const leading = spacing ?? size * lineSpacing;
  // The first row retains its usual baseline; later rows follow the printed pitch.
  const baseline = font.heightAtSize(size, { descender: false }) + (size * lineSpacing - font.heightAtSize(size)) / 2;
  const textLines = lines.flatMap((text, index) => {
    const textWidth = measure(text);
    const alignment = field.getAlignment();
    const offset = alignment === TextAlignment.Center ? (innerWidth - textWidth) / 2 : alignment === TextAlignment.Right ? innerWidth - textWidth : 0;
    let x = border + padding + offset;
    // Tracking is applied between grapheme clusters, never between the base and a combining mark.
    return (letter ? textGraphemes(text) : [text]).map(part => {
      const width = font.widthOfTextAtSize(part, size);
      const result = { text: part, encoded: font.encodeText(part), width, height: font.heightAtSize(size), x,
        y: height - border - padding - baseline - index * leading };
      x += width + letter; return result;
    });
  });
  const color = rgb(...defaultColor(field.acroField.getDefaultAppearance() ?? ''));
  const appearance = `${setFillingRgbColor(color.red, color.green, color.blue)}\n${setFontAndSize(font.name, size)}`;
  field.acroField.setDefaultAppearance(appearance); widget.setDefaultAppearance(appearance);
  return [...rotateInPlace({ ...rectangle, rotation }), ...drawTextField({ x: border / 2, y: border / 2,
    width: width - border, height: height - border, borderWidth: border, borderColor: undefined, color: undefined,
    textLines, textColor: color, font: font.name, fontSize: size, padding })];
};
