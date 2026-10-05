# Implementation roadmap

The requested destination is an ordinary PDF embedded in a note: click an answer line, type or draw, and see the PDF itself retain the result outside Obsidian.

## Prepared foundation

- [x] TypeScript plugin, manifest, desktop scope, and esbuild bundle.
- [x] Read-only PDF field/widget inspector using the public PDF.js loader.
- [x] In-app pen input test pad.
- [x] Upstream PDF.js integration tests with generated PDFs.
- [x] Development-vault installer, version synchronization, and artifact validation.
- [x] GitHub CI and draft release workflows; research and contributor documentation.

## 1. Verify the native embed adapter

Prototype controls on an ordinary `![[worksheet.pdf]]` embed. Determine actual viewer/document access and bundled editor capability. Keep all undocumented access in one adapter. Use a disposable vault with the source worksheet and anonymous samples.

Acceptance: overlay alignment survives zoom, rotation, scrolling, resizing, Reading view, Live Preview, PDF tabs, two copies of the same file, and pop-out windows. Plugin unload removes controls/listeners. Unsupported viewer versions retain a usable read-only viewer and report the unsupported editing state.

## 2. Existing form fields and reliable saves

Expose text fields, checkboxes, radio groups, dropdowns, multiline text, required/read-only flags, and keyboard navigation. Implement one document session and save queue per vault PDF, recoverable originals, conflict detection, and save status. Evaluate PDF.js serialization before adding another writer.

Acceptance: saved field values and widget appearances agree after reopening; no flattening, no duplicate widgets, no loss of unrelated annotations/pages/metadata. German umlauts render correctly. Rapid edits and two open embeds do not overwrite each other. Save failure leaves the original available. External changes interrupt the stale session.

## 3. Printed worksheet typing

Add Text mode with click-to-type and drag-to-place multiline areas. Use editable FreeText annotations initially; evaluate creating AcroForms as an optional “make this worksheet fillable” operation. Use stable item IDs, font embedding, and explicit save/undo behavior.

Acceptance: answers align with a clicked line/cell at different zoom levels, can be edited/moved/deleted, and remain visible after Obsidian reload, external reopening, and printing. Repeated saves update existing content.

## 4. Wacom ink

Add Pen/Eraser modes, pointer capture, coalesced samples, optional pressure width, smoothing, stroke grouping, and undo/redo. Serialize standard ink annotations with appearances matching the preview. Fall back to a selectable constant width if pressure is unavailable.

Acceptance: test on a real Wacom device in the target OS and Obsidian build. Verify light/heavy strokes, dots, fast curves, eraser/buttons, accidental touch, cancellation, and changes of zoom mid-session. Output survives independent viewer reopening and printing; erasing does not destroy page content.

## 5. Community beta and submission

Validate the minimum app version and the current plugin ID/name availability. Complete independent viewer and file-integrity checks, explain backups and limitations, make the source/distribution accessible, and publish a tested release. Submit through the current Community directory workflow. Revisit mobile as a separate tested target.

First release excludes XFA editing, handwriting recognition, automatic OCR/line detection, certified/signature workflows, and collaborative editing. These are later candidates after the core document persistence is trustworthy.
