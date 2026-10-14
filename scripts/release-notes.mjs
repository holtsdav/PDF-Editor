import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// One changelog source serves the README, prepared assets and the draft release.
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const version = process.argv[2] ?? manifest.version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'Use an exact x.y.z release version.');
assert.equal(version, manifest.version, 'Release notes must match the manifest version.');
const readme = await readFile('README.md', 'utf8');
const heading = `### ${version}\n`;
const start = readme.indexOf(heading);
assert(start >= 0, `README.md is missing the ${version} changelog.`);
const notes = readme.slice(start + heading.length).split(/\n#{1,3} /, 1)[0].trim();
assert(notes.length > 0, 'Release notes must not be empty.');
process.stdout.write(`${notes}\n`);
