import { context } from 'esbuild';
import { readFileSync } from 'node:fs';

const notices = readFileSync(new URL('./THIRD_PARTY_NOTICES.txt', import.meta.url), 'utf8').replaceAll('*/', '* /');

const production = process.argv.includes('production');
const build = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  loader: { '.ttf': 'binary' },
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
  banner: { js: `/* PDF Editor | MIT | https://github.com/holtsdav/PDF_Editor\n${notices}\n*/` }
});

if (production) {
  try { await build.rebuild(); } finally { await build.dispose(); }
} else {
  await build.watch();
}
