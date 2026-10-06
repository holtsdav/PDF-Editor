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

### 0.4.0 direct editing and basic drawing — implemented

- [x] Existing text fields and added boxes accept a single click without selecting Text first.
- [x] Blank-space clicks keep ordinary PDF selection; explicit one-shot Text placement returns to Select.
- [x] Transparent yellow Marker and constant-width Scribble with width controls and Escape to exit.
- [x] Pointer capture, coalesced sampling, bounded simplification, horizontal Shift-marker strokes and tap-dot appearances.
- [x] Standard ink annotations with stable IDs, verified appearances, shared serialized saves and preservation of unrelated forms/annotations.
- [x] Selection/removal of owned marks and undo of new marks in the current session, including saved marks.
- [x] Contextual icon controls and always-available text overlays; native saved ink avoids double-painted transparency.
- [x] 40 automated tests; see the app test record for exact manual coverage.

### 0.5.0 persistent tools, text formatting and ink editing — implemented

- [x] Select is the default; Text, Pen, Marker and Eraser stay active until another tool is chosen.
- [x] Repeat-tap Pen/Marker palette with color and width choices.
- [x] Whole-field font/color/size controls appear only with selected text; bundled Sans, Serif and Mono fonts match saved appearances.
- [x] Select moves/deletes owned ink; constant-radius whole-stroke erasing and gesture-level undo retain stable IDs.
- [x] Verified durable drawing drafts; source PDF writes wait until drawing mode ends or an explicit save/close.
- [x] Public PDF.js backdrop excludes owned ink for display, preserving foreign annotations and preventing duplicate/ghost marks.
- [x] Hidden recovery storage, crash-resumable migration of all old copies, and read-only original preview.
- [x] Stable annotation toolbar height; 47 automated tests and actual macOS app checks described in TESTING.md.

### 0.6.0 persistent integrated editor — implemented

- [x] Plugin-owned PDF.js pages inside ordinary native PDF hosts; editing DOM survives normal vault saves.
- [x] Page navigation, fit width/zoom, rotation, selectable text, PDF links and page search.
- [x] Visible-page raster rendering with distant bitmap release and capped render resolution.
- [x] Fixed tool positions and a custom visual color/width/typeface/size popover, with persistent preferences.
- [x] Automatic PDF saves while tools remain active; reuse verified draft serialization for unchanged revisions.
- [x] Gesture ownership, preservation of interrupted pen points and reentrant pointer completion.
- [x] Undo/redo for text objects and ink, including saved edits; recovery storage explanation and sizes.
- [x] Model and preservation regressions; see TESTING.md for actual integration coverage and remaining limits.

### 0.7.0 selection and assisted ink — implemented

- [x] One-click text selection/movement, double-click/Enter editing and Backspace deletion.
- [x] Empty owned-box cleanup protected across views; remove deleted widget references before subsequent ink writes.
- [x] Embed height matches the editor; correct visible-page tracking and retryable queued rendering.
- [x] Aligned settings button as the single popover entry point; active-tool/settings re-click dismisses.
- [x] Perfect Freehand stabilization toggle with identical live and exported centerline geometry.
- [x] Highlighter hold-to-straighten; opt-in pen hold for single-stroke lines, rectangles, triangles, ellipses and arrows.
- [x] Inline PDF header rename using Obsidian's public file manager.
- [x] 63 regression tests; research and recognition limits in [INK_RESEARCH.md](INK_RESEARCH.md).

### 0.7.1 preview and rough-shape fixes — implemented

- [x] Default embeds fit a complete page at fit-width; explicit heights and full PDF tabs keep their sizing behavior.
- [x] Settings color indicator is anchored to its icon, with fixed grid columns for the width label.
- [x] Loop extraction tolerates short finishing tails; rounded polygon corners and uneven ellipses are accepted.
- [x] Five real rough-shape samples tested across size, rotation and direction, alongside rejection cases.

### 0.7.2 interaction fixes and line suggestions — implemented

- [x] Empty boxes remain protected through input-to-selection focus, Text/Select switches, movement, resize and formatting; leaving the whole box removes a blank.
- [x] Distinct exact-circle fitting and resizing snapped shapes while the pointer stays down, with bounded geometry and one undo action.
- [x] Local current-page answer-line suggestions; clicking creates a standard editable field, with existing widgets excluded.
- [x] Tests executing the actual editor event handlers, hold timers and persistence, plus detector rejection and transform cases. See TESTING.md for app coverage.

### Further development

The [2026-10-05 production audit](PRODUCTION_AUDIT.md) adds 88 passing regressions and four stress workloads. Single-session save/recovery safety is improved; remaining release gates include the external-writer race, damaged-source recovery UX, crash-resumable rename/index changes and large-file resource limits.

1. Broader PDFs, Windows/Linux, app versions and third-party plugin compatibility; benchmark large documents.
2. Persistent undo history, rich substring formatting and stronger recovery across multiple app processes.
3. Checkbox/radio/select fields, validation flags and richer form semantics.
4. Font fallback, complex scripts and further appearance/layout fidelity.
5. More independent viewers, rotation combinations, malformed form trees and file-integrity testing.

Acceptance remains: values and appearances agree after reopening; no flattening/duplicate widgets/loss of unrelated data; conflicts stop stale writes; recovery works. Confirm minimum compatibility before public distribution.

### 0.7.3 selection and detection refinement — implemented

- [x] Marquee selection from blank page space and additive Shift-click for mixed owned text/ink.
- [x] Shared group preview, page-edge clamp, keyboard nudge/delete and single-action undo/redo; authored/locked objects excluded.
- [x] Printed-text and editing-input drags preserve native selection; Escape, viewport changes and competing ink actions cancel group previews.
- [x] Rectangles and triangle baselines snap to page axes within eight degrees, retaining deliberate rotation and level geometry during held resizing.
- [x] Short regular dashes, lighter rules, label-tail trimming, crowded-line height and fitted text size; glyph-like baselines and one-sided table borders filtered.

### 0.7.4 full-document answer-line detection — implemented

- [x] Scan every page, including offscreen pages, with sequential bounded temporary rasters.
- [x] Per-page progress, cancellation and lifecycle guards for document replacement, failures and rapid restart.
- [x] Suggestions remain on their source pages and exclude existing fields. Detection alone does not write the PDF.

### 0.7.5 detected-answer interaction — implemented

- [x] Answer filling switches to Select, preserving direct typing without accidental blank-page text placement.
- [x] One-click editing of detected answers, Tab/Shift+Tab navigation across pages, widget reuse and locked-field exclusion.
- [x] Stable suggestion nodes while blank answers are removed, retaining the next mouse click.

### 0.7.6 answer lines within frames — implemented

- [x] Separate detached vertical frame fragments from inset answer rules at either endpoint.
- [x] Preserve connected/interior table crossing, wide-bar and occupied-heading rejection.
- [x] Regression geometry at two raster resolutions and several frame insets.

### 0.7.7 dotted rules and conservative footer filtering — implemented

- [x] Regular compact dots with distinct spacing/density checks; existing solid/dash recognition retained.
- [x] Skip matching wide PDF-declared decorative footer rules; keep ordinary bottom answers and ambiguous metadata.
- [x] Isolated PDF.js operator compatibility and cancellation/failure fallback tests.

## Later: Wacom input and richer ink

Build on constant-width ink, smoothing and session undo/redo with pressure width, partial-stroke erasing and rotation/scaling transforms. Cube/multistroke recognition needs stroke grouping and a labeled corpus. Test actual hardware, OS and app build for pressure, dots/fast strokes, cancellation, buttons/eraser and zoom changes. Independently reopen/print output. Handwriting recognition is separate.

## Community submission

Broaden testing, validate ID/name/minimum version, make source and assets public when the owner chooses, publish a tested release and follow current Community submission requirements. Mobile is a separate target. XFA, signature workflows, OCR and collaborative editing remain outside this first version.

### 0.7.8 ruled answer blocks and native plugin settings — implemented

- [x] Consecutive aligned blank rules form one editable multiline answer with printed line spacing and fixed geometry.
- [x] Fractional raster pitch fitting, occupied-row boundaries, normal text editing and block-level Tab navigation.
- [x] Verified layout persistence, source-write overflow rejection, movement/resize/undo and reopen coverage.
- [x] Native Obsidian settings for optional automatic detection on open and consecutive-line wrapping.

### 0.7.9 growing ruled answers — implemented

- [x] Extend ruled answers by whole rows, including below the last printed rule, with a stable top anchor and editable field ID.
- [x] Use embedded-font metrics in the shared session to preserve grown geometry through save and draft recovery.
- [x] Remove the completed detection summary, cancellation notice and no-result instructions; retain active progress and real errors.
- [x] Keep page bounds and the ordinary visible overflow warning; page-edge excess remains in the logical editable value.

### 0.7.10 immediate loading and PDF Editor name — implemented

- [x] Discover connected PDF hosts before native rendering, with disposable observers for main and pop-out windows.
- [x] Show the editor loading surface immediately, restore native rendering with a compact explanation on unsupported startup, and deduplicate host identities.
- [x] Rename the visible plugin to PDF Editor while retaining settings, installed ID and recovery compatibility.
- [x] Add a live 0–160 px PDF toolbar top offset for layouts shared with other plugins.

The current safety and Community directory gates are tracked in [Release readiness](RELEASE_READINESS.md).
