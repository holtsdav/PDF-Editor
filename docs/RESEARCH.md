# Research: editing PDFs inside Obsidian notes

Research date: **2026-10-05**. This document separates verified library capabilities from proposed implementation choices and hardware behavior that still needs testing.

Implementation update **0.7.6**: the raster gap tolerance can join an inset answer rule to a nearby vertical frame. The detector now removes only a narrow vertical endpoint fragment separated from the rule by a real white gap. Connected/interior crossings and wide persistent borders remain excluded; the remaining rule still passes the existing text, spacing and density filters. No persistence changes.

Implementation update **0.7.5**: choosing a detected line activates Select and focuses the answer rather than arming free-text placement. Detected answers reopen with a single click; Tab/Shift+Tab traverses detected targets in page order, reusing overlapping editable widgets and skipping read-only fields. Suggestions keep their DOM identity across session updates so blank-answer cleanup during pointerdown cannot swallow the following click. Targets remain transient; no PDF metadata format changes.

Implementation update **0.7.4**: answer-line detection now visits every PDF page sequentially, independent of the visible page. One temporary raster is released after each page; navigation remains available. Cancellation, document replacement and render failures discard partial suggestions, and stale scan completions cannot change a new scan. Detection remains a local heuristic and creates no fields until a suggestion is clicked.

Implementation update **0.7.2**: blank-box focus now spans selection, movement and resizing; snapped shapes can resize while held, with exact circles distinct from ellipses. **Detect answer lines** scans the current page locally in canonical orientation with a bounded raster, proposes blank-line regions and creates standard editable fields only after a click. It filters existing widgets, thick rules, occupied headings and vertical table crossings. This is a heuristic, not Apple's model, contact AutoFill or OCR; skewed/noisy scans and table cells remain limited. Apple documents field highlighting and filling through Preview's Form Filling action, but does not expose that implementation as an Obsidian JavaScript API. [Apple Preview form filling](https://support.apple.com/guide/iphone/fill-out-and-sign-pdf-forms-iphd7e3c0c74/ios).

Implementation update **0.7.1**: default embeds now fit a complete page; the settings indicator is anchored to its icon. Rough-shape regressions now include the rejected hand-drawn worksheet examples, with bounded loop extraction and fitting tolerance for rounded corners. See [the correction and evidence](INK_RESEARCH.md#071-correction-from-real-drawing-feedback).

Implementation update **0.7.0**: selection and text editing are separate interactions; empty owned boxes are pruned after editing. Embed sizing and page render bookkeeping are corrected. Header rename uses the public file manager. Smooth ink uses Perfect Freehand centerline streamlining, and conservative draw-and-hold recognizes a small single-stroke shape set. These are not handwriting rewriting/OCR or cube recognition. Read [the primary-source research and decisions](INK_RESEARCH.md) before expanding assistance. The historical architecture notes below do not override current README behavior.

Implementation update **0.6.0**: native-host discovery is retained, but the visible PDF pages are now owned by a persistent PDF.js surface. Normal vault writes may refresh Obsidian's hidden viewer without replacing editing DOM. A single display copy excludes editable text widgets and owned ink; the live layers paint those objects. Rendering is limited to nearby pages. The former native-canvas replacement backdrop was removed. Text and ink now autosave without requiring a tool switch, and the verified candidate is reused for a matching revision. These changes supersede the 0.5.0 rendering/save-batching descriptions below. See TESTING.md for verification limits.

Implementation update: **0.5.0 implements direct text formatting and constant-width ink editing**, with native overlays and icon tools, movable/resizable boxes, automatic wrapping and height growth, PDF-LIB writing, embedded Sans/Serif/Mono fonts, hidden original/restore recovery copies and durable pending drafts, serialized saves, interaction-aware automatic writes and conflict detection. Printed worksheets receive editable AcroForm text fields; the proposed FreeText path below was not selected. Existing fields accept a direct click, while new boxes require explicit placement. Wacom remains future research. See [the app test record](TESTING.md) and [current limits](../README.md#current-limits). The original proposals below are historical, not a list of completed features.

## Implemented marker and scribble format

Both tools store standard `/Subtype /Ink` annotations with stable `/NM` IDs, page-local `/InkList` coordinates, color, width, print flags and normal appearance streams. Marker defaults to yellow with 0.4 opacity and a Multiply blend mode; Pen defaults to an opaque dark line. Both offer palette colors and fixed width choices. A marker is a freehand visual highlight, not a semantic `/Highlight` annotation anchored to selected text. This follows the PDF ink model and the appearance approach used by upstream PDF.js's freehand highlighter. [PDF annotation specification](https://pdf-issues.pdfa.org/32000-2-2020/clause12.html), [PDF.js 5.3.31 annotation writer](https://github.com/mozilla/pdf.js/blob/v5.3.31/src/core/annotation.js).

Pointer capture collects coalesced samples where available. Simplification preserves endpoints/corners, and taps have a visible dot appearance. Shift locks marker strokes horizontally in the displayed viewport. Obsidian's tested viewer bakes saved ink appearances into its page canvas. A verified display-only PDF copy removes owned ink, then Obsidian's public PDF.js loader renders a stable backdrop with foreign annotations retained. SVG paints each owned mark once. The native toolbar, links and text selection stay available; the adapter isolates native page access. Public PDF.js `ownerDocument` routes fonts to the correct pop-out document. Native viewer resets can remove plugin DOM, so the backdrop recreates detached canvases through its lifecycle. [PDF.js document/render API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html).

Text and ink share one document session and serialized writer. Before modifying a vault file, serialized bytes are reopened to verify stroke IDs, points, styles, bounds and appearance resources alongside form values and appearances. Tests also parse annotation/operator data with an independent PDF.js version. Unrelated annotations and editable forms are preserved. Undo covers owned ink creation, movement, deletion and whole-stroke erasing, grouped by gesture with a 50-action session limit. Foreign ink editing, pressure, smoothing, partial erasing and complete undo/redo remain future work.

## Implemented save batching and hidden recovery

Overwriting a vault PDF makes the tested native viewer reload the file and its page canvases. Saving after every stroke therefore caused a white flash. Version 0.5.0 keeps the drawing interaction open while Pen, Marker or Eraser is active, updates SVG immediately, and checkpoints a verified complete candidate into a hidden recovery journal after a short idle delay. Selecting Select, leaving the editor or explicitly saving commits the queued changes to the actual PDF. An explicit commit can still refresh the native viewer. The source file remains unchanged during drawing mode; the tooltip distinguishes a verified local draft from edits that have not yet finished checkpointing.

Recovery now lives under the vault's configured Obsidian folder at `plugins/pdf-form-studio/recovery`. It retains one original and a bounded before-restore slot, plus the current draft and its previous complete checkpoint. Baseline hashes block a recovered draft from overwriting an externally changed source. A migration receipt permits recovery after an interrupted move/index update; all files from the old visible backup folder are moved, including older unindexed copies. Original recovery previews render read-only through public PDF.js. These hidden drafts are local recovery, not a replacement for syncing the saved source PDF. See [current recovery behavior](../README.md#recovery) and [verification](TESTING.md).

## What the requested workflow requires

The screenshot shows a worksheet embedded in a note, with blank answer lines and table cells. It does not reveal whether those regions are interactive form fields. A blue region could be a form widget, selection, or another overlay; pixels cannot identify the PDF's field structure. The source PDF was not supplied, so its actual form type remains unverified.

There are three distinct cases:

| Document/input | What should be saved | Proposed interaction |
| --- | --- | --- |
| Existing AcroForm | Canonical field values plus updated widget appearances | Click an existing text field or checkbox |
| Printed/scanned worksheet | PDF FreeText annotations, or newly created AcroForm fields | Choose Text, click the answer line, type |
| Handwriting on either kind | PDF ink annotations with appearance streams | Choose Pen, draw directly over the page |

Handwriting recognition is a separate optional feature: preserving ink does not convert it into typed text. Automatic line detection and OCR also belong after a manual placement workflow works reliably.

PDF-LIB documents form creation/filling and explicitly excludes XFA field support. Its page-drawing API can add visible content, but that alone does not create editable annotations. [PDF-LIB examples](https://pdf-lib.js.org/), [PDFForm/XFA documentation](https://pdf-lib.js.org/docs/api/classes/pdfform).

## How Obsidian plugins are built

Plugins are TypeScript/JavaScript classes extending `Plugin`. Obsidian loads a CommonJS `main.js` with a root `manifest.json` and optional `styles.css`. The official sample uses esbuild, registers commands and UI, and provides development-vault instructions. We follow that structure with a smaller runtime and project-specific diagnostic commands. [Official sample](https://github.com/obsidianmd/obsidian-sample-plugin), [build guide](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin).

The manifest holds the stable plugin ID, display name, version, minimum app version, description, author, and desktop flag. The ID must match the installed folder. This project uses `pdf-form-studio` and a provisional minimum of 1.13.7, the stable desktop release returned by the official release feed during research. We must validate actual app compatibility before distribution. [Manifest reference](https://docs.obsidian.md/Reference/Manifest), [desktop release feed](https://github.com/obsidianmd/obsidian-releases/blob/master/desktop-releases.json).

Public API building blocks verified in Obsidian's type declarations:

- `loadPdfJs()` loads the bundled PDF.js library.
- `Vault.readBinary()` and `Vault.modifyBinary()` read and replace vault file bytes.
- Markdown postprocessors, render children, editor extensions, commands, modals, and workspace events provide UI and lifecycle integration.

The current public declarations do not offer a typed native PDF viewer editing API. Accessing an embedded viewer instance or its page lifecycle is a separate compatibility problem; having the public PDF.js loader does not solve it. [API declarations](https://github.com/obsidianmd/obsidian-api/blob/06b4f1b0a58cfa01d02919a4ba35b92087046c18/obsidian.d.ts).

## Native viewer versus a separate viewer

**Recommendation: first prototype a small adapter around the native PDF viewer**, because the requested interaction happens in an ordinary PDF embed inside a note. Keep renderer-specific access separate from the PDF document model and saving service.

PDF++ demonstrates extending native PDF views and embeds, including optional writes to PDF files. Its maintainer explicitly notes reliance on private Obsidian APIs. Its type declarations also document a viewer structure change at Obsidian 1.8.0. These are useful feasibility evidence and a reason to isolate and test the adapter. PDF++'s documented editing features cover highlights and links; this research does not establish that it already supplies the requested form and pressure-aware ink workflow. [PDF++ repository](https://github.com/RyotaUshio/obsidian-pdf-plus), [viewer typings](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/typings.d.ts).

The current community **Better PDF Plugin** provides embedding, scaling, rotation, and page cutouts. “PDF Form Studio” is a working name to avoid confusion. Neither naming nor an unused legacy plugin-list ID guarantees that a name is available in the current Community directory. [Existing Better PDF Plugin](https://github.com/mszturc/obsidian-better-pdf-plugin).

Proposed adapter responsibilities:

1. Discover a viewer/embedded PDF and its vault `TFile` once it is ready.
2. Mount controls and a page-local editor layer, while respecting text selection and scrolling in View mode.
3. Obtain the page viewport and observe page render, zoom, rotation, and disposal.
4. Restore scroll/page state after a successful save and refresh all open copies of that PDF.
5. Dispose listeners, observers, overlays, and pending work on view removal or plugin unload.

A standalone PDF.js viewer in a custom view or code block is the fallback if the native adapter proves too fragile. It trades a more controlled editor for extra rendering/worker assets and a different note experience. Reading view, Live Preview, PDF tabs, and pop-out windows each need an explicit compatibility experiment.

## PDF.js form and annotation persistence

PDF.js exposes field discovery, per-page annotations, annotation storage, and `PDFDocumentProxy.saveDocument()`, which returns PDF bytes. Its upstream viewer has text and ink editing controls. These capabilities make the requested workflow plausible, but they must be checked against Obsidian's actual build and viewer configuration. Returning bytes does not save a vault file automatically. [PDFDocumentProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html), [upstream editing controls](https://github.com/mozilla/pdf.js/blob/master/web/viewer.html).

Obsidian maintains its own PDF.js distribution. The inspected `dist/lib/pdf.min.mjs` reported **5.3.34**, while the test harness uses upstream **5.3.31**. This is evidence about the published distribution, not a measurement of the user's running app. Its capabilities can differ from current upstream 6.x. The diagnostic modal displays the actual loaded library version. [Inspected distribution snapshot](https://github.com/obsidianmd/pdfjs/tree/b0029ea31bb2c94c18c49c29e51ff930578f8d24).

**Proposed first writing route:** use the viewer document's form annotation storage for existing AcroForms and evaluate its bundled editor manager for FreeText/Ink. Serialize through that same document, then write the returned bytes through the vault API. Do not mix independent PDF.js and pdf-lib models in one edit session: a stale document can overwrite another writer's changes.

**Alternative writer:** use pdf-lib for form values, new form fields, and embedded Unicode fonts. PDF++ uses the Cantoo fork for direct annotations, with low-level dictionary construction rather than a high-level annotation creation API. We should compare preservation behavior and maintenance before selecting that route for Ink/FreeText. [PDF++ writer source](https://github.com/RyotaUshio/obsidian-pdf-plus/blob/main/src/lib/highlights/write-file/pdf-lib.ts), [Cantoo fork](https://github.com/cantoo-scribe/pdf-lib).

## Proposed editing and save design

The following are engineering decisions to implement and validate, not features of this scaffold:

- **Explicit modes:** View, Form, Text, Pen, Eraser. Text placement on a printed worksheet begins at the clicked point; a dragged rectangle supplies multiline width/height.
- **Page coordinates:** convert client coordinates relative to the page into PDF coordinates using the PDF.js viewport transformation. Store page-local geometry, never screen pixels. Rotation, CropBox offsets, zoom, device scale, and resized embeds must all be tested.
- **Editable output:** use standard annotations with stable IDs and appearance streams. Default to preserving form interactivity. Flattening is an explicit export operation; repeated typing must update existing items rather than append duplicates.
- **Text rendering:** support German umlauts and other Unicode with an appropriate embedded, redistributable font; test baseline placement, wrapping, and clipped appearances.
- **Saving:** show an unsaved/saving/saved/error indicator. Start with explicit Save, then add a short idle/blur commit for typing and a stroke-end commit for ink. Avoid rewriting the whole PDF for every pen sample.
- **File integrity:** serialize writes per PDF, compare the current bytes with the edit session's baseline, and create a recoverable original before first overwrite. Reopen serialized bytes to verify structural validity and expected changes before replacing the file.
- **Concurrency:** detect changes by another embed, PDF++, sync, or an external editor; stop and offer reload rather than silently overwrite. A pre-write comparison is not an atomic compare-and-swap: the public binary API leaves a race that must be considered and documented.
- **Unsupported documents:** leave encrypted, XFA, digitally signed, and unsupported malformed files read-only until a defined workflow exists. A signature widget alone does not prove a cryptographic signature. Do not bypass PDF encryption or remove XFA data as a shortcut.

Both canonical AcroForm field data and page widget appearances must be checked after saves. A rendered answer can look correct while the logical field value remains wrong. Ink and text must reopen in an independent viewer, remain editable where supported, and appear when printed.

## Wacom handwriting feasibility and setup

**Recommended input route: Web Pointer Events**, using the installed Wacom driver. Pointer events expose device type, pressure, tilt, and pointer capture. Coalesced events can improve stroke sampling when available. Mouse-like drivers may still allow constant-width drawing, but pressure and eraser behavior cannot be assumed. [PointerEvent API](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent), [coalesced events](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents).

Pressure is normalized to 0–1; devices without pressure support can report 0.5 while a button is active. A changing pressure range on pen strokes is useful evidence; a constant 0.5 is not proof of pressure support. The diagnostic pad reports received values without claiming driver or hardware compatibility. [Pressure documentation](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pressure).

Suggested local setup:

1. Install a Wacom driver that explicitly supports the tablet model and OS.
2. Use Pen mode, map to the monitor containing Obsidian, and choose an appropriate active area. Wacom recommends Pen mode and documents absolute mapping. [Wacom mapping](https://101.wacom.com/userhelp/en/MappingAdvanced_Full.htm).
3. Keep the pen tip assigned to Click; adjust tip sensitivity using the driver's test area. Configure app-specific pen buttons/ExpressKeys for Undo, Pen/View toggle, and an eraser action once those commands exist. [Wacom pen settings](https://101.wacom.com/userhelp/en/Pen_Con_Full.htm).
4. On macOS, follow Wacom's guide for the actual OS version and grant the requested driver permissions, including Accessibility and Input Monitoring where required. This does not imply the plugin needs native input-monitoring privileges. [Wacom macOS setup](https://support.wacom.com/hc/en-us/articles/4411693955095-Setting-up-the-Wacom-driver-with-macOS).
5. On Windows, begin with Windows Ink enabled, as Wacom documents it as the default. Windows Ink can also provide system handwriting-to-text tools; that is separate from saving PDF ink. [Windows Ink setup](https://101.wacom.com/userhelp/en/PenDigitalInkWindows_Full.htm).
6. Run **Test pen input** inside Obsidian with light and heavy strokes. Record tablet/driver/OS, app and installer versions, input type, pressure range, and eraser behavior.

Proposed ink implementation: collect page-local points and pressure, draw a low-latency preview, then simplify/smooth the committed stroke. Pressure-dependent width requires an appearance representation that reproduces the preview; a basic constant-width InkList alone is insufficient. Keep original stroke geometry in the PDF-compatible annotation model where possible. Test tap dots, cancellation, pointer capture loss, palm/touch rejection, and eraser buttons. The current pad is a hardware probe, not the final stroke engine.

A Wacom native SDK is not needed for this first feasibility test. Consider one only if real hardware tests show required capabilities cannot reach Electron's pointer events; that would add native packaging and platform-specific maintenance.

## Community distribution

The current official submission guide uses **community.obsidian.md**, with an Obsidian account linked to GitHub. It requires accessible source, a root README/LICENSE/manifest, and a release whose exact `x.y.z` tag matches the manifest, with `main.js`, `manifest.json`, and optional CSS attached. The sample README still mentions the older obsidian-releases PR process; use the current submission guide when ready. A private development repo is fine now, but public distribution requires accessible source and release assets. [Current submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin).

Before submission, use an accurate minimum app version, remove sample behavior, keep descriptions concise, and declare desktop-only when using desktop APIs. We start with a desktop testing scope and can revisit mobile after the editor is stable. [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).

## Remaining evidence needed

- The actual worksheet PDF: canonical fields, widgets, encryption/signatures, text layer, and page geometry.
- The user's Obsidian app/installer versions and Wacom model, driver, and target OS.
- Native embed access and annotation editing behavior in a disposable vault.
- Save/reopen behavior across independent viewers and concurrent editors.
- Actual pressure, tilt, eraser input, and acceptable drawing latency inside Obsidian.

The scaffold intentionally makes the first document and hardware checks executable before implementing PDF writes.
