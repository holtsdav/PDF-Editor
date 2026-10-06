# PDF Editor

Fill PDF text fields, type answers on printed worksheets, highlight and scribble directly inside Obsidian notes. Text is saved into the vault PDF as editable AcroForm fields; marks use standard ink annotations with appearance streams for other viewers and printing.

**Version 0.7.6: integrated editor development beta.** Ordinary PDF embeds and PDF tabs use a persistent PDF.js editing surface. Saving no longer replaces its page canvases, text controls or drawing layers. Development is private in [holtsdav/PDF_Editor](https://github.com/holtsdav/PDF_Editor); this is not yet a published Community plugin. See [the test record](docs/TESTING.md) for exact coverage and limitations.

The current working tree has undergone a [production-readiness audit](docs/PRODUCTION_AUDIT.md): 88 regression tests and four stress workloads pass, including interrupted writes and large documents. It remains a beta: simultaneous external writers, crash recovery during file moves and large-file resource use still limit production readiness.

## Use

1. Embed a PDF normally, for example `![[worksheet.pdf]]`, or open its PDF tab. Page navigation, fit-width zoom, rotation and PDF search sit above a fixed editing toolbar. The default embed is tall enough for one complete page at fit-width, including A4. Existing `#page=` and explicit numeric `#height=` embed options are respected.
2. **Select (V)** lets you select printed text, follow PDF links and move your marks. Drag from blank space to marquee-select added text boxes and drawings on that page. Shift-click adds or removes an object; drag a selected member to move the group, use arrows to nudge, and Delete/Backspace removes the group. Movement and deletion undo as one action. Starting a drag on printed PDF text still selects text. Click a text box once to select it; double-click or press Enter to edit. **Text (T)** places and focuses a new box by clicking or dragging on the page. Text stays active for repeated answers.
3. **Pen (P)** draws opaque ink. **Smooth ink** reduces wobble and defaults on. **Highlighter (H)** draws transparent strokes: hold still for about 650ms before lifting to straighten, or start with Shift for a horizontal line. **Eraser (E)** removes entire owned strokes.
4. Use the adjacent settings button for color swatches, sample thicknesses and a combined brush preview. Click it again, tap the active tool or press Escape to dismiss. Text settings offer Sans/Serif/Mono, color and size. Preferences persist across restarts; changing tools keeps the toolbar in place.
5. Drag anywhere on a selected, non-editing added box to move it; use its blue handles to resize. Delete/Backspace removes a selected owned box or mark. Empty added boxes disappear when focus leaves the whole box. Switching between Text and Select, moving, resizing and using text settings retain the blank; authored fields and blanks actively being edited in another view are retained. Text wraps and grows to the page edge. Authored fields keep their original geometry.
6. **Undo/Redo** covers text box creation, changes, formatting, movement, deletion and ink actions, including edits already saved (50 actions per session). Focused text inputs retain normal browser text undo. Outside inputs use Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z. Escape cancels the active gesture or clears the selection.
7. Edits save automatically after a short pause, even while a drawing tool remains selected. **Saved** means the actual vault PDF has been written and read back successfully. The disk button or Cmd/Ctrl+S saves immediately. No tool switch is needed. The PDF remains editable and can be opened or printed in other viewers.

8. Enable **Draw & hold shapes** in Pen settings for single-stroke lines, rectangles, triangles, ellipses/circles and arrows. It defaults off. Rectangles and a triangle’s longest edge snap to page axes when within eight degrees; deliberate rotations remain. Hold at the endpoint until a shape label appears, then keep the pointer down and move to resize. Lines follow the held endpoint; circles keep a uniform radius; other closed shapes stretch in two directions. Lift to commit or press Escape to cancel. Uncertain shapes stay freehand. Draw arrows along the shaft, to one wing, back to the tip, then to the other wing. See [research and limits](docs/INK_RESEARCH.md).
9. **Detect answer lines in PDF** in the header scans every page locally, including pages offscreen, and highlights suggested blank lines on each page. Progress shows the page being scanned; click the button while scanning to cancel. Click a blue outline to fill that answer; this activates Select, so further page clicks do not create free text boxes. Click a detected answer once to edit it again. Tab/Shift+Tab moves to the next/previous detected line in page order, creating a field only when you enter it; Enter remains a newline within the current answer. Clicking the button after completion hides all suggestions. Detection alone never edits the PDF, and existing fields are excluded. It is a raster heuristic, not OCR: clear underscores, regular short dashes and thin horizontal rules work best. Inset answer rules inside a frame are supported; connected table edges remain excluded. Nearby labels limit field height and overlapping label tails are trimmed; text size fits the detected space. Noisy scans, slanted/dotted lines and table cells can still be missed.
10. Click the PDF name in its header to rename it in the same vault folder. Enter saves; Escape cancels. Pending edits save before renaming through Obsidian's file manager, which handles links according to your vault settings.

PDF pages are rendered near the viewport; distant bitmap memory is released. Saving reuses a verified draft for the same revision. The visible document, selection and scroll position stay mounted during ordinary saves. Pointer interruption preserves collected pen points; Escape explicitly cancels. Two views share the document and serialized writer, and gesture ownership prevents one view cancelling another view's drawing.

The editor uses Obsidian's theme, icons, existing embeds and vault storage. A compatibility adapter discovers native hosts; the visible renderer uses the public PDF.js loader. Native Obsidian page DOM is no longer the editing surface. The native viewer remains available when a document cannot be edited. This version does not reproduce every native PDF viewer feature: outlines, thumbnails, native PDF context-menu actions and updating already-open views from new subpath links require further integration. Search navigates matching pages and highlights matching text spans; it is not OCR.

## Recovery

Before the first overwrite, one verified **original.pdf** is retained in the plugin's hidden recovery storage (`.obsidian/plugins/pdf-form-studio/recovery`, or the vault's configured settings directory). Further saves reuse it. Checksums are verified before writing or restoring. There is no backup folder in the note list.

Upgrading moves the entire old **PDF Form Studio Backups** folder into hidden storage, including older unindexed copies. A migration receipt lets an interrupted index update resume after restart. Copies are moved without deleting their contents. Newly tracked PDFs retain one original and up to two alternating **before-restore** slots, keeping the previous complete reversal available if the next copy is interrupted. Missing originals block saving rather than being silently replaced with newer content.

The options menu offers **Recovery copies…**, showing purpose, storage location and current copy sizes, and **Preview original PDF**, **Restore original backup…** and **Undo last restore…**. The original opens in a read-only paginated preview. Restoring asks before replacing the PDF and discarding pending edits; it first verifies a recovery copy of the current saved PDF, so the restore can be reversed.

Pending edits are serialized into a verified draft PDF in a hidden journal, with two sequenced slots preserving the latest complete copy during the next write. Explicit saving checkpoints before writing the source too. Opening the PDF after restart recovers that draft; a journal identical to the committed source is recognized as already saved. A baseline checksum prevents an older draft from overwriting a newer source PDF; detected external changes stop stale saves. **Reload PDF** asks before discarding pending text and marks. Reload/restore temporarily block editing while replacing the document.

The plugin uploads nothing. Saved PDFs follow normal vault sync; hidden drafts and recovery copies are local plugin storage, and their synchronization depends on your sync tool's settings. Copy the recovery directory separately when moving a vault or reinstalling the plugin. Removing the plugin's entire folder also removes its local recovery data. Originals, the restore slots and migrated legacy copies have no automatic expiry or pruning. Drafts are cleared once all edits are saved, or after an explicit discard/reload or restore. Do not downgrade to an older build while edits remain pending.

## Current limits

- Smooth ink stabilizes strokes; it does not rewrite handwriting or perform OCR. Cube and multistroke recognition are deferred pending grouping, labeled examples and false-positive evaluation. Physical stylus/pressure testing remains outstanding.
- Moving/resizing applies to boxes created by this plugin; existing authored form fields keep their original geometry. Printed PDF content itself is not a text box and cannot be rewritten by clicking it.
- Marker and Scribble use constant widths. Marker is freehand rather than tied to selected words. No pressure/Wacom support, partial-stroke erasing, OCR or handwriting recognition. Session undo/redo is limited to 50 editing actions and is not preserved after reopening; ordinary focused text undo uses the browser's editing behavior. Only this plugin's marks can be moved, erased or removed here; unrelated annotations are preserved.
- Other form controls are preserved, but changes to checkboxes, radio groups and dropdowns are not saved by this version.
- Read-only, password, rich text, hidden and locked fields retain their original appearances and cannot be edited. XFA, encrypted PDFs, PDFs containing signature fields, duplicate field names and malformed page/form trees are rejected for editing.
- The bundled fonts support the tested German, Latin and Greek text. Formatting applies to whole fields, with three font families and palette colors; selected substrings do not have independent styles. Unsupported glyphs produce a save error; there is no CJK/emoji font fallback. Growth stops at the page edge, where an overflow outline asks you to widen the box or reduce its text size. Original authored form regions can still clip long answers.
- Native integration uses an undocumented compatibility adapter. Other app versions/platforms, arbitrary PDFs and third-party PDF plugins need further testing. Large PDFs are rewritten on save; this is not a collaborative or atomic compare-and-swap editor.
- A draft is durable only after its checkpoint succeeds. Use **Saved** before sending the PDF to another app. A crash before the short debounce/checkpoint completes can lose the latest edits. Disk failures or unsupported text can prevent checkpointing; save errors leave pending edits in the session.

## Install and develop

Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/pdf-form-studio/`, then enable **PDF Editor** in Community plugins. The installed ID remains `pdf-form-studio` for compatibility. Release tags create private **draft** releases with those assets.

Use Node.js 24:

```sh
npm ci
npm run check
npm run test:stress
npm run build
npm run install:dev -- "/absolute/path/to/initialized-development-vault"
```

The installer does not enable the plugin. Reload Obsidian after rebuilding. `npm run dev` watches source. The desktop minimum of 1.13.7 matches the tested app; it is not a claim about older versions.

- [Development and release instructions](docs/DEVELOPMENT.md)
- [App test record](docs/TESTING.md)
- [Original PDF and Wacom research](docs/RESEARCH.md)
- [Roadmap](docs/ROADMAP.md)

Original code is MIT licensed. PDF-LIB and fontkit are bundled for writing; Perfect Freehand provides ink streamlining; Obsidian's PDF.js supports the persistent page surface, inspection and recovery preview. Upstream PDF.js is a test dependency only. The Noto fonts are SIL OFL licensed. [Third-party notices](THIRD_PARTY_NOTICES.txt) are embedded in `main.js`.
