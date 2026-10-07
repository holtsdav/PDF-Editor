import { FuzzySuggestModal, Modal, Notice, Plugin, TFile } from 'obsidian';
import { PdfInspectionModal } from './ui/pdf-inspection-modal';
import { findNativePdfs, watchNativePdfs } from './compat/native-pdf';
import { PdfSurface } from './ui/pdf-surface';
import { VaultSessions } from './pdf/vault-sessions';
import { isRecoveryPath, loadBackups } from './pdf/recovery';
import { loadToolPreferences } from './pdf/tool-preferences';
import { PdfSettingsTab } from './ui/plugin-settings';
import type { BackupRecord } from './pdf/recovery';
import fontBytes from '../assets/fonts/NotoSans-Regular.ttf';
import serifBytes from '../assets/fonts/NotoSerif-Regular.ttf';
import monoBytes from '../assets/fonts/NotoSansMono-Regular.ttf';

class PdfPicker extends FuzzySuggestModal<TFile> {
  private choose: (file: TFile) => void;

  constructor(plugin: Plugin, choose: (file: TFile) => void, placeholder = 'Choose a PDF to inspect') {
    super(plugin.app);
    this.choose = choose;
    this.setPlaceholder(placeholder);
  }

  getItems(): TFile[] { return this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === 'pdf'); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

export default class PdfEditor extends Plugin {
  private modals = new Set<Modal>();
  private editors = new Map<object, PdfSurface>();
  private recentEditors = new Map<object, { file: TFile; state: ReturnType<PdfSurface['captureState']>; until: number }>();
  private sessions!: VaultSessions;
  private backups: Record<string, BackupRecord> = {};
  private preferences = loadToolPreferences(null);
  private persistence: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    const saved: unknown = await this.loadData();
    if (saved && typeof saved === 'object' && 'backups' in saved && saved.backups && typeof saved.backups === 'object') {
      this.backups = loadBackups(saved.backups, `${this.app.vault.configDir}/plugins/pdf-form-studio/recovery`);
    }
    if (saved && typeof saved === 'object' && 'preferences' in saved) this.preferences = loadToolPreferences(saved.preferences);
    this.sessions = new VaultSessions(this.app, { sans: fontBytes, serif: serifBytes, mono: monoBytes }, this.backups, () => {
      const snapshot = { preferences: structuredClone(this.preferences), backups: Object.fromEntries(Object.entries(this.backups).map(([source, record]) => [source, { ...record }])) };
      this.persistence = this.persistence.catch(() => {}).then(() => this.saveData(snapshot));
      return this.persistence;
    }, this.preferences);
    await this.sessions.initialize();
    this.addSettingTab(new PdfSettingsTab(this.app, this, this.sessions));
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
      id: 'export-pending-pdf-recovery',
      name: 'Export pending PDF recovery draft',
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        if (active?.extension.toLowerCase() === 'pdf') void this.exportPendingDraft(active);
        else this.openModal(new PdfPicker(this, file => { void this.exportPendingDraft(file); }, 'Choose a PDF with a pending recovery draft'));
      }
    });
    const scan = () => this.scanEditors();
    this.register(watchNativePdfs(this.app, scan));
    this.app.workspace.onLayoutReady(scan);
    this.registerInterval(window.setInterval(scan, 500));
    this.registerEvent(this.app.workspace.on('layout-change', scan));
    this.registerEvent(this.app.workspace.on('file-open', scan));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') void this.sessions.modified(file).catch(error => new Notice(String(error)));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.sessions.renamed(file, oldPath).catch(error => new Notice(String(error))); }));
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
      let replacingSameFile = false;
      const recent = this.recentEditors.get(viewer.identity);
      if (recent?.file === viewer.file) { state = recent.state; replacingSameFile = true; }
      this.recentEditors.delete(viewer.identity);
      if (editor && !editor.matches(viewer)) {
        replacingSameFile = editor.file === viewer.file;
        state = editor.captureState(viewer); this.removeChild(editor); editor = undefined;
      }
      if (!editor) {
        // A native host may be rebuilt after a save. Its replacement is still
        // the same PDF opening, so do not launch another automatic scan.
        editor = this.addChild(new PdfSurface(this.app, viewer, this.sessions, state, !replacingSameFile));
        this.editors.set(viewer.identity, editor);
      }
      editor.refresh();
    }
  }

  private inspect(file: TFile): void { this.openModal(new PdfInspectionModal(this.app, file)); }

  private async exportPendingDraft(file: TFile): Promise<void> {
    try {
      const exported = await this.sessions.exportPendingDraft(file);
      new Notice(`Recovered PDF exported as ${exported.path}. The source PDF was not replaced.`);
    } catch (error) { new Notice(`Could not export recovery draft: ${String(error)}`); }
  }

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
