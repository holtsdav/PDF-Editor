import { PDFDocument, PDFName, PDFStream, PDFString, StandardFonts } from 'pdf-lib';
import { FIELD_PREFIX } from '../../src/pdf/text-engine.ts';

export const ownedName = FIELD_PREFIX + '22222222-2222-4222-8222-222222222222';

/** Anonymous Preview-style rewrite retaining an obsolete object stream whose IDs collide with active objects. */
export async function previewForms() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const courier = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('Anonymous document content', { x: 30, y: 740, size: 16, font: helvetica });
  const form = pdf.getForm();
  const authored = form.createTextField('Existing form');
  authored.setText('Keep form');
  authored.setAlignment(1);
  authored.addToPage(page, { x: 30, y: 600, width: 180, height: 30 });
  authored.updateAppearances(courier);
  const owned = form.createTextField(ownedName);
  owned.setText('Existing box');
  owned.acroField.dict.set(PDFName.of('PFSKind'), PDFName.of('Text'));
  owned.acroField.dict.set(PDFName.of('PFSFont'), PDFName.of('mono'));
  owned.addToPage(page, { x: 30, y: 540, width: 180, height: 30 });
  owned.setFontSize(14);
  owned.updateAppearances(courier);
  const originalAppearance = owned.acroField.getWidgets()[0]!.getAppearances()!.normal as PDFStream;
  const stray = pdf.context.register(
    pdf.context.flateStream('q 1 0 0 RG 2 w 1 1 78 22 re S Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 80, 24],
      Resources: originalAppearance.dict.get(PDFName.of('Resources'))!,
    }),
  );
  const textAppearance = pdf.context.register(
    pdf.context.flateStream('BT /F0 12 Tf 2 10 Td (Preview text) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 130, 30],
      Resources: { Font: { F0: helvetica.ref } },
    }),
  );
  const square = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [250, 540, 330, 570],
      C: [1, 0, 0],
      F: 4,
      NM: PDFString.of('preview-square'),
      AP: { N: stray },
      BS: { W: 2, S: 'S' },
    }),
  );
  const text = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [250, 600, 380, 630],
      Contents: PDFString.of('Preview text'),
      DA: PDFString.of('/Helv 12 Tf 0 g'),
      F: 4,
      NM: PDFString.of('preview-text'),
      AP: { N: textAppearance },
    }),
  );
  page.node.addAnnot(square);
  page.node.addAnnot(text);
  const link = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [30, 690, 100, 720],
      A: { S: 'URI', URI: PDFString.of('https://example.com') },
    }),
  );
  page.node.addAnnot(link);
  const legacyPages = pdf.context.register(
    pdf.context.obj({ Type: 'Pages', Count: 1, Kids: [page.ref] }),
  );
  const legacyCatalog = pdf.catalog.clone();
  legacyCatalog.set(PDFName.of('Pages'), legacyPages);
  const legacyForm = form.acroForm.dict.clone();
  legacyForm.set(PDFName.of('Fields'), pdf.context.obj([authored.ref, stray]));
  const objects = [
    [pdf.context.trailerInfo.Root!, legacyCatalog],
    [pdf.context.getObjectRef(form.acroForm.dict)!, legacyForm],
  ] as const;
  let body = '';
  const entries: string[] = [];
  for (const [ref, object] of objects) {
    entries.push(`${(ref as import('pdf-lib').PDFRef).objectNumber} ${body.length}`);
    body += object.toString() + '\n';
  }
  const header = entries.join(' ') + ' ';
  const obsolete = pdf.context.register(
    pdf.context.flateStream(header + body, {
      Type: 'ObjStm',
      N: objects.length,
      First: header.length,
    }),
  );
  const bytes = await pdf.save({ updateFieldAppearances: false, useObjectStreams: false });
  return { bytes, stray, obsolete, courier: courier.ref, foreign: [square, text, link] };
}
