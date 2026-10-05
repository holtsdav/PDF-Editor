# Implementation roadmap

## 0.2.0 text development beta — implemented

- [x] TypeScript plugin, native compatibility adapter, version/build validation and private GitHub integration.
- [x] Read-only field inspector using Obsidian's PDF.js loader.
- [x] Fill existing editable text fields and create borderless AcroForm text boxes on printed worksheets.
- [x] Click placement, drag placement for multiline answers, new-field font size and removal.
- [x] Shared document sessions, serialized saves, stale-session checks and verified recovery copies.
- [x] Logical values/appearance verification, embedded Noto Sans and repeated saves without duplicate boxes.
- [x] Tested Reading view, Live Preview, PDF tabs, multiple embeds, pop-outs, zoom/scrolling and a rotated CropBox.
- [x] Independent PDF.js inspection and Poppler/pypdf verification.

See [TESTING.md](TESTING.md) for exact coverage and [README.md](../README.md#current-limits) for limits. Handwriting/pen diagnostics were removed from this text-only version.

## Next text milestones

### 0.2.1 refinement — implemented

- [x] Icon tools inside the native PDF bar; recovery/reload actions in an overflow menu.
- [x] Transparent text in all input states, matching the embedded font, with hover/focus outlines and drag feedback.
- [x] Owned multiline appearance spacing matches the editor and is independently checked through PDF.js and Poppler.
- [x] One original per PDF across reloads, one reusable restore slot, checksum checks and migration of the existing index.
- [x] Recovery PDFs excluded from editing to prevent recursive copies.
- [x] New recovery-policy tests and actual app verification in Reading view, Live Preview, PDF tabs and pop-outs.

### 0.3.0 Preview-style text boxes and stable editing — implemented

- [x] Adding a box updates only that widget; existing input elements and carets survive placement and zoom.
- [x] Automatic saves wait for focused inputs and placement gestures in all views of a document, including interactions that begin during save preparation.
- [x] Explicit Save/Done can flush a waiting automatic save; discard/reload cancels it.
- [x] Keyboard dialogs keep focus when a PDF save refreshes its native viewer.
- [x] Added boxes have eight blue handles, drag movement, keyboard movement/resizing and selected-box font size.
- [x] Automatic height growth preserves the caret; long words wrap in saved appearances.
- [x] Existing widgets retain IDs and editable form semantics when geometry changes.
- [x] Cmd/Ctrl+S works through Live Preview's shortcut handling; clean autosaves retain Saved status.
- [x] 34 automated tests; actual typing/saving checked in Reading view, Live Preview, PDF tabs and pop-outs. Mouse move/resize and tap placement checked in a pop-out; see the test record for narrower remaining gesture coverage.

The placement work was developed as 0.2.2, then included in 0.3.0 rather than released separately.

### Further development

1. Broader PDFs, Windows/Linux, app versions and third-party plugin compatibility; benchmark large documents.
2. Full edit undo/redo, durable pending-text recovery and text formatting.
3. Checkbox/radio/select fields, validation flags and richer form semantics.
4. Font fallback, complex scripts and further appearance/layout fidelity.
5. More independent viewers, rotation combinations, malformed form trees and file-integrity testing.

Acceptance remains: values and appearances agree after reopening; no flattening/duplicate widgets/loss of unrelated data; conflicts stop stale writes; recovery works. Confirm minimum compatibility before public distribution.

## Later: Wacom ink

Add pointer capture, coalesced samples, pressure width, smoothing, erasing and undo/redo. Save standard ink annotations with appearances. Test actual hardware, OS and app build for pressure, dots/fast strokes, cancellation, buttons/eraser and zoom changes. Independently reopen/print output. Handwriting recognition is separate.

## Community submission

Broaden testing, validate ID/name/minimum version, make source and assets public when the owner chooses, publish a tested release and follow current Community submission requirements. Mobile is a separate target. XFA, signature workflows, OCR and collaborative editing remain outside this first version.
