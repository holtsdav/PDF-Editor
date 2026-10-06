import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type { VaultSessions } from '../pdf/vault-sessions';
import { MAX_TOOLBAR_TOP_OFFSET } from '../pdf/tool-preferences';

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
    this.toggle('autoDetectLines', 'Detect answer lines on PDF open', 'Scan all pages once when a PDF opens in a note or tab. Saving or rebuilding its viewer will not scan again. Large PDFs may take a moment. No fields are added until you click a suggestion.');
    this.toggle('flowAnswerLines', 'Wrap across consecutive answer lines', 'Treat closely spaced, aligned blank lines as one answer block. Text wraps along the printed rules. Applies to new answers; existing answers stay as they are.');
  }

  private toggle(key: 'autoDetectLines' | 'flowAnswerLines', name: string, description: string): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addToggle(toggle => toggle.setValue(this.sessions.preferences[key]).onChange(async value => {
      try { await this.sessions.updatePreferences({ ...this.sessions.preferences, [key]: value }); }
      catch (error) { new Notice(`Could not save settings: ${String(error)}`); }
    }));
  }
}
