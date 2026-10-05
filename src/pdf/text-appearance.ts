import { adjustDimsForRotation, drawTextField, layoutMultilineText, reduceRotation, rgb, rotateInPlace, setFillingRgbColor, setFontAndSize } from 'pdf-lib';
import type { AppearanceProviderFor, PDFTextField } from 'pdf-lib';

/** Owned multiline boxes use the editor's 1.2em leading and browser font baseline. */
export const multilineAppearance: AppearanceProviderFor<PDFTextField> = (field, widget, font) => {
  const size = Number(/([\d.]+)\s+Tf/.exec(field.acroField.getDefaultAppearance() ?? '')?.[1]) || 14;
  const rectangle = widget.getRectangle();
  const rotation = reduceRotation(widget.getAppearanceCharacteristics()?.getRotation());
  const { width, height } = adjustDimsForRotation(rectangle, rotation);
  const padding = 1; const border = widget.getBorderStyle()?.getWidth() ?? 0;
  const layout = layoutMultilineText(field.getText() ?? '', { alignment: field.getAlignment(), fontSize: size, font,
    bounds: { x: border + padding, y: border + padding, width: width - 2 * (border + padding), height: height - 2 * (border + padding) } });
  const leading = size * 1.2;
  const baseline = font.heightAtSize(size, { descender: false }) + (leading - font.heightAtSize(size)) / 2;
  const textLines = layout.lines.map((line, index) => ({ ...line, y: height - border - padding - baseline - index * leading }));
  const appearance = `${setFillingRgbColor(0.05, 0.05, 0.05)}\n${setFontAndSize(font.name, size)}`;
  field.acroField.setDefaultAppearance(appearance); widget.setDefaultAppearance(appearance);
  return [...rotateInPlace({ ...rectangle, rotation }), ...drawTextField({ x: border / 2, y: border / 2,
    width: width - border, height: height - border, borderWidth: border, borderColor: undefined, color: undefined,
    textLines, textColor: rgb(0.05, 0.05, 0.05), font: font.name, fontSize: size, padding })];
};
