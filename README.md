# PDF Form Studio

Fill PDF text fields and type answers directly on printed worksheets embedded in Obsidian notes. Answers are saved into the vault PDF as editable AcroForm fields, with embedded fonts and appearance streams for other viewers and printing.

**Version 0.3.0: text editing development beta.** Preview-style text boxes with blue resize handles, dragging, automatic wrapping and height growth. Development is private in [holtsdav/BetterPDF](https://github.com/holtsdav/BetterPDF). This is not yet a published Community plugin. See [the test record](docs/TESTING.md) for actual Obsidian 1.13.7 desktop coverage and limitations.

## Use

1. Embed a PDF normally, for example `![[worksheet.pdf]]`, or open its PDF tab.
2. Click the **T** icon (**Edit text**) in the PDF's existing toolbar. Hover over icons for their labels.
3. Fill an existing text field, click a printed answer line to add text, or drag an area for an answer. New boxes wrap text and grow downward as you type, up to the page edge.
4. Click a created box to select it. Drag its text or border to move it; drag a blue handle to resize it. Double-click or press Enter to edit the text. While typing, use its border to move it. **Text size** changes the selected box or the default for the next box. Delete/Backspace on a selected box, or its trash icon, removes it.
5. Changes save automatically after leaving the editor's controls, once no view of that PDF is editing or placing a box. Use the **Save PDF** disk icon, Cmd/Ctrl+S inside a field or selected box, or **Done editing** to save immediately. Wait for the status check (**Saved to PDF**) before closing Obsidian.
6. Click the editing checkmark (**Done editing**) to return to normal viewing.

Text stays transparent, including while focused. Selection uses a blue outline and eight handles, following [Preview's text-box interaction](https://support.apple.com/en-ie/guide/preview/prvw11580/mac). The preview uses the same Noto Sans font embedded in saved text. Arrow keys move a selected box; Shift increases the step, and Alt/Option+arrows resize its right or bottom edge. Shift+Tab leaves text editing for box selection. The **PDF text options** ellipsis contains reload and recovery actions. A separate compact toolbar is used only when the native toolbar host is unavailable.

Creating a box keeps it in the shared editing session without immediately rewriting the PDF. Existing inputs stay mounted when another box is added or the viewer zooms. Automatic writes wait during placement, movement, resizing, focused editing and use of the toolbar/menu, including pauses in typing. Explicit saving can still make Obsidian refresh its viewer.

Editing works in Reading view, Live Preview, PDF tabs and pop-out windows in the tested app version. Views of the same PDF share one document session and serialized writer. Overlays follow zoom, scrolling and cropped, rotated pages. New boxes retain the orientation in which they were created.

## Recovery

Before the first edit, one verified **original.pdf** is created under **PDF Form Studio Backups** in a folder named after the PDF. Further saves and app reloads reuse it. Its checksum is checked before writes. If that copy is removed, it is recreated from the current saved PDF before the next edit is written.

The options menu offers **Open original backup**, **Restore original backup…** and **Undo last restore…**. Restoring asks before replacing the PDF and discarding pending text. It verifies a copy of the current saved PDF in a reusable **before-restore.pdf** slot first. That gives each newly tracked PDF at most two retained recovery files during successful use. The original stays intact when restoring or reversing a restore. Recovery PDFs use the normal viewer without the plugin's editing controls, preventing backups of backups.

Version 0.2.0 created a new backup for every document session and restore. Upgrading reuses its indexed recovery copy as the retained original; older copies remain available and are not automatically deleted.

External changes stop stale saves. Pending answers remain in the open session; copy them before using **Reload PDF** in the options menu, which asks before discarding pending text. The plugin uploads nothing. PDFs/backups follow your normal vault sync settings.

## Current limits

- Text fields and manually placed boxes only. Moving/resizing and font-size changes apply to boxes created by this plugin; existing authored form fields keep their original geometry. No Wacom/ink, OCR, recognition or document-level undo. Ordinary text undo uses the browser's focused-field editing behavior.
- Other form controls are preserved, but changes to checkboxes, radio groups and dropdowns are not saved by this version. Use **Edit text** for persistent text changes.
- Read-only, password and rich text fields cannot be edited. XFA, encrypted PDFs and PDFs containing signature fields are rejected for editing.
- Noto Sans supports the tested German, Latin and Greek text. Unsupported glyphs produce a save error; there is no CJK/emoji font fallback. Growth stops at the page edge, where an overflow outline asks you to widen the box or reduce its text size. Original authored form regions can still clip long answers.
- Native integration uses an undocumented compatibility adapter. Other app versions/platforms, arbitrary PDFs and third-party PDF plugins need further testing. Large PDFs are rewritten on save; this is not a collaborative or atomic compare-and-swap editor.
- Pending text after a failed save is held in memory, not durable across termination. Wait for **Saved** or copy the text before closing. Backups preserve the PDF already on disk.

## Install and develop

Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/pdf-form-studio/`, then enable **PDF Form Studio** in Community plugins. Release tags create private **draft** releases with those assets.

Use Node.js 24:

```sh
npm ci
npm run check
npm run build
npm run install:dev -- "/absolute/path/to/initialized-development-vault"
```

The installer does not enable the plugin. Reload Obsidian after rebuilding. `npm run dev` watches source. The desktop minimum of 1.13.7 matches the tested app; it is not a claim about older versions.

- [Development and release instructions](docs/DEVELOPMENT.md)
- [App test record](docs/TESTING.md)
- [Original PDF and Wacom research](docs/RESEARCH.md)
- [Roadmap](docs/ROADMAP.md)

Original code is MIT licensed. PDF-LIB and fontkit are bundled for writing; Obsidian's PDF.js supports the inspector. Upstream PDF.js is a test dependency only. Noto Sans is SIL OFL licensed. [Third-party notices](THIRD_PARTY_NOTICES.txt) are embedded in `main.js`.
