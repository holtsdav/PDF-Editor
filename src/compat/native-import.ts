import { TFile } from 'obsidian';
import type { App, Editor, MarkdownView, MarkdownFileInfo } from 'obsidian';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

interface NativeImportOptions<S> {
  enabled(): boolean;
  path(file: File): string;
  prepare(path: string, file: File): Promise<S | null>;
  imported(source: S, file: TFile, bytes: Uint8Array, current: () => boolean): Promise<void>;
  skipped(): void;
  failed(error: unknown): void;
}
type NativeImportBytes = ArrayBuffer | Uint8Array;
interface NativeAttachment {
  filepath?: string;
  extension?: string;
  data?: Promise<NativeImportBytes>;
}
interface ClipboardManager {
  info: MarkdownView | MarkdownFileInfo;
  insertFiles(items: NativeAttachment[]): Promise<void>;
  insertAttachmentEmbed(file: TFile, trailing?: boolean): void;
}
type AttachmentSaver = (
  name: string,
  extension: string,
  bytes: NativeImportBytes,
) => Promise<TFile>;

/** Observe exact native buffers/results; never take over the drop or guess a source by its filename. */
export function observeNativePdfImports<S>(app: App, options: NativeImportOptions<S>): () => void {
  const host = app as App & { saveAttachment?: AttachmentSaver };
  const originalSave = host.saveAttachment;
  if (typeof originalSave !== 'function') {
    return () => {};
  }
  type Ticket = {
    source: Promise<S | null>;
    info: MarkdownView | MarkdownFileInfo;
    note: TFile | null;
    editor: Editor;
    bytes: Uint8Array;
    claimed: boolean;
    cancelled: boolean;
  };
  const buffers = new WeakMap<NativeImportBytes, Ticket>();
  const destinations = new Map<TFile, Ticket>();
  const contexts = new Set<() => void>();
  const busy = new WeakSet<ClipboardManager>();
  let closed = false;
  const active = () => !closed && options.enabled();
  const save: AttachmentSaver = function (this: App, name, extension, bytes) {
    const result = originalSave.call(this, name, extension, bytes);
    const ticket = buffers.get(bytes);
    if (ticket && !ticket.claimed && !ticket.cancelled && active()) {
      ticket.claimed = true;
      if (!result || typeof result.then !== 'function') {
        ticket.cancelled = true;
        options.skipped();
        return result;
      }
      void result.then(
        (file) => {
          if (file instanceof TFile && !ticket.cancelled && active()) {
            destinations.set(file, ticket);
          }
        },
        () => {
          ticket.cancelled = true;
        },
      );
    }
    return result;
  };
  host.saveAttachment = save;
  const drop = app.workspace.on('editor-drop', (event, editor, info) => {
    if (!active() || event.defaultPrevented || !event.dataTransfer || contexts.size >= 8) {
      return;
    }
    const note = info.file;
    const files = new Map<string, File>();
    for (const file of Array.from(event.dataTransfer.files)) {
      if (/\.pdf$/i.test(file.name)) {
        try {
          const path = options.path(file);
          if (path) {
            if (files.has(path)) {
              return;
            }
            files.set(path, file);
          }
        } catch {
          /* Unsupported OS handle: native import still proceeds. */
        }
      }
    }
    if (!files.size) {
      return;
    }
    if (
      files.size > 32 ||
      [...files.values()].reduce((sum, file) => sum + file.size, 0) > 100_000_000
    ) {
      options.skipped();
      return;
    }
    // Current hosts keep the manager on the callback editor's component; older hosts expose sourceMode.
    // Accept a shared alias, but never choose between different managers for the same drop.
    const candidates = [
      record(record(record(editor)?.editorComponent)?.clipboardManager),
      record(record(record(info)?.sourceMode)?.clipboardManager),
    ].filter((value): value is Record<string, unknown> => !!value);
    const managers = new Set(candidates);
    const manager =
      managers.size === 1 ? ([...managers][0] as unknown as ClipboardManager) : undefined;
    if (
      !manager ||
      manager.info !== info ||
      typeof manager.insertFiles !== 'function' ||
      typeof manager.insertAttachmentEmbed !== 'function'
    ) {
      options.skipped();
      return;
    }
    // A second drop may finish after the first and restore its already-disposed wrapper.
    // Keep native import intact, but do not observe overlapping work on one manager.
    if (busy.has(manager)) {
      options.skipped();
      return;
    }
    busy.add(manager);
    const insertFiles = manager.insertFiles;
    const insertEmbed = manager.insertAttachmentEmbed;
    const tickets = new Set<Ticket>();
    let ended = false;
    const container = record(info)?.containerEl;
    const view = (container as HTMLElement | undefined)?.ownerDocument?.defaultView ?? window;
    const dispose = () => {
      if (ended) {
        return;
      }
      ended = true;
      contexts.delete(dispose);
      busy.delete(manager);
      view.clearTimeout(timer);
      for (const ticket of tickets) {
        ticket.cancelled = true;
      }
      for (const [file, ticket] of destinations) {
        if (tickets.has(ticket)) {
          destinations.delete(file);
        }
      }
      if (manager.insertFiles === insert) {
        manager.insertFiles = insertFiles;
      }
      if (manager.insertAttachmentEmbed === embed) {
        manager.insertAttachmentEmbed = insertEmbed;
      }
    };
    const embed: ClipboardManager['insertAttachmentEmbed'] = function (
      this: ClipboardManager,
      file,
      trailing,
    ) {
      const before = editor.getValue();
      insertEmbed.call(this, file, trailing);
      const ticket = destinations.get(file);
      if (!ticket || !tickets.has(ticket)) {
        return;
      }
      destinations.delete(file);
      if (
        ticket.cancelled ||
        !active() ||
        info.file !== ticket.note ||
        editor.getValue() === before
      ) {
        return;
      }
      const current = () =>
        active() &&
        info.file === ticket.note &&
        manager.info === info &&
        (!(container as HTMLElement | undefined) || (container as HTMLElement).isConnected);
      // Begin verification after the native embed insertion succeeded, before releasing this context.
      void ticket.source
        .then(async (source) => {
          if (source && current()) {
            await options.imported(source, file, ticket.bytes, current);
          } else if (active()) {
            options.skipped();
          }
        })
        .catch((error) => {
          if (active()) {
            options.failed(error);
          }
        });
    };
    const insert: ClipboardManager['insertFiles'] = function (this: ClipboardManager, items) {
      // Only the insertFiles call made synchronously by this drop owns these descriptors.
      if (ended || manager.insertFiles !== insert) {
        return insertFiles.call(this, items);
      }
      manager.insertFiles = insertFiles;
      for (const item of items) {
        const file = item.filepath ? files.get(item.filepath) : undefined;
        if (
          !file ||
          item.extension?.toLowerCase() !== 'pdf' ||
          !item.data ||
          typeof item.data.then !== 'function'
        ) {
          continue;
        }
        const source = Promise.resolve()
          .then(() => options.prepare(item.filepath!, file))
          .catch(() => null);
        void item.data
          .then((bytes) => {
            if (ended || !active()) {
              return;
            }
            const tag = Object.prototype.toString.call(bytes);
            if (
              tag !== '[object ArrayBuffer]' &&
              !(ArrayBuffer.isView(bytes) && tag === '[object Uint8Array]')
            ) {
              return;
            }
            if (bytes.byteLength !== file.size || bytes.byteLength > 100_000_000) {
              options.skipped();
              return;
            }
            if (buffers.has(bytes)) {
              buffers.get(bytes)!.cancelled = true;
              return;
            }
            const view = bytes as Uint8Array;
            const content =
              tag === '[object ArrayBuffer]'
                ? new Uint8Array(bytes as ArrayBuffer)
                : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            const ticket: Ticket = {
              source,
              info,
              note,
              editor,
              bytes: content.slice(),
              claimed: false,
              cancelled: false,
            };
            tickets.add(ticket);
            buffers.set(bytes, ticket);
          })
          .catch(() => {});
      }
      const result = insertFiles.call(this, items);
      if (result && typeof result.then === 'function') {
        void result.then(dispose, dispose);
      } else {
        dispose();
      }
      return result;
    };
    manager.insertFiles = insert;
    manager.insertAttachmentEmbed = embed;
    const timer = view.setTimeout(dispose, 60_000);
    contexts.add(dispose);
    // Cancelled, modifier-link and handled HTML drops never call native insertFiles.
    queueMicrotask(() => {
      if (manager.insertFiles === insert) {
        dispose();
      }
    });
  });
  return () => {
    closed = true;
    app.workspace.offref(drop);
    for (const dispose of [...contexts]) {
      dispose();
    }
    destinations.clear();
    if (host.saveAttachment === save) {
      host.saveAttachment = originalSave;
    }
  };
}
