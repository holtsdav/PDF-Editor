import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { PdfSettingsTab as SettingsTab } from '../src/ui/plugin-settings.ts';
import type { App, Plugin } from 'obsidian';
import type { VaultSessions } from '../src/pdf/vault-sessions.ts';
import { loadToolPreferences } from '../src/pdf/tool-preferences.ts';

const built = await build({ entryPoints: ['src/ui/plugin-settings.ts'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', plugins: [{ name: 'settings-host', setup(builder) {
  builder.onResolve({ filter: /^(obsidian|electron)$/ }, args => ({ path: args.path, namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'electron' ? 'export const shell = {};' : `
    export class PluginSettingTab {
      updates = 0; cleanups = [];
      constructor(app) { this.app = app; this.containerEl = app.doc.createElement('div'); app.doc.body.append(this.containerEl); }
      hide() { this.cleanups.splice(0).forEach(fn => fn()); this.containerEl.replaceChildren(); }
      update() {
        this.updates++; this.hide(); this.settingItems = this.getSettingDefinitions();
        const render = items => items.forEach(item => {
          if (item.type === 'group') { render(item.items); return; }
          const row = new Setting(this.containerEl); row.name = item.name; row.descEl.textContent = item.desc ?? '';
          const cleanup = item.render?.(row); if (cleanup) this.cleanups.push(cleanup);
          this.app.rows.push(row);
        });
        this.app.rows = []; render(this.settingItems);
      }
    }
    export class Modal {
      constructor(app) { this.app = app; this.contentEl = app.doc.createElement('div'); }
      setTitle() {}
      open() { this.app.doc.body.append(this.contentEl); }
      close() { this.contentEl.remove(); this.onClose?.(); }
    }
    export class Notice { constructor(text) { globalThis.pdfSettingsTestNotices.push(text); } }
    export class ButtonComponent {
      constructor(parent) { this.buttonEl = parent.ownerDocument.createElement('button'); parent.append(this.buttonEl); }
      setButtonText(text) { this.buttonEl.textContent = text; return this; }
      setDestructive() { this.buttonEl.classList.add('mod-destructive'); return this; }
      setDisabled(value) { this.buttonEl.disabled = value; return this; }
      onClick(fn) { this.buttonEl.addEventListener('click', fn); return this; }
    }
    class ValueComponent {
      setValue(value) { this.value = value; return this; }
      setLimits(min, max, step) { this.limits = [min, max, step]; return this; }
      onChange(fn) { this.change = fn; return this; }
    }
    export class Setting {
      constructor(parent) { this.settingEl = parent.ownerDocument.createElement('div'); parent.append(this.settingEl); this.descEl = this.settingEl.ownerDocument.createElement('div'); this.settingEl.append(this.descEl); }
      addButton(fn) { this.button = new ButtonComponent(this.settingEl); fn(this.button); return this; }
      addSlider(fn) { this.slider = new ValueComponent(); fn(this.slider); return this; }
      addToggle(fn) { this.toggle = new ValueComponent(); fn(this.toggle); return this; }
    }
    export class FileSystemAdapter {}
  ` }));
} }] });
const moduleUrl = new URL('../tmp/ui-tests/settings-lifecycle.mjs', import.meta.url);
await mkdir(new URL('../tmp/ui-tests/', import.meta.url), { recursive: true });
await writeFile(moduleUrl, built.outputFiles[0]!.text);
const { PdfSettingsTab } = await import(moduleUrl.href) as { PdfSettingsTab: typeof SettingsTab };
const notices: string[] = [];
Object.assign(globalThis, { pdfSettingsTestNotices: notices });

interface Row { name: string; descEl: HTMLElement; slider?: { value: number; limits: number[]; change(value: number): Promise<void> }; toggle?: { value: boolean; change(value: boolean): Promise<void> }; button?: { buttonEl: HTMLButtonElement } }
function fixture() {
  const dom = new JSDOM('<body></body>'), doc = dom.window.document;
  Object.assign(dom.window.HTMLElement.prototype, { createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string } = {}) {
    const element = this.ownerDocument.createElement(tag); element.textContent = options.text ?? ''; element.className = options.cls ?? ''; this.append(element); return element;
  } });
  let unload!: () => void, deletions = 0, usageReads = 0;
  const writes: object[] = [];
  const plugin = { register(callback: () => void) { unload = callback; } } as unknown as Plugin;
  const sessions = {
    preferences: loadToolPreferences({ toolbarTopOffset: 48, autoDetectPageLimit: 30, floatingToolbar: true, penWidth: 6 }),
    async updatePreferences(value: object) { writes.push(value); Object.assign(this.preferences, value); },
    async clearRecoveryStorage() { deletions++; },
    async recoveryUsage() { usageReads++; return { bytes: 2048, indexedPdfs: 2 }; }
  };
  const app = { doc, rows: [] as Row[] };
  const tab = new PdfSettingsTab(app as unknown as App, plugin, sessions as unknown as VaultSessions) as SettingsTab & { updates: number };
  const confirm = () => (tab as unknown as { confirmClearRecovery(): void }).confirmClearRecovery();
  const deleteButton = () => [...doc.querySelectorAll<HTMLButtonElement>('.mod-destructive')].find(button => button.textContent === 'Delete backups')!;
  const row = (name: string) => app.rows.find(row => row.name === name)!;
  return { dom, doc, tab, sessions, writes, unload, confirm, deleteButton, row, deletions: () => deletions, usageReads: () => usageReads, dispose: () => { unload(); dom.window.close(); } };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('all existing settings expose searchable names without reading storage during indexing', () => {
  const f = fixture();
  try {
    const definitions = f.tab.getSettingDefinitions();
    const names = definitions.flatMap(item => 'items' in item ? item.items?.flatMap(child => 'name' in child ? [child.name] : []) ?? [] : 'name' in item ? [item.name] : []);
    assert.deepEqual(names, ['PDF toolbar top offset', 'Floating PDF toolbar', 'Detect answer lines on PDF open', 'Automatic detection page limit', 'Wrap across consecutive answer lines', 'Keep one backup of each PDF you edit', 'Backup folder', 'Delete backups']);
    assert.equal(f.usageReads(), 0); assert.equal(f.writes.length, 0);
    assert.equal(Object.hasOwn(PdfSettingsTab.prototype, 'display'), false);
  } finally { f.dispose(); }
});

test('rendered settings read current preferences and save through the shared store without losing tool choices', async () => {
  const f = fixture();
  try {
    f.tab.update();
    const offset = f.row('PDF toolbar top offset').slider!, pages = f.row('Automatic detection page limit').slider!;
    assert.deepEqual(offset.limits, [0, 160, 1]); assert.equal(offset.value, 48);
    assert.deepEqual(pages.limits, [1, 300, 1]); assert.equal(pages.value, 30);
    assert.equal(f.row('Floating PDF toolbar').toggle!.value, true);
    await offset.change(96); await pages.change(42); await f.row('Detect answer lines on PDF open').toggle!.change(true);
    assert.equal(f.writes.length, 3);
    assert.equal(f.sessions.preferences.toolbarTopOffset, 96); assert.equal(f.sessions.preferences.autoDetectPageLimit, 42);
    assert.equal(f.sessions.preferences.autoDetectLines, true); assert.equal(f.sessions.preferences.penWidth, 6);
    f.tab.update(); assert.equal(f.row('PDF toolbar top offset').slider!.value, 96);
    await flush(); assert.match(f.row('Backup folder').descEl.textContent!, /2.0 KiB used · 2 PDFs backed up/);
  } finally { f.dispose(); }
});

test('the destructive setting requires confirmation, cancels without deletion and cannot act after unload', () => {
  const f = fixture();
  try {
    f.tab.update(); const button = f.row('Delete backups').button!.buttonEl;
    assert(button.classList.contains('mod-destructive')); button.click(); assert.equal(f.deletions(), 0);
    [...f.doc.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!.click();
    assert.equal([...f.doc.querySelectorAll('button')].some(button => button.textContent === 'Delete backups'), false);
    f.confirm(); const confirm = f.deleteButton(); assert(confirm.isConnected);
    f.unload(); assert.equal(confirm.isConnected, false); confirm.click(); button.click();
    assert.equal(f.deletions(), 0);
  } finally { f.dispose(); }
});

test('deletion runs once while pending and refreshes declarative settings after success', async () => {
  const f = fixture(); let finish!: () => void, deletions = 0;
  f.sessions.clearRecoveryStorage = () => { deletions++; return new Promise<void>(resolve => { finish = resolve; }); };
  try {
    f.tab.update(); const updates = f.tab.updates; f.confirm(); const button = f.deleteButton();
    button.click(); button.dispatchEvent(new f.dom.window.MouseEvent('click'));
    assert.equal(deletions, 1); assert.equal(button.disabled, true);
    finish(); await flush(); assert.equal(button.isConnected, false); assert.equal(f.tab.updates, updates + 1);
  } finally { f.dispose(); }
});

test('failed deletion remains retryable and closing the tab cancels its confirmation', async () => {
  const f = fixture(); let attempts = 0;
  f.sessions.clearRecoveryStorage = async () => { if (++attempts === 1) throw new Error('A PDF is still open'); };
  try {
    f.confirm(); const button = f.deleteButton(); button.click(); await flush();
    assert(button.isConnected); assert.equal(button.disabled, false);
    button.click(); await flush(); assert.equal(attempts, 2); assert.equal(button.isConnected, false);
    f.confirm(); const stale = f.deleteButton(); f.tab.hide(); stale.click();
    assert.equal(stale.isConnected, false); assert.equal(attempts, 2);
  } finally { f.dispose(); }
});

test('late storage results cannot mutate an obsolete settings row', async () => {
  const f = fixture(); let finish!: (value: { bytes: number; indexedPdfs: number }) => void;
  f.sessions.recoveryUsage = () => new Promise(resolve => { finish = resolve; });
  try {
    f.tab.update(); const text = f.row('Backup folder').descEl.querySelector('p')!;
    f.tab.hide(); f.doc.body.append(text); finish({ bytes: 1024, indexedPdfs: 1 }); await flush();
    assert.equal(text.textContent, 'Calculating backup storage…');
  } finally { f.dispose(); }
});

test('an in-flight deletion completing after unload cannot refresh settings or issue notices', async () => {
  const f = fixture(); let finish!: () => void;
  f.sessions.clearRecoveryStorage = () => new Promise<void>(resolve => { finish = resolve; });
  try {
    f.confirm(); f.deleteButton().click(); const noticeCount = notices.length;
    f.unload(); finish(); await flush(); assert.equal(notices.length, noticeCount); assert.equal(f.tab.updates, 0);
  } finally { f.dispose(); }
});
