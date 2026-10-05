/** Rename within the current folder; never interpret an entered name as a path. */
export function renamedPdfPath(path: string, value: string): string {
  const name = value.trim().replace(/\.pdf$/i, '');
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(name)) throw new Error('Use a file name without slashes, reserved characters or a trailing dot.');
  return path.slice(0, path.lastIndexOf('/') + 1) + name + '.pdf';
}
