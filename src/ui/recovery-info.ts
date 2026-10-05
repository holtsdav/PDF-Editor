import { Modal } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { VaultSessions } from '../pdf/vault-sessions';
import { RecoveryPreview } from './recovery-preview';

/** Recovery is visible and explained without making retention destructive. */
export class RecoveryInfo extends Modal {
  private closed = false;
  private previews = new Set<RecoveryPreview>();
  constructor(app: App, private sessions: VaultSessions, private file: TFile) { super(app); }
  onOpen(): void {
    this.setTitle('Recovery copies');
    this.contentEl.createEl('p', { text: `Recovery for ${this.file.name}. Your working PDF stays in its normal vault location.` });
    this.contentEl.createEl('p', { text: 'One original is kept from before the first edit. It does not expire. Restoring keeps a “before restore” copy so you can reverse that restore, plus a fallback if the next recovery write is interrupted.' });
    this.contentEl.createEl('p', { text: 'Pending drafts protect edits during a save or crash. The current and previous draft are removed automatically after the PDF is fully saved, or when you choose to discard edits.' });
    this.contentEl.createEl('p', { text: 'Older migrated backups are retained. Recovery storage may not follow your vault sync settings. Keep a separate copy before removing the plugin.' });
    const location = this.contentEl.createEl('p', { cls: 'pdf-form-studio-file' }); location.createEl('strong', { text: 'Storage: ' }); location.createSpan({ text: this.sessions.root });
    const copies = this.contentEl.createDiv();
    void this.sessions.recoveryDetails(this.file).then(items => {
      if (this.closed) return;
      if (!items.length) copies.createEl('p', { text: 'No recovery copies yet. The original is protected before your first PDF save.' });
      for (const item of items) {
        const row = copies.createDiv({ cls: 'pfs-recovery-row' });
        const size = item.size < 1024 ? `${item.size} bytes` : item.size < 1024 * 1024 ? `${(item.size / 1024).toFixed(1)} KB` : `${(item.size / 1024 / 1024).toFixed(2)} MB`;
        row.createSpan({ text: `${item.label} · ${size}` });
        if (item.kind) {
          const preview = row.createEl('button', { text: 'Preview' });
          preview.onclick = () => { const modal = new RecoveryPreview(this.app, () => this.sessions.readRecovery(this.file, item.kind!)); this.previews.add(modal); modal.open(); };
        }
      }
    }).catch(error => { if (!this.closed) copies.createEl('p', { text: String(error) }); });
  }
  onClose(): void { this.closed = true; for (const preview of this.previews) preview.close(); this.previews.clear(); this.contentEl.empty(); }
}
