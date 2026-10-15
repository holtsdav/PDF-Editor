export interface ImportSource {
  path: string;
  identity: string;
  bytes: Uint8Array;
}
export interface ImportCleanupStore {
  active(): boolean;
  source(path: string): Promise<ImportSource | null>;
  attachment(): Promise<Uint8Array | null>;
  trash(path: string): Promise<void>;
}
const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** No destructive fallback. Recheck both the OS source identity and the indexed vault copy. */
export async function trashVerifiedImport(
  original: ImportSource,
  imported: Uint8Array,
  store: ImportCleanupStore,
): Promise<boolean> {
  if (!store.active() || !equal(original.bytes, imported)) {
    return false;
  }
  const saved = await store.attachment();
  if (!saved || !store.active() || !equal(saved, imported)) {
    return false;
  }
  const current = await store.source(original.path);
  if (
    !current ||
    !store.active() ||
    current.identity !== original.identity ||
    current.path !== original.path ||
    !equal(current.bytes, imported)
  ) {
    return false;
  }
  // Neither a filesystem path nor Obsidian's attachment has an atomic compare-and-trash API.
  await store.trash(original.path);
  return true;
}
