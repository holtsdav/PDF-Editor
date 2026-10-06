import { FileSystemAdapter, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import { shell } from 'electron';
import type { App, Plugin } from 'obsidian';
import type { VaultSessions } from '../pdf/vault-sessions';
import { MAX_AUTO_DETECT_PAGES, MAX_TOOLBAR_TOP_OFFSET } from '../pdf/tool-preferences';

export class PdfSettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private sessions: VaultSessions) { super(app, plugin); }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    new Setting(containerEl).setName('PDF toolbar top offset').setDesc('Move the PDF header and tools down if another plugin uses the top of the view. 0 px keeps the default position.').addSlider(slider => slider
      .setLimits(0, MAX_TOOLBAR_TOP_OFFSET, 1)
      .setValue(this.sessions.preferences.toolbarTopOffset)
      .setDynamicTooltip()
      .onChange(async value => {
        try { await this.sessions.updatePreferences({ ...this.sessions.preferences, toolbarTopOffset: value }); }
        catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
      }));
    new Setting(containerEl).setName('Answer lines').setHeading();
    this.toggle('autoDetectLines', 'Detect answer lines on PDF open', 'Scan a PDF once when it opens, up to the page limit below. Larger PDFs can still be scanned manually. No fields are added until you click a suggestion.');
    new Setting(containerEl).setName('Automatic detection page limit').setDesc('Skip automatic line detection when a PDF has more pages than this. The toolbar button can still scan all pages manually.').addSlider(slider => slider
      .setLimits(1, MAX_AUTO_DETECT_PAGES, 1)
      .setValue(this.sessions.preferences.autoDetectPageLimit)
      .setDynamicTooltip()
      .onChange(async value => {
        try { await this.sessions.updatePreferences({ ...this.sessions.preferences, autoDetectPageLimit: value }); }
        catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
      }));
    this.toggle('flowAnswerLines', 'Wrap across consecutive answer lines', 'Treat closely spaced, aligned blank lines as one answer block. Text wraps along the printed rules. Applies to new answers; existing answers stay as they are.');
    new Setting(containerEl).setName('PDF backups and recovery').setHeading();
    const usage = new Setting(containerEl).setName('Backup copies')
      .setDesc('When you first save edits to a PDF, PDF Editor keeps its untouched original here. It also keeps a temporary draft while edits are unsaved. Drafts go away after saving. Originals stay until you delete them, so this folder can grow.');
    const usageText = containerEl.createEl('p', { text: 'Calculating recovery storage…' });
    void this.sessions.recoveryUsage().then(value => {
      if (usageText.isConnected) usageText.textContent = `Using ${this.formatBytes(value.bytes)} in ${value.files} ${value.files === 1 ? 'file' : 'files'} for ${value.indexedPdfs} ${value.indexedPdfs === 1 ? 'PDF' : 'PDFs'} with backups.`;
    }).catch(error => { if (usageText.isConnected) usageText.textContent = `Could not read recovery storage: ${String(error)}`; });
    usage.addButton(button => button.setButtonText('Open folder').onClick(() => {
      void this.openRecoveryFolder().catch(error => new Notice(`Could not open recovery folder: ${String(error)}`));
    }));
    new Setting(containerEl).setName('Delete backup copies')
      .setDesc('Free this space without deleting your PDFs. Close PDF Editor views and save or resolve unsaved edits first. After deletion, you cannot restore earlier originals. The next save makes a new backup from the PDF as it is then.')
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
    modal.setTitle('Delete all PDF backup copies?');
    modal.contentEl.createEl('p', { text: 'Your PDFs will stay in your vault. This permanently deletes the copies PDF Editor kept so you could restore their earlier versions. You cannot undo this. Close every PDF Editor view and save or resolve pending edits first.' });
    modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    modal.contentEl.createEl('button', { text: 'Delete backup copies', cls: 'mod-warning' }).addEventListener('click', () => {
      void this.sessions.clearRecoveryStorage().then(() => { modal.close(); new Notice('PDF backup copies deleted.'); this.display(); })
        .catch(error => new Notice(`Could not delete backup copies: ${String(error)}`));
    });
    modal.open();
  }

  private toggle(key: 'autoDetectLines' | 'flowAnswerLines', name: string, description: string): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle(toggle => toggle.setValue(this.sessions.preferences[key]).onChange(async value => {
      try { await this.sessions.updatePreferences({ ...this.sessions.preferences, [key]: value }); }
      catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
    }));
  }
}
