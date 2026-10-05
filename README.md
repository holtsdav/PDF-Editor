# PDF Form Studio

Fill PDF text fields, type answers on printed worksheets, highlight and scribble directly inside Obsidian notes. Text is saved into the vault PDF as editable AcroForm fields; marks use standard ink annotations with appearance streams for other viewers and printing.

**Version 0.5.0: text formatting and ink editing development beta.** Click an existing field or text box to type immediately. Blank-space clicks keep normal PDF viewing; adding text or drawing requires its tool. Development is private in [holtsdav/BetterPDF](https://github.com/holtsdav/BetterPDF). This is not yet a published Community plugin. See [the test record](docs/TESTING.md) for actual Obsidian 1.13.7 desktop coverage and limitations.

## Use

1. Embed a PDF normally, for example `![[worksheet.pdf]]`, or open its PDF tab.
2. Click an existing text field or text box to type. The arrow tool (**Select and type**) is active by default; blank-space clicks create nothing.
3. To add text, choose **T** (**Add text box**), then click a printed answer line or drag an area. Placement focuses the new box; Text stays active until you choose Select. Boxes wrap text and grow downward as you type, up to the page edge.
4. Move an added box by its border; resize it with a blue handle. **Font**, **color** and **size** appear when a field or box is selected. Formatting applies to the whole field or box; authored fields retain their original geometry. Delete/Backspace on its selected border, or its trash icon, removes it.
5. Choose **Marker** for a transparent freehand highlight, or **Pen** for a constant-width line. Tap the active tool again to choose its color or width. Hold Shift when starting a marker stroke for a horizontal line. Tools stay active until you choose the Select arrow; Escape cancels a gesture or clears a selection.
6. In Select, drag a mark to move it, or click it and press Delete/Backspace or its trash icon to remove it. Arrow keys move selected marks; Shift increases the step. **Eraser** removes whole owned marks under its path. Undo reverses creation, movement, deletion or an entire eraser gesture (up to 50 actions in the current session), including edits already saved.
7. Text saves automatically once no view of that PDF is typing, placing, moving/resizing or using its controls. While any view has Pen, Marker or Eraser active, the PDF stays unchanged: pending edits are checkpointed to a verified local recovery draft after a short pause. Choose **Select**, close that view, or explicitly save to commit the drawing batch. Use the **Save PDF** disk icon or Cmd/Ctrl+S inside a field, selected box or drawing surface to save immediately. Wait for **Saved to PDF** before closing Obsidian.

Text stays transparent, including while focused. Selection uses a blue outline and eight handles, following [Preview's text-box interaction](https://support.apple.com/en-ie/guide/preview/prvw11580/mac). The preview and saved text use the same bundled Noto Sans, Noto Serif or Noto Sans Mono font. Arrow keys move a selected border; Shift increases the step, and Alt/Option+arrows resize its right or bottom edge. Shift+Tab leaves text editing for box selection. Hover over tool icons for their labels. Text formatting, save, undo and removal controls appear when relevant. The **PDF options** ellipsis contains reload and recovery actions. The compact annotation row sits beneath native PDF navigation at a stable height, so selection controls do not shift the page or create horizontal scrolling at the tested embed width.

Creating a box keeps it in the shared editing session without immediately rewriting the PDF. Existing inputs stay mounted when another box is added or the viewer zooms. Automatic writes wait during placement, movement, resizing, focused editing and use of the toolbar/menu, including pauses in typing. A public PDF.js backdrop preserves page content and foreign annotations while owned ink is drawn live once. This avoids old mark images remaining behind during movement or erasing. PDF writes are batched across a drawing session because Obsidian reloads the viewer after a vault write; choosing Select or explicitly saving can still cause one refresh.

Editing works in Reading view, Live Preview, PDF tabs and pop-out windows in the tested app version. Views of the same PDF share one document session and serialized writer. Overlays follow zoom, scrolling and cropped, rotated pages. New boxes retain the orientation in which they were created.

## Recovery

Before the first overwrite, one verified **original.pdf** is retained in the plugin's hidden recovery storage (`.obsidian/plugins/pdf-form-studio/recovery`, or the vault's configured settings directory). Further saves reuse it. Checksums are verified before writing or restoring. There is no backup folder in the note list.

Upgrading moves the entire old **PDF Form Studio Backups** folder into hidden storage, including older unindexed copies. A migration receipt lets an interrupted index update resume after restart. Copies are moved without deleting their contents. Newly tracked PDFs retain one original and one reusable **before-restore.pdf** slot.

The options menu offers **Preview original PDF**, **Restore original backup…** and **Undo last restore…**. The original opens in a read-only paginated preview. Restoring asks before replacing the PDF and discarding pending edits; it first verifies a recovery copy of the current saved PDF, so the restore can be reversed.

Pending edits are serialized into a verified draft PDF in a hidden journal, with the prior complete journal retained as a fallback during the next write. Opening the PDF after restart recovers that draft. A baseline checksum prevents an older draft from overwriting a newer source PDF; external changes stop stale saves. **Reload PDF** asks before discarding pending text and marks.

The plugin uploads nothing. Saved PDFs follow normal vault sync; hidden drafts and recovery copies are local plugin storage, and their synchronization depends on your sync tool's settings. Copy the recovery directory separately when moving a vault or reinstalling the plugin. Removing the plugin's entire folder also removes its local recovery data.

## Current limits

- Moving/resizing applies to boxes created by this plugin; existing authored form fields keep their original geometry. Printed PDF content itself is not a text box and cannot be rewritten by clicking it.
- Marker and Scribble use constant widths. Marker is freehand rather than tied to selected words. No pressure/Wacom support, partial-stroke erasing, OCR, recognition, redo or full document undo. The undo icon covers owned ink actions in the current session; ordinary text undo uses the browser's focused-field editing behavior. Only this plugin's marks can be moved, erased or removed here; unrelated annotations are preserved.
- Other form controls are preserved, but changes to checkboxes, radio groups and dropdowns are not saved by this version.
- Read-only, password and rich text fields cannot be edited. XFA, encrypted PDFs and PDFs containing signature fields are rejected for editing.
- The bundled fonts support the tested German, Latin and Greek text. Formatting applies to whole fields, with three font families and palette colors; selected substrings do not have independent styles. Unsupported glyphs produce a save error; there is no CJK/emoji font fallback. Growth stops at the page edge, where an overflow outline asks you to widen the box or reduce its text size. Original authored form regions can still clip long answers.
- Native integration uses an undocumented compatibility adapter. Other app versions/platforms, arbitrary PDFs and third-party PDF plugins need further testing. Large PDFs are rewritten on save; this is not a collaborative or atomic compare-and-swap editor.
- A draft is durable only after its checkpoint succeeds. During drawing, hover the status icon for **Draft saved locally**; use **Saved to PDF** before sending the PDF to another app. A crash before the short debounce/checkpoint completes can lose the latest edits. Disk failures or unsupported text can prevent checkpointing; save errors leave pending edits in the session.

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

Original code is MIT licensed. PDF-LIB and fontkit are bundled for writing; Obsidian's PDF.js supports inspection, the live backdrop and recovery preview. Upstream PDF.js is a test dependency only. The Noto fonts are SIL OFL licensed. [Third-party notices](THIRD_PARTY_NOTICES.txt) are embedded in `main.js`.
