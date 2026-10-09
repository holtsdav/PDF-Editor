import { PDFDocument, PDFDict, PDFName, PDFString, degrees } from 'pdf-lib';

/** Anonymous merged field/widgets with no appearances, as found in page-only forms. */
export async function orphanForms(tree: 'absent' | 'missing' | 'empty' | 'partial' = 'absent', rotation = 0): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 800]); page.setRotation(degrees(rotation));
  page.drawText('Anonymous orphan form regression', { x: 30, y: 760, size: 16 });
  if (tree === 'partial') {
    const canonical = pdf.getForm().createTextField('Canonical');
    canonical.setText('Canonical answer'); canonical.addToPage(page, { x: 350, y: 650, width: 180, height: 30 });
  } else if (tree === 'empty' || tree === 'missing') pdf.getForm();
  const names = ['Orphan blank', 'Orphan prefilled', 'Orphan multiline', 'pdf-form-studio-orphan-collision'];
  for (const [i, name] of names.entries()) {
    page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of(name),
      V: PDFString.of(i === 1 ? 'Original answer' : ''), Ff: i === 2 ? 4096 : 0, F: 4,
      Rect: [50, 660 - i * 80, 320, 700 - i * 80], P: page.ref, DA: PDFString.of('/Helv 12 Tf 0 g'),
      Q: i === 1 ? 2 : 0, MaxLen: i === 1 ? 40 : 100, BS: { W: 1, S: 'S' }, MK: { BC: [0, 0, 0], BG: [1, 1, 1] } })));
  }
  // An unreachable parent field supplies name, value, flags and appearance to two widgets.
  const parent = pdf.context.obj({ FT: 'Tx', T: PDFString.of('Inherited'), V: PDFString.of('Inherited answer'),
    Ff: 4096, DA: PDFString.of('/Helv 15 Tf 0.3 g'), Q: 1, MaxLen: 80 });
  const parentRef = pdf.context.register(parent);
  const kids = [240, 170].map(y => {
    const ref = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', Parent: parentRef, P: page.ref,
      Rect: [50, y, 320, y + 50], F: 4, BS: { W: 2 }, MK: { BC: [0.1, 0.2, 0.3], BG: [1, 1, 1] } }));
    page.node.addAnnot(ref); return ref;
  });
  parent.set(PDFName.of('Kids'), pdf.context.obj(kids));
  // Orphan controls with original appearances must remain read only and intact.
  for (const name of ['Readonly', 'Password', 'Hidden', 'Locked']) {
    const field = pdf.getForm().createTextField(name); field.setText('Preserved answer');
    field.addToPage(page, { x: 350, y: 550 - ['Readonly', 'Password', 'Hidden', 'Locked'].indexOf(name) * 60, width: 180, height: 30 });
    if (name === 'Readonly') field.enableReadOnly();
    if (name === 'Password') field.enablePassword();
    if (name === 'Hidden' || name === 'Locked') field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), pdf.context.obj(name === 'Hidden' ? 2 : 128));
    pdf.getForm().acroForm.removeField(field.acroField);
  }
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('Unsupported button'),
    Rect: [400, 180, 430, 210], P: page.ref, F: 4 })));
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [400, 100, 550, 130],
    A: { S: 'URI', URI: PDFString.of('https://example.com') } })));
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [400, 50, 550, 80],
    Contents: PDFString.of('Foreign note'), DA: PDFString.of('/Helv 12 Tf 0 g') })));
  if (tree === 'absent') pdf.catalog.delete(PDFName.of('AcroForm'));
  else if (tree === 'missing') pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict).delete(PDFName.of('Fields'));
  return pdf.save({ updateFieldAppearances: false });
}
