# PDF Form Studio

Fill PDF text fields, type answers on printed worksheets, highlight and scribble directly inside Obsidian notes. Text is saved into the vault PDF as editable AcroForm fields; marks use standard ink annotations with appearance streams for other viewers and printing.

**Version 0.4.0: direct editing and basic drawing development beta.** Click an existing field or text box to type immediately. Blank-space clicks keep normal PDF viewing; adding text or drawing requires its tool. Development is private in [holtsdav/BetterPDF](https://github.com/holtsdav/BetterPDF). This is not yet a published Community plugin. See [the test record](docs/TESTING.md) for actual Obsidian 1.13.7 desktop coverage and limitations.

## Use

1. Embed a PDF normally, for example `![[worksheet.pdf]]`, or open its PDF tab.
2. Click an existing text field or text box to type. The arrow tool (**Select and type**) is active by default; blank-space clicks create nothing.
3. To add text, choose **T** (**Add text box**), then click a printed answer line or drag an area. Placement returns to Select and focuses the new box. Boxes wrap text and grow downward as you type, up to the page edge.
4. Move an added box by its border; resize it with a blue handle. **Text size** changes the selected box or the next box's default. Delete/Backspace on its selected border, or its trash icon, removes it.
5. Choose **Marker** for a transparent yellow freehand highlight, or **Scribble** for a dark pen. Drag over the PDF and choose a brush width in the toolbar. Hold Shift when starting a marker stroke for a horizontal line. **Escape** or the arrow icon returns to Select.
6. In Select, click a mark and press Delete/Backspace or its trash icon to remove it. The undo icon reverses the last new mark from the current session, including one already saved.
7. Changes save automatically once no view of that PDF is typing, drawing, moving/resizing or using its controls. Use the **Save PDF** disk icon or Cmd/Ctrl+S inside a field, selected box or drawing surface to save immediately. Wait for **Saved to PDF** before closing Obsidian.

Text stays transparent, including while focused. Selection uses a blue outline and eight handles, following [Preview's text-box interaction](https://support.apple.com/en-ie/guide/preview/prvw11580/mac). The preview uses the same Noto Sans font embedded in saved text. Arrow keys move a selected border; Shift increases the step, and Alt/Option+arrows resize its right or bottom edge. Shift+Tab leaves text editing for box selection. Hover over tool icons for their labels. Size, save and removal controls appear when relevant. The **PDF options** ellipsis contains reload and recovery actions. A separate compact toolbar is used only when the native toolbar host is unavailable.

Creating a box keeps it in the shared editing session without immediately rewriting the PDF. Existing inputs stay mounted when another box is added or the viewer zooms. Automatic writes wait during placement, movement, resizing, focused editing and use of the toolbar/menu, including pauses in typing. Explicit saving can still make Obsidian refresh its viewer.

Editing works in Reading view, Live Preview, PDF tabs and pop-out windows in the tested app version. Views of the same PDF share one document session and serialized writer. Overlays follow zoom, scrolling and cropped, rotated pages. New boxes retain the orientation in which they were created.

## Recovery

Before the first edit, one verified **original.pdf** is created under **PDF Form Studio Backups** in a folder named after the PDF. Further saves and app reloads reuse it. Its checksum is checked before writes. If that copy is removed, it is recreated from the current saved PDF before the next edit is written.

The options menu offers **Open original backup**, **Restore original backup…** and **Undo last restore…**. Restoring asks before replacing the PDF and discarding pending edits. It verifies a copy of the current saved PDF in a reusable **before-restore.pdf** slot first. That gives each newly tracked PDF at most two retained recovery files during successful use. The original stays intact when restoring or reversing a restore. Recovery PDFs use the normal viewer without the plugin's editing controls, preventing backups of backups.

Version 0.2.0 created a new backup for every document session and restore. Upgrading reuses its indexed recovery copy as the retained original; older copies remain available and are not automatically deleted.

External changes stop stale saves. Pending edits remain in the open session; copy answers before using **Reload PDF** in the options menu, which asks before discarding pending text and marks. The plugin uploads nothing. PDFs/backups follow your normal vault sync settings.

## Current limits

- Moving/resizing and font-size changes apply to boxes created by this plugin; existing authored form fields keep their original geometry. Printed PDF content itself is not a text box and cannot be rewritten by clicking it.
- Marker and Scribble use constant widths. Marker is freehand rather than tied to selected words. No pressure/Wacom support, eraser, stroke movement, OCR, recognition or full document undo/redo. The undo icon covers new marks in the current session; ordinary text undo uses the browser's focused-field editing behavior. Only this plugin's marks can be selected and removed here; unrelated annotations are preserved.
- Other form controls are preserved, but changes to checkboxes, radio groups and dropdowns are not saved by this version.
- Read-only, password and rich text fields cannot be edited. XFA, encrypted PDFs and PDFs containing signature fields are rejected for editing.
- Noto Sans supports the tested German, Latin and Greek text. Unsupported glyphs produce a save error; there is no CJK/emoji font fallback. Growth stops at the page edge, where an overflow outline asks you to widen the box or reduce its text size. Original authored form regions can still clip long answers.
- Native integration uses an undocumented compatibility adapter. Other app versions/platforms, arbitrary PDFs and third-party PDF plugins need further testing. Large PDFs are rewritten on save; this is not a collaborative or atomic compare-and-swap editor.
- Pending text and marks after a failed save are held in memory, not durable across termination. Wait for **Saved** or copy the text before closing. Backups preserve the PDF already on disk.

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
