# PDF Form Studio

Development project in **BetterPDF** for an Obsidian community plugin that will let you type answers and draw handwriting directly on PDFs embedded in notes, saving edits into the PDF file.

**Status: research and a buildable diagnostic scaffold. Inline editing and PDF saving are not implemented yet.**

The current plugin provides:

- **Inspect PDF form fields**: choose a vault PDF, inspect discovered fields and visible widgets, and distinguish these from printed answer lines. Also available from a PDF's file context menu.
- **Test pen input**: draw on a temporary pad and see the pointer type, pressure range, and tilt received by Obsidian. This is useful for testing a Wacom tablet before implementing PDF handwriting.

These tools run locally and do not modify PDFs or upload document contents. The runtime uses Obsidian's bundled PDF.js; upstream PDF.js and pdf-lib are development dependencies used only by integration tests.

The working name avoids confusion with the existing **Better PDF Plugin**, which focuses on PDF embedding. Development is currently private in [holtsdav/BetterPDF](https://github.com/holtsdav/BetterPDF).

## Develop

Use Node.js 24 and npm:

```sh
npm ci
npm run check
npm run dev
```

To install a production build into an initialized, disposable development vault:

```sh
npm run build
npm run install:dev -- "/absolute/path/to/development-vault"
```

Then enable **PDF Form Studio** in that vault's community plugin settings. Reload Obsidian after rebuilding. The install script copies only `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/pdf-form-studio/`; it does not enable the plugin automatically.

The initial manifest targets desktop Obsidian 1.13.7 or later. This is a conservative starting point based on the stable version checked on 2026-10-05, not a verified minimum compatibility claim.

## Research and next steps

- [Research: inline typing, PDF persistence, and Wacom](docs/RESEARCH.md)
- [Development, validation, and release instructions](docs/DEVELOPMENT.md)
- [Implementation roadmap and acceptance criteria](docs/ROADMAP.md)

GitHub Actions checks lint, integration tests, types, the bundle, and release metadata. Pushing a tag matching `manifest.json` creates a **draft** release with the three installable assets. Community publication comes after the editor has been implemented and tested; the current private repository cannot serve as a public community distribution.

MIT licensed. The scaffold is original code built using Obsidian's public API conventions; it does not copy code from PDF++.
