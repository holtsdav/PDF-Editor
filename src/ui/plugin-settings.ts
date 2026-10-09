import { ButtonComponent, FileSystemAdapter, Modal, Notice, PluginSettingTab } from 'obsidian';
import { shell } from 'electron';
import type { App, Plugin, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type { VaultSessions } from '../pdf/vault-sessions';
import { MAX_AUTO_DETECT_PAGES, MAX_TOOLBAR_TOP_OFFSET } from '../pdf/tool-preferences';

export class PdfSettingsTab extends PluginSettingTab {
  private confirmModal?: Modal;
  private unloaded = false;
  constructor(app: App, plugin: Plugin, private sessions: VaultSessions) {
    super(app, plugin);
    plugin.register(() => { this.unloaded = true; this.closeConfirmation(); });
  }

  hide(): void { this.closeConfirmation(); super.hide(); }

  private closeConfirmation(): void { this.confirmModal?.close(); this.confirmModal = undefined; }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Definitions are also requested for search indexing. Read storage only
    // while rendering, and keep saves routed through the shared preferences.
    return [
      this.slider('toolbarTopOffset', 'PDF toolbar top offset', 'Move the PDF toolbar down. When it floats, the space above it covers the PDF.', 0, MAX_TOOLBAR_TOP_OFFSET),
      this.toggle('floatingToolbar', 'Floating PDF toolbar', 'Keep the PDF controls and editing tools visible at the top of a note while its PDF is on screen. You can also switch this from the PDF options menu.'),
      { type: 'group', heading: 'Answer lines', items: [
        this.toggle('autoDetectLines', 'Detect answer lines on PDF open', 'Scan for blank answer lines when a PDF opens. For larger PDFs, use the scan button beside Add text box to scan up to 100 pages at a time.'),
        this.slider('autoDetectPageLimit', 'Automatic detection page limit', 'Only scan automatically when the PDF has this many pages or fewer. Manual scans can cover larger PDFs in 100-page sections.', 1, MAX_AUTO_DETECT_PAGES),
        this.toggle('flowAnswerLines', 'Wrap across consecutive answer lines', 'Nearby aligned lines make one text block. Click a neighboring detected line to extend an existing answer.')
      ] },
      { type: 'group', heading: 'PDF backups', items: [
        this.toggle('keepOriginalBackups', 'Keep one backup of each PDF you edit', 'While PDF Editor is in beta, it keeps one copy of a PDF as it was before your first saved change. Later edits do not replace that copy. You can restore it from the PDF menu. Turning this off stops new backups; existing backups stay.'),
        { name: 'Backup folder', desc: 'Open the folder where backups are stored.', aliases: ['recovery storage'], render: setting => {
          let active = true;
          const usageText = setting.descEl.createEl('p', { text: 'Calculating backup storage…' });
          void this.sessions.recoveryUsage().then(value => {
            if (active && !this.unloaded && usageText.isConnected) usageText.textContent = `${this.formatBytes(value.bytes)} used · ${value.indexedPdfs} ${value.indexedPdfs === 1 ? 'PDF' : 'PDFs'} backed up`;
          }).catch(error => { if (active && !this.unloaded && usageText.isConnected) usageText.textContent = `Could not read recovery storage: ${String(error)}`; });
          setting.addButton(button => button.setButtonText('Open folder').onClick(() => {
            if (!this.unloaded) void this.openRecoveryFolder().catch(error => { if (!this.unloaded) new Notice(`Could not open recovery folder: ${String(error)}`); });
          }));
          return () => { active = false; };
        } },
        { name: 'Delete backups', desc: 'Delete all backup copies saved by PDF Editor to free space. Your PDFs stay in your vault.', render: setting => {
          setting.addButton(button => button.setButtonText('Delete backups…').setDestructive().onClick(() => this.confirmClearRecovery()));
        } }
      ] }
    ];
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const unit = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit] ?? 'PiB'}`;
  }

  private async openRecoveryFolder(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('Opening the recovery folder requires the desktop file system.');
    const error = await shell.openPath(`${adapter.getBasePath()}/${this.sessions.root}`);
    if (error) throw new Error(error);
  }

  private confirmClearRecovery(): void {
    if (this.unloaded) return;
    this.closeConfirmation();
    const modal = new Modal(this.app);
    this.confirmModal = modal;
    modal.onClose = () => { if (this.confirmModal === modal) this.confirmModal = undefined; };
    modal.setTitle('Delete all PDF backups?');
    modal.contentEl.createEl('p', { text: 'This permanently removes the backup copies. Your PDFs stay in your vault. Close open PDF Editor views and save pending changes first.' });
    modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    let deleting = false;
    const deleteButton = new ButtonComponent(modal.contentEl).setButtonText('Delete backups').setDestructive().onClick(() => {
      if (this.unloaded || this.confirmModal !== modal || deleting) return;
      deleting = true; deleteButton.setDisabled(true);
      void this.sessions.clearRecoveryStorage().then(() => { modal.close(); if (!this.unloaded) { new Notice('PDF backups deleted.'); this.update(); } })
        .catch(error => {
          if (!this.unloaded) new Notice(`Could not delete backups: ${String(error)}`);
          if (!this.unloaded && this.confirmModal === modal) { deleting = false; deleteButton.setDisabled(false); }
        });
    });
    modal.open();
  }

  private toggle(key: 'floatingToolbar' | 'autoDetectLines' | 'flowAnswerLines' | 'keepOriginalBackups', name: string, desc: string): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addToggle(toggle => toggle.setValue(this.sessions.preferences[key]).onChange(value => this.savePreference(key, value)));
    } };
  }

  private slider(key: 'toolbarTopOffset' | 'autoDetectPageLimit', name: string, desc: string, min: number, max: number): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addSlider(slider => slider.setLimits(min, max, 1).setValue(this.sessions.preferences[key]).onChange(value => this.savePreference(key, value)));
    } };
  }

  private async savePreference(key: 'floatingToolbar' | 'autoDetectLines' | 'flowAnswerLines' | 'keepOriginalBackups' | 'toolbarTopOffset' | 'autoDetectPageLimit', value: boolean | number): Promise<void> {
    if (this.unloaded) return;
    try { await this.sessions.updatePreferences({ ...this.sessions.preferences, [key]: value }); }
    catch (error) { if (!this.unloaded) new Notice(`Could not save settings: ${String(error)}`); }
  }
}
