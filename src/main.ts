import { FuzzySuggestModal, Modal, Plugin, TFile } from 'obsidian';
import { PdfInspectionModal } from './ui/pdf-inspection-modal';
import { PenDiagnosticsModal } from './ui/pen-diagnostics-modal';

class PdfPicker extends FuzzySuggestModal<TFile> {
  private choose: (file: TFile) => void;

  constructor(plugin: Plugin, choose: (file: TFile) => void) {
    super(plugin.app);
    this.choose = choose;
    this.setPlaceholder('Choose a PDF to inspect');
  }

  getItems(): TFile[] { return this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === 'pdf'); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

export default class PdfFormStudio extends Plugin {
  private modals = new Set<Modal>();

  onload(): void {
    this.addCommand({
      id: 'inspect-pdf-form-fields',
      name: 'Inspect PDF form fields',
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        if (active?.extension.toLowerCase() === 'pdf') this.inspect(active);
        else this.openModal(new PdfPicker(this, file => this.inspect(file)));
      }
    });
    this.addCommand({
      id: 'test-pen-input',
      name: 'Test pen input',
      callback: () => this.openModal(new PenDiagnosticsModal(this.app))
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') return;
      menu.addItem(item => item.setTitle('Inspect PDF form fields').setIcon('file-search').onClick(() => this.inspect(file)));
    }));
  }

  private inspect(file: TFile): void { this.openModal(new PdfInspectionModal(this.app, file)); }

  private openModal(modal: Modal): void {
    this.modals.add(modal);
    const originalClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      this.modals.delete(modal);
      originalClose();
    };
    modal.open();
  }

  onunload(): void {
    for (const modal of [...this.modals]) modal.close();
    this.modals.clear();
  }
}
