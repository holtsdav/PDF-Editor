import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const version = process.env.npm_package_version;
assert(version && /^\d+\.\d+\.\d+$/.test(version), 'Use npm version with a stable x.y.z version.');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
manifest.version = version;
versions[version] = manifest.minAppVersion;
await writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile('versions.json', `${JSON.stringify(versions, null, 2)}\n`);
