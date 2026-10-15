declare module 'electron' {
  export const shell: {
    openPath(path: string): Promise<string>;
    trashItem(path: string): Promise<void>;
  };
  export const webUtils: { getPathForFile(file: File): string };
}
