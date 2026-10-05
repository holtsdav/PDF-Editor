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

### Further development

1. Broader PDFs, Windows/Linux, app versions and third-party plugin compatibility; benchmark large documents.
2. Move/resize existing boxes, change their font size, full edit undo/redo and durable pending-text recovery.
3. Checkbox/radio/select fields, validation flags and richer form semantics.
4. Font fallback and complex scripts; overflow indicators and improved appearance/layout fidelity.
5. More independent viewers, rotation combinations, malformed form trees and file-integrity testing.

Acceptance remains: values and appearances agree after reopening; no flattening/duplicate widgets/loss of unrelated data; conflicts stop stale writes; recovery works. Confirm minimum compatibility before public distribution.

## Later: Wacom ink

Add pointer capture, coalesced samples, pressure width, smoothing, erasing and undo/redo. Save standard ink annotations with appearances. Test actual hardware, OS and app build for pressure, dots/fast strokes, cancellation, buttons/eraser and zoom changes. Independently reopen/print output. Handwriting recognition is separate.

## Community submission

Broaden testing, validate ID/name/minimum version, make source and assets public when the owner chooses, publish a tested release and follow current Community submission requirements. Mobile is a separate target. XFA, signature workflows, OCR and collaborative editing remain outside this first version.
