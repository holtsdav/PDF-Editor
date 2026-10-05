import { App, Modal, TFile, loadPdfJs } from 'obsidian';
import { asPdfLibrary, inspectDocument } from '../pdf/inspect';
import type { PdfLoadingTask } from '../pdf/inspect';

export class PdfInspectionModal extends Modal {
  private file: TFile;
  private task?: PdfLoadingTask;
  private closed = false;

  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }

  onOpen(): void {
    this.closed = false;
    this.setTitle('PDF form inspection');
    this.contentEl.createEl('p', { text: `Inspecting ${this.file.path}…` });
    void this.inspect().catch(error => {
      if (!this.closed) {
        this.contentEl.empty();
        this.contentEl.createEl('p', {
          text: `Could not inspect this PDF: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });
  }

  private async inspect(): Promise<void> {
    const [bytes, rawLibrary] = await Promise.all([this.app.vault.readBinary(this.file), loadPdfJs()]);
    if (this.closed) return;
    const library = asPdfLibrary(rawLibrary as unknown);
    const task = library.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false });
    this.task = task;
    try {
      const inspection = await inspectDocument(await task.promise);
      if (this.closed) return;
      const el = this.contentEl;
      el.empty();
      el.createEl('p', { text: this.file.path, cls: 'pdf-form-studio-file' });
      el.createEl('p', { text: `${inspection.pages} pages · ${inspection.fields.length} discovered fields · PDF.js ${library.version ?? 'unknown'}` });
      el.createEl('p', {
        text: inspection.fields.length > 0
          ? 'This PDF contains field data or widgets. The inline form editor is planned.'
          : inspection.scannedPages < inspection.pages || inspection.hasXfa || inspection.hasAcroForm
            ? 'No fields were discovered in this inspection. Further inspection is needed before choosing an editing mode.'
            : 'No interactive fields were discovered. Typing on printed lines will need text annotations or newly added form fields.'
      });
      if (inspection.fields.length > 0) {
        const list = el.createEl('ul', { cls: 'pdf-form-studio-fields' });
        for (const field of inspection.fields) {
          const pages = field.pages.length ? `pages ${field.pages.join(', ')}` : 'no visible widget found in scanned pages';
          list.createEl('li', { text: `${field.name} (${field.type}; ${pages}${field.readOnly ? '; read only' : ''})` });
        }
      }
      for (const warning of inspection.warnings) el.createEl('p', { text: warning });
      el.createEl('p', { text: 'Inspection leaves the PDF unchanged.' });
    } finally {
      if (this.task === task) {
        this.task = undefined;
        await task.destroy();
      }
    }
  }

  onClose(): void {
    this.closed = true;
    const task = this.task;
    this.task = undefined;
    if (task) void task.destroy().catch(() => { /* Already destroyed by PDF.js. */ });
    this.contentEl.empty();
  }
}
