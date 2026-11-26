import { ItemView, Notice, TFile, loadPdfJs, normalizePath, setIcon, setTooltip } from 'obsidian';
import type { App, WorkspaceLeaf } from 'obsidian';
import { readTextPdf } from '../pdf/text-engine';
import type { TextSession } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { marksMarkdown, textInQuads, upsertBlock } from '../pdf/mark-export';
import type { ExportedMark, TextItem } from '../pdf/mark-export';
import { cssColor } from '../pdf/text-format';

export const ANNOTATION_VIEW = 'pdf-editor-annotations';

export interface AnnotationHost {
  sessions: VaultSessions;
  /** Show this page of the PDF, in the editor when it is open there. */
  reveal(file: TFile, page: number): void;
}

interface TextDocument {
  numPages: number;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  destroy(): Promise<void>;
}
interface TextLibrary {
  getDocument(options: object): { promise: Promise<TextDocument> };
}

/** Page text from PDF.js, cached per file version; only pages with highlights are read. */
const textCache = new Map<
  string,
  { key: string; document: Promise<TextDocument>; pages: Map<number, Promise<TextItem[]>> }
>();

async function pageText(app: App, file: TFile, page: number): Promise<TextItem[]> {
  const key = `${file.stat.mtime}:${file.stat.size}`;
  let entry = textCache.get(file.path);
  if (entry?.key !== key) {
    void entry?.document.then((document) => document.destroy()).catch(() => {});
    const document = Promise.all([app.vault.readBinary(file), loadPdfJs()]).then(
      ([bytes, library]) =>
        (library as TextLibrary).getDocument({
          data: new Uint8Array(bytes),
          isEvalSupported: false,
          enableXfa: false,
        }).promise,
    );
    entry = { key, document, pages: new Map() };
    textCache.set(file.path, entry);
  }
  let items = entry.pages.get(page);
  if (!items) {
    items = entry.document
      .then((document) => document.getPage(page))
      .then((loaded) => loaded.getTextContent())
      .then((content) =>
        content.items.filter(
          (item): item is TextItem =>
            !!item && typeof item === 'object' && 'str' in item && 'transform' in item,
        ),
      );
    entry.pages.set(page, items);
  }
  return items;
}

/** Marks of an open editing session (with unsaved changes), or read from the file. */
async function marksOf(app: App, sessions: VaultSessions, file: TFile) {
  const session = await sessions.peek(file);
  if (session) {
    return { session, marks: structuredClone(session.snapshot.marks ?? []) };
  }
  const snapshot = await readTextPdf(new Uint8Array(await app.vault.readBinary(file)));
  return { session: undefined, marks: snapshot.marks ?? [] };
}

export async function collectMarks(
  app: App,
  sessions: VaultSessions,
  file: TFile,
): Promise<{ session?: TextSession; entries: ExportedMark[] }> {
  const { session, marks } = await marksOf(app, sessions, file);
  const entries = await Promise.all(
    marks.map(async (mark) => ({
      mark,
      text:
        mark.kind !== 'note'
          ? textInQuads(await pageText(app, file, mark.page).catch(() => []), mark.quads)
          : '',
    })),
  );
  return { session, entries };
}

/** Write (or refresh) "<name> - Highlights.md" next to the PDF and open it. */
export async function exportMarks(app: App, sessions: VaultSessions, file: TFile): Promise<void> {
  try {
    const { entries } = await collectMarks(app, sessions, file);
    const folder = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
    const path = normalizePath(`${folder}${file.basename} - Highlights.md`);
    const link = app.metadataCache.fileToLinktext(file, path, false);
    const block = marksMarkdown(link, entries);
    const existing = app.vault.getAbstractFileByPath(path);
    let note: TFile;
    if (existing instanceof TFile) {
      await app.vault.process(existing, (text) => upsertBlock(text, block));
      note = existing;
    } else {
      note = await app.vault.create(path, upsertBlock(`# Highlights: ${file.basename}\n`, block));
    }
    await app.workspace.getLeaf('tab').openFile(note);
    new Notice(
      `${entries.length} highlight${entries.length === 1 ? '' : 's'} and comments exported to ${note.name}.`,
    );
  } catch (error) {
    new Notice(
      `Could not export highlights: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Sidebar listing the highlights and comments of the PDF in focus. */
export class AnnotationView extends ItemView {
  private host: AnnotationHost;
  private file?: TFile;
  private session?: TextSession;
  private unsubscribe?: () => void;
  private timer?: number;
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, host: AnnotationHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return ANNOTATION_VIEW;
  }
  getDisplayText(): string {
    return 'PDF highlights';
  }
  getIcon(): string {
    return 'highlighter';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('pfs-annotations');
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.follow()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.follow()));
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file === this.file) {
          this.schedule();
        }
      }),
    );
    this.follow();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
    }
  }

  /** Follow the PDF in focus; keep the last one while the sidebar itself is focused. */
  private follow(): void {
    const file = this.app.workspace.getActiveFile();
    if (file?.extension.toLowerCase() === 'pdf' && file !== this.file) {
      this.file = file;
      this.schedule(0);
    } else if (!this.file) {
      this.schedule(0);
    } else {
      // An editor may have opened a session for this file since the last render.
      void this.host.sessions.peek(this.file)?.then((session) => {
        if (session !== this.session) {
          this.schedule(0);
        }
      });
    }
  }

  private schedule(delay = 250): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    const file = this.file;
    const root = this.contentEl;
    if (!file) {
      root.empty();
      root.createDiv({
        cls: 'pfs-annotations-empty',
        text: 'Open a PDF to see its highlights and comments.',
      });
      return;
    }
    let result: Awaited<ReturnType<typeof collectMarks>>;
    try {
      result = await collectMarks(this.app, this.host.sessions, file);
    } catch (error) {
      if (generation === this.generation) {
        root.empty();
        root.createDiv({
          cls: 'pfs-annotations-empty',
          text: `Highlights cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    if (result.session !== this.session) {
      this.unsubscribe?.();
      this.session = result.session;
      this.unsubscribe = result.session?.subscribe(() => this.schedule());
    }
    root.empty();
    const header = root.createDiv({ cls: 'pfs-annotations-header' });
    header.createDiv({ cls: 'pfs-annotations-title', text: file.basename });
    const exportButton = header.createEl('button', { cls: 'clickable-icon' });
    setIcon(exportButton, 'file-output');
    setTooltip(exportButton, 'Export highlights and comments to a note');
    exportButton.addEventListener(
      'click',
      () => void exportMarks(this.app, this.host.sessions, file),
    );
    const entries = [...result.entries].sort(
      (a, b) =>
        a.mark.page - b.mark.page ||
        b.mark.rect[3] - a.mark.rect[3] ||
        a.mark.rect[0] - b.mark.rect[0],
    );
    if (!entries.length) {
      root.createDiv({
        cls: 'pfs-annotations-empty',
        text: 'No highlights or comments yet. Select text in the PDF editor to highlight it.',
      });
      return;
    }
    root.createDiv({
      cls: 'pfs-annotations-count',
      text: `${entries.length} highlight${entries.length === 1 ? '' : 's'} and notes`,
    });
    let page = 0;
    for (const { mark, text } of entries) {
      if (mark.page !== page) {
        page = mark.page;
        root.createEl('h6', { cls: 'pfs-annotations-page', text: `Page ${page}` });
      }
      const item = root.createEl('button', { cls: 'pfs-annotation' });
      item.style.setProperty('--pfs-mark-color', cssColor(mark.color));
      if (mark.kind !== 'note') {
        if (mark.kind !== 'highlight') {
          item.createDiv({
            cls: 'pfs-annotation-kind',
            text: mark.kind === 'underline' ? 'Underline' : 'Strikethrough',
          });
        }
        item.createDiv({ cls: 'pfs-annotation-text', text: text || '(highlighted area)' });
      } else {
        item.createDiv({ cls: 'pfs-annotation-kind', text: 'Note' });
      }
      if (mark.comment.trim()) {
        item.createDiv({ cls: 'pfs-annotation-comment', text: mark.comment.trim() });
      }
      if (mark.foreign) {
        item.createDiv({
          cls: 'pfs-annotation-meta',
          text: mark.author ? `By ${mark.author}` : 'Made in another app',
        });
      }
      item.addEventListener('click', () => this.host.reveal(file, mark.page));
    }
  }
}
