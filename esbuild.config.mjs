import { context } from 'esbuild';

const production = process.argv.includes('production');
const build = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
  banner: { js: '/* PDF Form Studio | MIT | https://github.com/holtsdav/BetterPDF */' }
});

if (production) {
  try { await build.rebuild(); } finally { await build.dispose(); }
} else {
  await build.watch();
}
