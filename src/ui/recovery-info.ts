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
    this.setTitle('PDF safety copies');
    this.contentEl.createEl('p', { text: `Your current PDF, ${this.file.name}, contains your saved text and drawings. These safety copies are separate; your saved edits do not depend on them.` });
    this.contentEl.createEl('p', { text: this.sessions.backupFor(this.file)
      ? 'Original PDF: one full copy is available from before PDF Editor first saved this file while original copies were enabled. Use Restore original to return the whole PDF to that version. It does not expire.'
      : 'Original PDF: no copy is stored for this file yet. Settings can keep one before the next save. If this PDF was already edited while copies were off, that later copy will contain its current edits.' });
    this.contentEl.createEl('p', { text: 'Before restore: if you restore the original, PDF Editor first keeps a copy of your current PDF so you can reverse that restore.' });
    this.contentEl.createEl('p', { text: 'Temporary draft: unsaved changes may be kept here so they can be recovered after a crash. Drafts are removed after a successful save or when you choose to discard edits.' });
    this.contentEl.createEl('p', { text: 'Older copies from previous versions are also kept. Safety copies may not follow your vault sync settings, so copy this folder separately before removing the plugin.' });
    const location = this.contentEl.createEl('p', { cls: 'pdf-form-studio-file' }); location.createEl('strong', { text: 'Storage: ' }); location.createSpan({ text: this.sessions.root });
    const copies = this.contentEl.createDiv();
    void this.sessions.recoveryDetails(this.file).then(items => {
      if (this.closed) return;
      if (!items.length) copies.createEl('p', { text: 'No safety copies are stored for this PDF.' });
      for (const item of items) {
        const row = copies.createDiv({ cls: 'pfs-recovery-row' });
        const size = item.size < 1024 ? `${item.size} bytes` : item.size < 1024 * 1024 ? `${(item.size / 1024).toFixed(1)} KB` : `${(item.size / 1024 / 1024).toFixed(2)} MB`;
        row.createSpan({ text: `${item.label} · ${size}` });
        if (item.kind) {
          const kind = item.kind;
          const preview = row.createEl('button', { text: 'Preview' });
          preview.onclick = () => { const modal = new RecoveryPreview(this.app, () => this.sessions.readRecovery(this.file, kind)); this.previews.add(modal); modal.open(); };
        }
      }
    }).catch(error => { if (!this.closed) copies.createEl('p', { text: String(error) }); });
  }
  onClose(): void { this.closed = true; for (const preview of this.previews) preview.close(); this.previews.clear(); this.contentEl.empty(); }
}
