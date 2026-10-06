import { copyFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const vaultArgument = process.argv[2];
if (!vaultArgument || process.argv.length !== 3) {
  throw new Error('Usage: npm run install:dev -- "/absolute/path/to/a/development/vault"');
}
const vault = await realpath(resolve(vaultArgument));
if (!(await stat(join(vault, '.obsidian'))).isDirectory()) {
  throw new Error('Choose an initialized development vault with a .obsidian directory.');
}
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (!/^[a-z]+(?:-[a-z]+)*$/.test(manifest.id)) throw new Error('Invalid plugin ID.');
const plugins = join(vault, '.obsidian', 'plugins');
await mkdir(plugins, { recursive: true });
const directory = join(plugins, manifest.id);
await mkdir(directory, { recursive: true });
if (await realpath(directory) !== directory) {
  throw new Error('The plugin destination resolves through a symlink. Copy the build manually after reviewing the destination.');
}
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  const destination = join(directory, name);
  // Refuse symlinked assets so installation cannot write outside the plugin folder.
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error(`Refusing symlinked asset: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyFile(name, destination);
}
console.log(`Installed development build in ${directory}. Enable ${manifest.name} in Obsidian's community plugin settings.`);
