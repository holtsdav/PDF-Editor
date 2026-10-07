import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { PdfSettingsTab as SettingsTab } from '../src/ui/plugin-settings.ts';
import type { App, Plugin } from 'obsidian';
import type { VaultSessions } from '../src/pdf/vault-sessions.ts';

const built = await build({ entryPoints: ['src/ui/plugin-settings.ts'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'settings-host', setup(builder) {
  builder.onResolve({ filter: /^(obsidian|electron)$/ }, args => ({ path: args.path, namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'electron' ? 'export const shell = {};' : `
    export class PluginSettingTab { constructor(app) { this.app = app; } hide() {} }
    export class Modal {
      constructor(app) { this.app = app; this.contentEl = app.doc.createElement('div'); }
      setTitle() {}
      open() { this.app.doc.body.append(this.contentEl); }
      close() { this.contentEl.remove(); this.onClose?.(); }
    }
    export class Notice {}
    export class Setting {}
    export class FileSystemAdapter {}
  ` }));
} }] });
const moduleUrl = new URL('../tmp/ui-tests/settings-lifecycle.mjs', import.meta.url);
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true });
await writeFile(moduleUrl, built.outputFiles[0]!.text);
const { PdfSettingsTab } = await import(moduleUrl.href) as { PdfSettingsTab: typeof SettingsTab };

test('an open backup-deletion confirmation cannot act after the plugin unloads', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const doc = dom.window.document;
    Object.assign(dom.window.HTMLElement.prototype, { createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string }) {
      const element = doc.createElement(tag); element.textContent = options.text ?? ''; element.className = options.cls ?? ''; this.append(element); return element;
    } });
    let unload!: () => void, deletions = 0;
    const plugin = { register(callback: () => void) { unload = callback; } } as unknown as Plugin;
    const sessions = { clearRecoveryStorage: async () => { deletions++; } } as unknown as VaultSessions;
    const tab = new PdfSettingsTab({ doc } as unknown as App, plugin, sessions) as unknown as { confirmClearRecovery(): void };
    tab.confirmClearRecovery();
    const button = doc.querySelector<HTMLButtonElement>('.mod-warning')!;
    assert(button.isConnected);
    unload();
    assert.equal(button.isConnected, false);
    button.click();
    assert.equal(deletions, 0);
  } finally { dom.window.close(); }
});
