import { FileSystemAdapter, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import { shell } from 'electron';
import type { App, Plugin } from 'obsidian';
import type { VaultSessions } from '../pdf/vault-sessions';
import { MAX_AUTO_DETECT_PAGES, MAX_TOOLBAR_TOP_OFFSET } from '../pdf/tool-preferences';

export class PdfSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private sessions: VaultSessions) { super(app, plugin); }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    new Setting(containerEl).setName('PDF toolbar top offset').setDesc('Move the PDF toolbar down. When it floats, the space above it covers the PDF.').addSlider(slider => slider
      .setLimits(0, MAX_TOOLBAR_TOP_OFFSET, 1)
      .setValue(this.sessions.preferences.toolbarTopOffset)
      .setDynamicTooltip()
      .onChange(async value => {
        try { await this.sessions.updatePreferences({ ...this.sessions.preferences, toolbarTopOffset: value }); }
        catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
      }));
    this.toggle('floatingToolbar', 'Floating PDF toolbar', 'Keep the PDF controls and editing tools visible at the top of a note while its PDF is on screen. You can also switch this from the PDF options menu.');
    new Setting(containerEl).setName('Answer lines').setHeading();
    this.toggle('autoDetectLines', 'Detect answer lines on PDF open', 'Scan for blank answer lines when a PDF opens. For larger PDFs, use the scan button beside Add text box to scan up to 100 pages at a time.');
    new Setting(containerEl).setName('Automatic detection page limit').setDesc('Only scan automatically when the PDF has this many pages or fewer. Manual scans can cover larger PDFs in 100-page sections.').addSlider(slider => slider
      .setLimits(1, MAX_AUTO_DETECT_PAGES, 1)
      .setValue(this.sessions.preferences.autoDetectPageLimit)
      .setDynamicTooltip()
      .onChange(async value => {
        try { await this.sessions.updatePreferences({ ...this.sessions.preferences, autoDetectPageLimit: value }); }
        catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
      }));
    this.toggle('flowAnswerLines', 'Wrap across consecutive answer lines', 'Nearby aligned lines make one text block. Click a neighboring detected line to extend an existing answer.');
    new Setting(containerEl).setName('PDF backups').setHeading();
    this.toggle('keepOriginalBackups', 'Keep one backup of each PDF you edit', 'While PDF Editor is in beta, it keeps one copy of a PDF as it was before your first saved change. Later edits do not replace that copy. You can restore it from the PDF menu. Turning this off stops new backups; existing backups stay.');
    const usage = new Setting(containerEl).setName('Backup folder')
      .setDesc('Open the folder where backups are stored.');
    const usageText = containerEl.createEl('p', { text: 'Calculating backup storage…' });
    void this.sessions.recoveryUsage().then(value => {
      if (usageText.isConnected) usageText.textContent = `${this.formatBytes(value.bytes)} used · ${value.indexedPdfs} ${value.indexedPdfs === 1 ? 'PDF' : 'PDFs'} backed up`;
    }).catch(error => { if (usageText.isConnected) usageText.textContent = `Could not read recovery storage: ${String(error)}`; });
    usage.addButton(button => button.setButtonText('Open folder').onClick(() => {
      void this.openRecoveryFolder().catch(error => new Notice(`Could not open recovery folder: ${String(error)}`));
    }));
    new Setting(containerEl).setName('Delete backups')
      .setDesc('Delete all backup copies saved by PDF Editor to free space. Your PDFs stay in your vault.')
      .addButton(button => button.setButtonText('Delete backups…').setWarning().onClick(() => this.confirmClearRecovery()));
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
    const modal = new Modal(this.app);
    modal.setTitle('Delete all PDF backups?');
    modal.contentEl.createEl('p', { text: 'This permanently removes the backup copies. Your PDFs stay in your vault. Close open PDF Editor views and save pending changes first.' });
    modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    modal.contentEl.createEl('button', { text: 'Delete backups', cls: 'mod-warning' }).addEventListener('click', () => {
      void this.sessions.clearRecoveryStorage().then(() => { modal.close(); new Notice('PDF backups deleted.'); this.display(); })
        .catch(error => new Notice(`Could not delete backups: ${String(error)}`));
    });
    modal.open();
  }

  private toggle(key: 'floatingToolbar' | 'autoDetectLines' | 'flowAnswerLines' | 'keepOriginalBackups', name: string, description: string): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle(toggle => toggle.setValue(this.sessions.preferences[key]).onChange(async value => {
      try { await this.sessions.updatePreferences({ ...this.sessions.preferences, [key]: value }); }
      catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
    }));
  }
}
