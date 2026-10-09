import { PDFDocument, PDFName, PDFString, StandardFonts, TextAlignment, degrees, rgb } from 'pdf-lib';

export const prefixBlank = 'pdf-form-studio-external-blank';
export const prefixValue = 'pdf-form-studio-external-value';
export const uuidCollision = 'pdf-form-studio-00000000-0000-4000-8000-000000000001';
export const legacyBlank = 'pdf-form-studio-00000000-0000-4000-8000-000000000002';

/** Anonymous authored form; no user documents or answers. */
export async function authoredForms(rotation = 0): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]);
  page.setRotation(degrees(rotation));
  page.drawText('Anonymous existing form regression', { x: 30, y: 760, size: 16 });
  const times = await pdf.embedFont(StandardFonts.TimesRoman), courier = await pdf.embedFont(StandardFonts.Courier);
  const form = pdf.getForm();
  const names = ['Blank', 'Prefilled', prefixBlank, prefixValue, uuidCollision, legacyBlank, 'Multiline', 'Readonly'];
  for (const [index, name] of names.entries()) {
    const field = form.createTextField(name);
    field.setText(name === 'Prefilled' || name === prefixValue ? 'Original answer' : name === 'Multiline' ? 'First row\nSecond row' : name === 'Readonly' ? 'Read only answer' : '');
    if (name === 'Multiline') field.enableMultiline();
    field.addToPage(page, { x: 50, y: 660 - index * 65, width: 300, height: name === 'Multiline' ? 50 : 32,
      borderWidth: name === legacyBlank ? 0 : 2, borderColor: name === legacyBlank ? undefined : rgb(0.2, 0.3, 0.6),
      backgroundColor: name === legacyBlank ? undefined : rgb(0.9, 0.95, 1), textColor: rgb(0.3, 0.1, 0.2), font: name === 'Multiline' ? courier : times });
    field.setFontSize(16);
    if (name === 'Prefilled') { field.setAlignment(TextAlignment.Right); field.setMaxLength(40); field.enableRequired(); field.disableScrolling(); }
    if (name === 'Readonly') field.enableReadOnly();
    if (name === legacyBlank) field.acroField.dict.set(PDFName.of('PFSFont'), PDFName.of('serif'));
    field.updateAppearances(name === 'Multiline' ? courier : times);
  }
  const checkbox = form.createCheckBox('Check'); checkbox.addToPage(page, { x: 450, y: 650, width: 20, height: 20 }); checkbox.check();
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [400, 450, 550, 500],
    Contents: PDFString.of('Foreign annotation'), DA: PDFString.of('/Helv 12 Tf 0 g'), NM: PDFString.of('foreign-note'), F: 4 })));
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [400, 550, 550, 580], Dest: [page.ref, PDFName.of('Fit')] })));
  return pdf.save({ updateFieldAppearances: false });
}
