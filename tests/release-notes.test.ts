import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('release notes use the current README changelog and reject mismatched tags', () => {
  const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const notes = execFileSync(process.execPath, ['scripts/release-notes.mjs', version], { encoding: 'utf8' });
  assert(notes.includes('**Drawing resize controls:**')); assert(notes.includes('**Snap to text:**'));
  assert(notes.includes('**Original-file cleanup:**')); assert(!notes.includes('## Changelog'));
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-notes.mjs', 'v' + version], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-notes.mjs', '0.0.0'], { stdio: 'pipe' }));
});
