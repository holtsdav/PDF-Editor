import { FuzzySuggestModal, Modal, Notice, Plugin, TFile } from 'obsidian';
import { PdfInspectionModal } from './ui/pdf-inspection-modal';
import { findNativePdfs } from './compat/native-pdf';
import { TextEditor } from './ui/text-editor';
import { VaultSessions } from './pdf/vault-sessions';
import { isRecoveryPath, loadBackups } from './pdf/recovery';
import type { BackupRecord } from './pdf/recovery';
import fontBytes from '../assets/fonts/NotoSans-Regular.ttf';
import serifBytes from '../assets/fonts/NotoSerif-Regular.ttf';
import monoBytes from '../assets/fonts/NotoSansMono-Regular.ttf';

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
  private editors = new Map<object, TextEditor>();
  private recentEditors = new Map<object, { file: TFile; state: ReturnType<TextEditor['captureState']>; until: number }>();
  private sessions!: VaultSessions;
  private backups: Record<string, BackupRecord> = {};
  private persistence: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    if (saved && typeof saved === 'object' && 'backups' in saved && saved.backups && typeof saved.backups === 'object') {
      this.backups = loadBackups(saved.backups, `${this.app.vault.configDir}/plugins/pdf-form-studio/recovery`);
    }
    this.sessions = new VaultSessions(this.app, { sans: fontBytes, serif: serifBytes, mono: monoBytes }, this.backups, () => {
      const snapshot = { backups: Object.fromEntries(Object.entries(this.backups).map(([source, record]) => [source, { ...record }])) };
      this.persistence = this.persistence.catch(() => {}).then(() => this.saveData(snapshot));
      return this.persistence;
    });
    await this.sessions.initialize();
    this.addCommand({
      id: 'inspect-pdf-form-fields',
      name: 'Inspect PDF form fields',
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        if (active?.extension.toLowerCase() === 'pdf') this.inspect(active);
        else this.openModal(new PdfPicker(this, file => this.inspect(file)));
      }
    });
    const scan = () => this.scanEditors();
    this.app.workspace.onLayoutReady(scan);
    this.registerInterval(window.setInterval(scan, 500));
    this.registerEvent(this.app.workspace.on('layout-change', scan));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') void this.sessions.modified(file).catch(error => new Notice(String(error)));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) this.sessions.renamed(file, oldPath); }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') return;
      menu.addItem(item => item.setTitle('Inspect PDF form fields').setIcon('file-search').onClick(() => this.inspect(file)));
    }));
  }

  private scanEditors(): void {
    const viewers = findNativePdfs(this.app).filter(viewer => !isRecoveryPath(viewer.file.path, this.sessions.root));
    const alive = new Set(viewers.map(viewer => viewer.identity));
    for (const [identity, recent] of this.recentEditors) if (recent.until < Date.now()) this.recentEditors.delete(identity);
    for (const [identity, editor] of this.editors) {
      if (!alive.has(identity)) {
        this.recentEditors.set(identity, { file: editor.file, state: editor.captureState(), until: Date.now() + 5000 });
        this.removeChild(editor); this.editors.delete(identity);
      }
    }
    for (const viewer of viewers) {
      let editor = this.editors.get(viewer.identity);
      let state;
      const recent = this.recentEditors.get(viewer.identity);
      if (recent?.file === viewer.file) state = recent.state;
      this.recentEditors.delete(viewer.identity);
      if (editor && !editor.matches(viewer)) {
        state = editor.captureState(viewer); this.removeChild(editor); editor = undefined;
      }
      if (!editor) {
        editor = this.addChild(new TextEditor(this.app, viewer, this.sessions, state));
        this.editors.set(viewer.identity, editor);
      }
      editor.refresh();
    }
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
    void this.sessions?.flush();
    this.editors.clear();
    this.recentEditors.clear();
  }
}
