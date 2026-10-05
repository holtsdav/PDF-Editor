import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const [manifest, pkg, versions] = await Promise.all([
  readJson('manifest.json'), readJson('package.json'), readJson('versions.json')
]);
assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/);
assert(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'));
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version, 'Package and manifest versions must agree.');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'Compatibility mapping must agree.');
assert.equal(typeof manifest.isDesktopOnly, 'boolean');
assert.equal(typeof manifest.author, 'string');
assert(manifest.author.length > 0 && manifest.name.length > 0);
assert(manifest.description.length <= 250 && manifest.description.endsWith('.'));
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
if (tag) assert.equal(tag, manifest.version, 'Release tag must equal manifest version, with no v prefix.');
for (const file of ['main.js', 'styles.css', 'README.md', 'LICENSE']) {
  assert((await stat(file)).size > 0, `${file} must exist and contain content.`);
}
const bundle = await readFile('main.js', 'utf8');
assert(bundle.includes('module.exports'), 'Obsidian needs a CommonJS bundle.');
assert(!/require\(["'](?:node:|electron|fs["']|pdfjs-dist|pdf-lib)/.test(bundle), 'Runtime bundle must not depend on development-only libraries or Node APIs.');
console.log(`Validated ${manifest.name} ${manifest.version} (${manifest.id}).`);
