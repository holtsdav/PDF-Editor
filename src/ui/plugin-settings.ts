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
    containerEl.createDiv({ cls: 'pfs-safety-heading', text: 'PDF safety copies', attr: { role: 'heading', 'aria-level': '3' } });
    containerEl.createEl('p', { cls: 'pfs-safety-intro', text: 'Beta protection: keep one original PDF so you can restore the whole file later. Your saved edits stay editable if you turn copies off or delete them.' });
    this.toggle('keepOriginalBackups', 'Keep originals for new PDFs', 'Off skips new originals; existing copies stay. Crash recovery for unsaved edits stays on. Turning this back on copies the PDF as it is then.');
    const usage = new Setting(containerEl).setName('Stored copies')
      .setDesc('One original per PDF, not one per edit.');
    const usageText = containerEl.createEl('p', { cls: 'pfs-safety-usage', text: 'Calculating storage…' });
    void this.sessions.recoveryUsage().then(value => {
      if (usageText.isConnected) usageText.textContent = `${this.formatBytes(value.bytes)} · ${value.files} ${value.files === 1 ? 'file' : 'files'} · ${value.indexedPdfs} ${value.indexedPdfs === 1 ? 'PDF' : 'PDFs'} backed up`;
    }).catch(error => { if (usageText.isConnected) usageText.textContent = `Could not read recovery storage: ${String(error)}`; });
    usage.addButton(button => button.setButtonText('Open folder').onClick(() => {
      void this.openRecoveryFolder().catch(error => new Notice(`Could not open recovery folder: ${String(error)}`));
    }));
    new Setting(containerEl).setName('Delete stored copies')
      .setDesc('Removes backups, not your PDFs or saved edits. Close PDF views and save pending edits first.')
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
    modal.contentEl.createEl('p', { text: 'Your PDFs and saved edits stay editable. This permanently removes the earlier versions used by Restore original. Future saves make new originals only while the toggle is on. Close PDF views and save pending edits first.' });
    modal.contentEl.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    modal.contentEl.createEl('button', { text: 'Delete safety copies', cls: 'mod-warning' }).addEventListener('click', () => {
      void this.sessions.clearRecoveryStorage().then(() => { modal.close(); new Notice('PDF safety copies deleted. Your PDFs are unchanged.'); this.display(); })
        .catch(error => new Notice(`Could not delete safety copies: ${String(error)}`));
    });
    modal.open();
  }

  private toggle(key: 'autoDetectLines' | 'flowAnswerLines' | 'keepOriginalBackups', name: string, description: string): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle(toggle => toggle.setValue(this.sessions.preferences[key]).onChange(async value => {
      try { await this.sessions.updatePreferences({ ...this.sessions.preferences, [key]: value }); }
      catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
    }));
  }
}
