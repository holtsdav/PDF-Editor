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
    new Setting(containerEl).setName('PDF safety copies').setHeading();
    containerEl.createEl('p', { text: 'Your saved text and drawings live inside your normal PDF. They stay editable if you delete safety copies. These copies are only for restoring an earlier whole PDF or recovering unsaved work. Regular Undo is separate and lasts only for the current editing session.' });
    const usage = new Setting(containerEl).setName('Original PDF backup (one per PDF)')
      .setDesc('Before your first save, PDF Editor keeps the whole PDF as it was before editing. This is a safety net if a save damages the file or you want to start over. Deleting an added text box cannot repair a damaged PDF. There is no new backup for each save, line, or character.');
    new Setting(containerEl).setName('Temporary recovery draft')
      .setDesc('While you have unsaved changes, PDF Editor may keep a temporary draft to help recover them after a crash. A successful save removes the draft.');
    const usageText = containerEl.createEl('p', { text: 'Calculating recovery storage…' });
    void this.sessions.recoveryUsage().then(value => {
      if (usageText.isConnected) usageText.textContent = `Safety copies use ${this.formatBytes(value.bytes)} in ${value.files} ${value.files === 1 ? 'file' : 'files'}. ${value.indexedPdfs} ${value.indexedPdfs === 1 ? 'PDF has' : 'PDFs have'} an original copy.`;
    }).catch(error => { if (usageText.isConnected) usageText.textContent = `Could not read recovery storage: ${String(error)}`; });
    usage.addButton(button => button.setButtonText('Open folder').onClick(() => {
      void this.openRecoveryFolder().catch(error => new Notice(`Could not open recovery folder: ${String(error)}`));
    }));
    new Setting(containerEl).setName('Delete safety copies')
      .setDesc('Free this space without changing your PDFs, saved text, or drawings. You will lose the option to restore their earlier starting versions. Close PDF Editor views and save or resolve unsaved edits first. The next save makes a new original copy from the PDF as it is then.')
      .addButton(button => button.setButtonText('Delete copies…').setWarning().onClick(() => this.confirmClearRecovery()));
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
    modal.setTitle('Delete all PDF safety copies?');
    modal.contentEl.createEl('p', { text: 'Your current PDFs, saved text, and drawings will stay exactly as they are and remain editable. This permanently removes the copies used to restore earlier whole-PDF versions. You cannot undo this deletion. Close every PDF Editor view and save or resolve unsaved edits first.' });
    modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    modal.contentEl.createEl('button', { text: 'Delete safety copies', cls: 'mod-warning' }).addEventListener('click', () => {
      void this.sessions.clearRecoveryStorage().then(() => { modal.close(); new Notice('PDF safety copies deleted. Your PDFs are unchanged.'); this.display(); })
        .catch(error => new Notice(`Could not delete safety copies: ${String(error)}`));
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
