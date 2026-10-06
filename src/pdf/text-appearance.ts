import { adjustDimsForRotation, drawTextField, PDFArray, PDFName, PDFNumber, reduceRotation, rgb, rotateInPlace, setFillingRgbColor, setFontAndSize, TextAlignment } from 'pdf-lib';
import type { AppearanceProviderFor, PDFTextField } from 'pdf-lib';
import { wrapText } from './wrap-text.ts';
import { defaultColor } from './text-format.ts';

/** Owned multiline boxes use the editor's 1.2em leading and browser font baseline. */
export const multilineAppearance: AppearanceProviderFor<PDFTextField> = (field, widget, font) => {
  const size = Number(/([\d.]+)\s+Tf/.exec(field.acroField.getDefaultAppearance() ?? '')?.[1]) || 14;
  const rectangle = widget.getRectangle();
  const rotation = reduceRotation(widget.getAppearanceCharacteristics()?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const padding = 1; const border = widget.getBorderStyle()?.getWidth() ?? 0;
  const innerWidth = width - 2 * (border + padding);
  const lines = wrapText(field.getText() ?? '', innerWidth, text => font.widthOfTextAtSize(text, size));
  const stored = field.acroField.dict.lookupMaybe(PDFName.of('PFSRuled'), PDFArray);
  const spacing = stored?.lookupMaybe(0, PDFNumber)?.asNumber();
  const leading = spacing ?? size * 1.2;
  // The first row retains its usual baseline; later rows follow the printed pitch.
  const baseline = font.heightAtSize(size, { descender: false }) + (size * 1.2 - font.heightAtSize(size)) / 2;
  const textLines = lines.map((text, index) => {
    const textWidth = font.widthOfTextAtSize(text, size);
    const alignment = field.getAlignment();
    const offset = alignment === TextAlignment.Center ? (innerWidth - textWidth) / 2 : alignment === TextAlignment.Right ? innerWidth - textWidth : 0;
    return { text, encoded: font.encodeText(text), width: textWidth, height: font.heightAtSize(size),
      x: border + padding + offset, y: height - border - padding - baseline - index * leading };
  });
  const color = rgb(...defaultColor(field.acroField.getDefaultAppearance() ?? ''));
  const appearance = `${setFillingRgbColor(color.red, color.green, color.blue)}\n${setFontAndSize(font.name, size)}`;
  field.acroField.setDefaultAppearance(appearance); widget.setDefaultAppearance(appearance);
  return [...rotateInPlace({ ...rectangle, rotation }), ...drawTextField({ x: border / 2, y: border / 2,
    width: width - border, height: height - border, borderWidth: border, borderColor: undefined, color: undefined,
    textLines, textColor: color, font: font.name, fontSize: size, padding })];
};
