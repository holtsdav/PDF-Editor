# App test record

## Version 0.7.11 public-beta preparation — isolated app pass

The current source adds recovery storage size/folder controls, guarded cleanup, non-overwriting verified-draft export, a default-on toggle for original copies on PDFs without an existing copy, a 25-page default automatic detection limit, 100-page sections for manual detection, and narrower fast-scroll work with distant render/text release. `npm run check` passes **173 tests**, lint, TypeScript, production build and metadata validation. All four stress workloads pass, including 120 pages and 1,200 long strokes; the 24 MiB image workload still reaches roughly 1.27 GiB peak RSS in the isolated Node process. Automated tests cover export against a damaged source, cleanup after a saved session, rejection of pending/orphaned drafts, toggle behavior and preference validation, scan-button placement, manual section boundaries and retained suggestions, distant-render cancellation and nearby-page selection after a fast scroll.

On 2026-10-06, the 0.7.11 build was installed and enabled in a disposable scratch vault in Obsidian 1.14.4 on macOS. The settings panel showed the 25-page limit and recovery usage; **Open folder** opened the hidden recovery directory in Finder. With automatic detection enabled, a 32-page PDF displayed the limit skip message. Direct navigation from page 1 to 32 and back rendered the selected page. A newly authored text answer was saved; independent PDF-LIB inspection of the source confirmed its value, and the hidden directory contained one `original.pdf`. The scratch test did not exercise the clear button, damaged-source export, a long continuous wheel-scroll trace, or memory measurement inside Obsidian. External-writer coordination and interrupted rename reconciliation remain open.

An earlier 0.7.11 build was copied into that disposable vault and the plugin was disabled and re-enabled to load it. The beta safety-copy explanation and default-on **Keep original copies for new PDFs** toggle appeared in Obsidian. Switching it off persisted `false` while the existing indexed original remained on disk; switching it on persisted `true` again. The UI deletion action was not exercised. The automated vault test covers an actual save with new-original creation disabled and the effect of clearing copies while disabled.

An earlier **PDF backups** Settings section was rebuilt, installed and reloaded in the same scratch vault. A visual check confirmed Obsidian's default indented heading, no introductory paragraph, and the toggle, folder, storage count and delete descriptions. The UI deletion action was not exercised. A context-free Luna review of the subsequent wording explained the one-copy policy, retained copies and deletion correctly and rated it 9/10 for clarity. The final wording appeared in the isolated Settings page. A clean scratch-vault reopen showed the scan button immediately after Add text box, with no header copy. That reopen exposed a startup error when Obsidian's root document was still null. The compatibility adapter now tolerates that state, with a regression test; the corrected build reopened with one styled editor surface.

On 2026-10-07, the scan button gained an active state during scanning and after automatic scans, including zero-match scans. A regression verified the on/off state. The dotted-line pass now accepts regular dots spaced 12 points apart while the punctuation, stem and occupied-leader rejection tests remain green. A generated three-row PDF rasterized with PDF.js at the plugin’s 1.5× scan scale yielded all three rows (6-, 8- and 12-point spacing). A clean scratch-vault reopen loaded the current build: automatic scanning highlighted the button and found all three dotted rows. Clicking the button cleared the suggestions and inactive state; clicking again restored all three and the active state. No PDF edits were made. The build was also installed over the prior build in the primary vault, preserving its settings and recovery folder. After re-enabling only PDF Editor, an open PDF showed the scan button beside Add text box in its active state; no main-vault PDF was edited during this check.

The user then reported a missed dotted-rule pattern in an existing six-page PDF. A local PDF.js raster at the plugin’s 1.5× scan scale reproduced zero matches on its relevant page with the old detector. Its dots produce a repeated short-short-long pixel gap, so the revised detector checks for a periodic ink pattern when simple dot spacing fails. The same page now yields all seven visible answer rules; three additional rules on another page also remain available after decorative-footer filtering. A synthetic two-resolution regression covers this raster pattern. After installing the checked build in the primary vault, the app showed six available suggestions on the relevant page alongside one occupied answer line. No PDF edit was made as part of this verification. The PDF and rendered images remain outside Git.

The reported page also exposed a grouping miss: its three upper and four lower dotted rules had wider pitch and small raster-end offsets. The revised grouping creates a three-row and a four-row block from those anonymous page rectangles, while the existing question-gap and occupied-line tests still pass. Clicking a neighboring suggestion can extend a single detected answer into a ruled block without replacing its field ID or text; a UI test verifies save, undo and redo. After that build was reloaded in the primary vault, saved answers remained visible and the PDF reported Saved. A manual scan activated the toolbar button. A user screenshot then showed a two-row block still leaving the third line separate and Obsidian displaying the suggestion's accessible name as a hover tooltip. The current code extends a saved ruled block onto a neighboring line, with a regression using the reported anonymous geometry, and hides Obsidian tooltips while the pointer is over PDF pages. Floating controls and copy/paste/duplicate have automated coverage.

The first main-vault app pass for floating controls showed the setting and checked PDF-menu item, but the fixed header and tools were clipped by the embedded viewer after note scrolling. The corrected build moves both rows into the window body while floating and returns them to the PDF when it reaches the top or leaves view. Its regression verifies the move, placement and return. The checked build was installed and reloaded in Obsidian 1.14.4/macOS; the PDF reported Saved, and a screenshot showed both toolbar rows at the visible top while the note was scrolled into the PDF. The main-vault PDF was not edited during this check. Copy/paste/duplicate and tooltip suppression still need an app interaction pass; their automated tests pass.

A subsequent `npm audit --omit=dev --audit-level=high` completed against npm's registry and found zero production dependency advisories.

## Toolbar top offset and release review

Checked on 2026-10-06. `npm run check` passes **155 tests**, lint, TypeScript, production build and plugin validation. Preferences tests cover the default, valid value and rejection of invalid/out-of-range stored values; the surface test checks initial application, live updates and listener disposal. `npm run test:stress` passes all four workloads; the 24 MiB image workload still shows notable latency and process memory use. A fresh `npm audit` could not complete because the terminal could not reach the npm registry.

The checked 0.7.10 build was backed up, installed into the existing local vault and reloaded in Obsidian 1.14.4/macOS. The native PDF Editor settings panel showed the 0–160 px slider at 0; moving it to 96 visibly moved both PDF header/tool rows down and left the document visible. The local preference was left at 96 px after verification. Installed plugin asset hashes matched the build. Other themes, window sizes, embeds and platforms were not rechecked for this setting.

See [Release readiness](RELEASE_READINESS.md) for the current safety and publication gates.

## Version 0.7.10 immediate editor loading and rename

Checked on 2026-10-06. `npm run check` passes **151 tests**, lint, TypeScript, production build and plugin validation. New regressions execute the compatibility adapter and real surface constructor with delayed session startup. They cover early host discovery and deduplication, pre-paint mutation delivery, exclusion of plugin-only mutations, observer/event disposal, pop-out creation/closure, immediate native-chrome hiding, and unsupported startup restoring native chrome with hidden custom navigation and a compact message.

An anonymous twelve-page fixture opened in Obsidian 1.14.4/macOS Reading view, Live Preview, a standalone PDF tab and a pop-out with the custom navigation and page content. The first opening snapshot after explicitly reloading the updated plugin showed its loading UI without native navigation. A signature-widget fixture restored the native viewer; a visual fallback check exposed the old surface's full-height styling and hidden-navigation override, which were corrected and covered by the regression. The final fallback displayed the native page and a compact read-only explanation. These checks and DOM timing tests do not establish frame-by-frame behavior on every Obsidian version. Other editing gestures and persistence workloads were not rerun for this loading/branding change.

Version 0.7.10 assets were backed up, installed and explicitly reloaded in the test and main vaults. Community plugins and the native settings page confirmed PDF Editor. Main-vault asset hashes match the build, and all 5 settings/recovery files matched their pre-install checksums. The app was returned to the user's main-vault note.

The display name is PDF Editor and version 0.7.10. The installed ID remains `pdf-form-studio`; existing settings and recovery paths are retained. Historical test records and the legacy backup folder keep their original names.


## Version 0.7.9 growing ruled answers and quiet detection

Checked on 2026-10-06. `npm run check` passes **147 tests**, lint, TypeScript, production build and plugin validation. `npm run test:stress` passes all **four existing workloads**. Added/updated regressions cover extra explicit and automatically wrapped rows, independent PDF.js appearance baselines, stable IDs through repeated saves/reopen, grown draft recovery, font-size changes, CropBox/fractional-pitch page bounds, undo/redo of text with its geometry, caret/input identity, and rounded browser measurements without spare rows or false overflow warnings. Detection tests retain full-document, cancellation/restart, unavailable metadata and render-failure assertions while requiring an empty completion banner.

An anonymous five-rule worksheet in Obsidian 1.14.4/macOS Reading view accepted nine pasted rows followed by a normally typed tenth row. Explicit Save showed Saved while focus and all ten visible text rows remained intact below the five printed rules. Independent PDF-LIB/PDF.js inspection retained one editable field and ten appearance rows at the original 24pt pitch. A first app pass exposed an unnecessary spare row; a second pass confirmed exactly ten stored rows, but exposed a false overflow warning at fractional zoom. Whole-row measurement comparisons fix both, with a focused DOM regression. The final warning correction passed the full automated checks; it was not rechecked interactively while the user was working in the main vault. Other view contexts and gestures were not rerun for this change.

Version 0.7.9 assets were backed up, installed in the main vault and loaded after a normal restart, confirmed in Community plugins settings. Installed asset hashes match the build; plugin settings and recovery files matched the pre-install snapshot. The app was returned to the user's main-vault document.

The former printed-row capacity save error is removed. Growth stops at the physical page edge, where the editor still warns about visible overflow and saves the complete logical editable value. It does not add PDF pages, move other printed content or create new printed rules. Other PDF editors can regenerate field appearances with their own wrapping/spacing. This remains a development beta with the existing production-audit and compatibility limits.

## Version 0.7.8 ruled answer blocks and native settings

Checked on 2026-10-06. `npm run check` passes **142 tests**, lint, TypeScript, production build and plugin validation; all **four stress workloads** pass. New tests cover grouping from any row, occupied-row/column/page/question-gap boundaries, long fractional-pitch blocks at three raster resolutions, preference defaults and type validation, fixed geometry during typing, setting-disabled independent fields, block-level Tab navigation, independent PDF.js appearance spacing, one logical editable value, repeated saves, reopening/recovery, overflow/source preservation, font-size overflow, moves, deliberate resizing, undo and deletion. A read-only raster check of a real worksheet retained its separate nine-, six- and nineteen-row blocks after correcting cumulative pixel-spacing drift.

In Obsidian 1.14.4/macOS, the native PDF Form Studio settings page displayed both toggles. Enabling automatic detection in the test vault made a newly opened two-page Reading embed suggest all twenty blank rows without pressing Detect. Clicking a row created one five-row block, and a pasted paragraph visibly wrapped above successive printed rules without growing. Native typing and Backspace, saving, then Tab into a separate five-row answer block passed. Independent PDF-LIB parsing retained exactly two editable fields with five-row/24pt layout metadata and fixed 114pt heights; note Markdown stayed unchanged. Entering six lines in a five-row block produced the explanatory save error, retained all text in the editor and left the saved PDF byte-for-byte unchanged; correcting the answer allowed saving again.

Saved answers reopened for one-click editing in Live Preview and a PDF pop-out. New PDF-tab and pop-out surfaces automatically detected the ten remaining blank lines on page two. A 90-degree rotation and zoom change retained alignment with the printed rules. These checks do not establish every formatting, IME or accessibility behavior in every context. The final fractional-pitch correction was verified with automated raster regressions and the actual worksheet, after the anonymous app interaction pass.

Main-vault assets were backed up and installed as 0.7.8. After the app stopped responding to settings commands following a vault switch, a normal restart loaded the update and its native settings page was confirmed. Automatic detection remains off and line grouping on by default; plugin settings and recovery checksums match the pre-install snapshot.

Blocks are conservative groups on one page, and existing filled/authored fields are never merged. Deliberate resizing converts a block to ordinary wrapping. The complete value remains standard editable AcroForm text, with custom spacing in its saved appearance; other PDF editors may regenerate their own spacing. Overflow stays in the open editor and cannot be checkpointed or written until corrected, so no crash-recovery claim is made for excess unsaved text. Detection and production-audit limitations remain.

## Version 0.7.7 dotted answers and decorative footer rules

Checked on 2026-10-06. `npm run check` passes **132 tests**, lint, TypeScript, production build and plugin validation. New regressions cover regular compact dots at two raster resolutions, gray dots, mixed line styles, punctuation/stem/occupied-leader rejection, overlapping solid/dotted raster edges without merging adjacent answers, actual PDF.js Artifact path extraction, nested marks and transforms, unknown metadata layouts, unavailable metadata and cancellation during metadata lookup. The supplied dotted-line screenshot yields all seven answer rows locally, including the lowest row.

An anonymous two-page fixture on Obsidian 1.14.4/macOS contains seven dotted rules, a wide untagged answer below a tagged decorative footer and a second page containing only a footer. Reading view and Live Preview each reported eight suggestions on one of two pages; the bottom answer had an outline while the decorative rule above it did not. Clicking two dotted suggestions in succession and saving retained exactly two editable fields with the expected values, checked independently with PDF-LIB; note Markdown remained unchanged. PDF-tab and pop-out scans then returned the six remaining suggestions on one of two pages.

Main-vault assets were backed up, installed and reloaded as 0.7.7. A real worksheet check retained its three framed answer lines and excluded the reported page-two decorative footer. That pass exposed two overlapping outlines over one underscore rule; overlap deduplication and a regression corrected it. The final rebuilt scan returned twelve suggestions on three of four pages, with one outline over that answer and none over the footer. Source PDF, plugin settings and recovery checksums were unchanged. The original note was reopened after verification.

Footer exclusion requires a matching wide, flat bottom rule explicitly marked as a PDF Artifact. Position alone does not suppress an answer; untagged, ambiguous or unsupported metadata keeps the raster candidate. PDF marking quality and raster heuristics still limit accuracy, and no representative detection benchmark or OCR claim is made.

## CI cancellation-test correction — 2026-10-06

The first CI run for commit `60e1ff6` failed in the full-document cancellation regression: after a fixed 25ms delay, the Ubuntu runner was still scanning page 1, while the assertion expected page 2. The fixture now exposes page-render start promises and explicitly gates page 1 before awaiting page 2. Progress, cancellation, partial-result cleanup and canvas release assertions remain intact; a bounded test timeout catches a missing transition. The test no longer depends on raster speed or competing test processes. `npm run check` passes all 123 tests, lint, TypeScript, production build and plugin validation locally. No production plugin code or PDF persistence behavior changed.

## Version 0.7.6 answer rules inside frames

Checked on 2026-10-05. `npm run check` passes **123 tests**, lint, TypeScript, production build and plugin validation. Three added regressions check inset answer rules in a complete frame at two raster resolutions and multiple insets, detached fragments at either endpoint, and continued rejection of connected/interior crossings, wide vertical bars and occupied headings. A reported three-line framed answer block was reproduced in a local rendered page; the corrected detector retained the three answer rules while excluding the surrounding frame.

Main-vault assets were backed up, installed and reloaded as 0.7.6, confirmed in Community plugins settings on Obsidian 1.14.4/macOS. A fresh full-PDF detection in Live Preview showed all three previously missing outlines correctly inside the reported framed block. Source PDF, note Markdown, plugin settings and recovery checksums remained unchanged. No answer was added to the source during this check. Other view-context gestures were not rerun for this detector-only change; earlier coverage remains historical. This remains a raster heuristic without a representative accuracy benchmark or OCR.

## Version 0.7.5 detected-answer filling and navigation

Checked on 2026-10-05. `npm run check` passes **120 tests**, lint, TypeScript, production build and plugin validation. Five added regressions cover Select instead of automatic text placement, repeated-target widget reuse, one-click answer editing, blank-page clicks without new fields, page-ordered Tab/Shift+Tab with blank cleanup, locked/conflicted-session exclusion, retained Enter behavior, independent saved-field checks and suggestion DOM stability during pointerdown cleanup. The host and layout are mocked in these tests.

A real mouse pass in an anonymous four-page worksheet on Obsidian 1.14.4/macOS clicked one empty detected line and then the next without typing: only the second blank remained. It then filled that second line, clicked the first line to answer it, clicked back to edit the saved second answer and clicked blank page space. Select stayed active, and independent PDF-LIB parsing retained exactly the two editable answers on page 2 with their expected values; note Markdown was unchanged. One-click switching between those saved answers also passed after detection in Live Preview, a PDF tab and a PDF pop-out. Tab reached the page-4 candidate and Shift+Tab returned to page 2, removing the abandoned blank.

Main-vault assets were backed up, installed and loaded as 0.7.5, confirmed in the Community plugins settings. Settings and recovery files remained byte-for-byte unchanged.

Targets remain transient, detected answers retain ordinary textarea newline behavior, and manually placed text boxes retain the existing selection/movement interactions. Detection accuracy, physical stylus and production-audit limitations remain unchanged. Earlier records describe their historical builds.

## Version 0.7.4 full-document answer-line detection

Checked on 2026-10-05. `npm run check` passes **115 tests**, lint, TypeScript, production build and plugin validation. Six new tests execute the actual surface scan and suggestion handlers with a mocked raster renderer: every/offscreen page and PDF coordinate conversion, sequential temporary bitmap release, cancellation with partial-result cleanup, rapid restart isolation, document replacement, failed-render cleanup/retry and all-blank completion. This change does not alter PDF persistence.

A real Obsidian 1.14.4/macOS pass started on page 4 of an anonymous four-page PDF in Reading view. One detection found four answer lines on pages 1, 2 and 4; navigating back to page 2 showed both outlines correctly. PDF and note checksums were unchanged by detection. Clicking the page-4 outline and saving retained an editable text field on page 4 with the expected value, verified independently with PDF-LIB; note Markdown stayed unchanged. Subsequent scans excluded that field and returned three suggestions on two of four pages in Live Preview, a PDF tab and a PDF pop-out. Hiding and rescanning in the pop-out also passed.

Main-vault assets were backed up, installed and loaded as 0.7.4. A full-document scan also completed in the main Live Preview embed, with source PDF and note checksums unchanged. Settings and recovery files remained byte-for-byte unchanged.

Detection remains a raster heuristic without OCR or a representative accuracy benchmark. Physical stylus, mobile and production-audit limitations remain. Earlier version records describe their historical builds.

## Version 0.7.3 mixed selection, level shapes and detection refinement

Checked on 2026-10-05. `npm run check` passes **109 tests**, lint, TypeScript, production build and plugin validation. All four existing stress workloads pass. New regressions exercise a 402-object selection with duplicates, one notification and one undo, shared boundary clamping, rejection before mutation of invalid/authored/locked members, stable IDs and repeated save/delete/undo/reopen, actual mixed marquee and Shift-click handlers, native text/input drag preservation, competing-view ink cancellation, fitted level polygons and held resizing, regular gray/dashed rules, label clearance and glyph/table false-positive rejection. jsdom mocks the host and layout; physical stylus accuracy remains unestablished.

A real mouse pass in an anonymous test-vault Reading embed on Obsidian 1.14.4/macOS selected a text answer, rectangle and triangle together, moved the group and independently read back identical PDF deltas for all three. Toolbar movement undo/redo, group removal/restoration, keyboard deletion and Cmd+Z passed. Detection suggested exactly three intended answer lines, excluding the underlined heading and empty table. The initial pass found a suggestion over a printed sentence; regular-dash filtering plus a regression removed it. Printed-text dragging still produced native text selection. The final selection build clears that prior native selection only when an object marquee/drag is claimed. Note Markdown remained unchanged.

Marquee, mixed movement and keyboard undo also passed in main Live Preview, a PDF tab and a PDF pop-out. These checks do not establish every new gesture in every context. Main-vault assets were backed up, installed and reloaded as 0.7.3; settings/recovery data remained byte-for-byte unchanged. There is no scan accuracy benchmark, OCR, mobile or pressure claim. This remains a development beta with the production-audit limitations.

## Version 0.7.2 blank-box focus, held-shape resizing and answer-line suggestions

Checked on 2026-10-05. `npm run check` passes **98 tests**, lint, TypeScript, production build and metadata validation; the four stress workloads remain green. Ten added regressions cover raster line filtering, exact circles, resizing/reversing at page boundaries without drift, actual TextEditor focus/drag/resize events, keyboard unfocus, filled-value persistence and a real hold timer followed by resizing and saved-Ink verification. The UI harness mocks Obsidian and layout with development-only jsdom; it does not establish physical stylus behavior.

An Obsidian 1.13.7/macOS pass used an anonymous worksheet in an isolated test vault:

- Detection initially misidentified the top/bottom of an empty table. A correction and regression now reject vertical borders extending either above or below a rule; the app then proposed exactly the three answer lines. Detection alone left the source PDF checksum unchanged.
- Clicking a suggestion created a focused blank field. Switching to Select retained it; real mouse drags moved it and widened its right edge before typing. The saved PDF independently retained one editable field with the entered value and changed geometry. Note Markdown remained byte-for-byte unchanged.
- Native toolbar activation exposed a transient body-focus gap. Focus cleanup now waits for a concrete outside target; a regression simulates that gap. A later outside-page click removed the still-empty box while retaining the filled field.
- Detection and saved text were visible in a PDF tab, main Reading view, main Live Preview and a Live Preview pop-out. The pop-out reran detection; suggested outlines followed a 90-degree page rotation. Other gestures were not all rerun in each context.

The new build is a beta. Raster detection is a local heuristic rather than OCR or Apple's form model. No representative scan/handwriting accuracy benchmark, physical pen hold/resizing pass or pressure support is claimed. Existing production-audit limitations remain.

## Production-readiness audit of the 0.7.1 working tree

On 2026-10-05, the audit increased coverage from 64 to **88 passing regression tests**, plus **four stress workloads** via `npm run test:stress`. Lint, TypeScript, production build and metadata checks pass. The audit reproduced and fixed session replacement races, interrupted journal/restore failures, file-identity errors, foreign annotation deletion, appearance/visibility problems, malformed tree handling and repeated-save font accumulation.

The rebuilt plugin also passed a new anonymous-fixture save smoke test in Reading view, Live Preview, a PDF tab and a pop-out on Obsidian 1.13.7/macOS. Pop-out drawing, undo/redo, restore and reverse-restore passed; disk parsing retained the final text, three strokes and read-only values, with unchanged note Markdown. Broader historical gesture claims below were not all rerun.

See [the full audit](PRODUCTION_AUDIT.md) for workloads, measurements, limitations and remaining blockers. Passing these checks does **not** establish atomic external-writer protection or physical crash/power-loss durability. The earlier version records below describe their historical builds.

## Version 0.7.1 full-page sizing and rough-shape recognition

Checked on 2026-10-05. `npm run check` passes **64 tests**, lint, TypeScript, production build and metadata validation. The new regression uses five normalized rough strokes from the anonymous development worksheet: two rectangles, two uneven loops and a rounded triangle. All now recognize correctly in both directions, at three scales and four rotations (120 cases). The ideal-geometry and open-loop/spiral/scribble rejection tests remain green. Existing saved strokes are unchanged; assistance applies to newly drawn strokes.

A browser fixture using the actual production CSS measured identical icon/color centers and fixed label positions for 1, 4, 14 and 30pt. A DOM harness executing the production `PdfSurface.layout` method against A4 page geometry verified complete first-page visibility at 320px, 700px and 980px widths. At 700px the default embed measured 1044px tall; explicit 560px embeds remained 560px. Zooming to 200% kept the fit-width embed height and used internal scrolling.

These are browser fixtures, not an Obsidian app pass. Desktop app selection and screenshots repeatedly timed out, so the final Obsidian reload, theme-specific appearance and view-context checks could not be repeated for 0.7.1. The updated assets are installed in the isolated development vault and require an app/plugin reload. Prior 0.7.0 app coverage is recorded below; physical stylus testing remains outstanding.

## Version 0.7.0 selection, rendering and assisted ink

Checked on 2026-10-05 in **Obsidian 1.13.7 desktop on macOS**, with an isolated development vault and an anonymous six-page fixture. Build 0.7.0 was installed only in that vault. Test PDFs, screenshots and runtime reports are ignored by Git.

| Scenario | Observed result |
| --- | --- |
| Embed sizing | A numeric 560px embed ended directly above the following note paragraph; no unused native-viewer area remained below the editor |
| Page rendering | Navigating to page 6 released page 1's distant bitmap; returning painted page 1 again. The page counter correctly showed 6 and then 1 |
| Real text interaction in a Reading pop-out | One click focused the box group and exposed handles without editing; double-click focused the textarea; Backspace after selecting removed the box and Undo restored it |
| Interior drag | A real mouse drag from the text interior moved the box. Independent PDF parsing confirmed the new saved rectangle and unchanged text |
| Empty-box cleanup | After double-clicking, selecting all text and deleting it, choosing Pen removed the empty box. The authored blank form field remained. Session tests protect blanks actively edited in another view |
| Controls | Native UI inspection showed aligned settings icon/width, swatches, sample widths and two pen switches. Clicking the active Pen dismissed the palette; a DOM check confirmed the settings button toggles it closed |
| Timed hold integration | Synthetic pointer events on the actual Obsidian overlay with real timers produced a straight-line hint and a two-point highlighter stroke. A rectangle snapped; moving again restored freehand. Pointer-up cleared the timer. Pointer capture was stubbed only for this synthetic test |
| Save stability | DOM checks in main Reading, main Live Preview, main PDF tab, pop-out Reading and pop-out Live Preview retained the page/canvas/input objects across autosave, reached Saved and measured unchanged tool positions |
| Header rename | Invoking the header control and its rename handler saved the PDF under its new name. Obsidian's native link-update prompt was accepted for the synthetic note; the embed link and header updated |
| Reopen/output | The renamed PDF retained its authored text and straight marker in independent parsing. Drawing saves and moves passed after deleting a saved text box |

The pass found a PDF-LIB deletion bug: separate widget references could remain in a page's annotation array after their dictionaries were deleted. Later ink verification then failed. The writer now removes the exact deleted widget entries and tolerates unrelated pre-existing unresolved annotation references. Two new regressions cover deletion followed by ink creation/reopening/movement, and older PDFs containing a dangling entry.

A background-window focus probe did not enter editing; it is not counted as a text-selection pass. Explicit event-handler checks and the foreground native UI pass above verified cleanup. The first pop-out Reading DOM focus assertion also lacked actual window focus; native single-click selection was verified separately. Native automation sometimes targeted another development window; those attempts are excluded. No private vault was modified.

`npm run check` passes **63 tests**, lint, TypeScript, production build and plugin validation. Shape regressions cover rotation, reversal, uneven sampling, jitter, rejection of ambiguous handwriting/open loops/spirals, and saved standard-Ink geometry. These are regression fixtures, not a measured recognition accuracy benchmark. [Research and design decisions](INK_RESEARCH.md) distinguish smoothing from handwriting rewriting.

Physical stylus/pressure, sustained handwriting, recognition on a representative user corpus, long/image-heavy PDFs, other themes/platforms, rapid zoom/rotation during gestures and abrupt app termination still need testing. Cube/multistroke recognition and handwriting rewriting/OCR are not implemented. Historical records below describe older behavior and do not override 0.7.0.

## Version 0.6.0 persistent integrated editor

Checked on 2026-10-05 in **Obsidian 1.13.7 desktop on macOS**, using an isolated development vault and an anonymous two-page worksheet. The final build was installed only in that vault. Test PDFs, answers and runtime reports remain outside Git.

| Scenario | Observed result |
| --- | --- |
| Reading view, Live Preview, PDF tab and pop-outs | In-app DOM checks entered an answer, allowed the real 900ms autosave to finish, and verified the same page, canvas and input objects remained connected. The input retained focus and the session reached Saved in main Reading, main Live Preview, main PDF tab, pop-out Reading and pop-out Live Preview |
| Stable toolbar | Measured all five tool button positions while switching through Text, Pen, Highlighter, Eraser and Select; positions were identical |
| Custom brush controls | A native UI screenshot showed eight color swatches, four sample widths and the combined brush preview. DOM clicks selected blue and 4pt; the resulting mark retained that style. A development plugin reload retained these preferences |
| Mouse drawing and persistence | Real mouse drags created a blue pen stroke and yellow highlighter in a Reading-view pop-out. Autosave reached Saved with the tool still active and retained the marks. A further pen drag passed in the main PDF tab after the final animation-frame preview change |
| Eraser / undo | A real mouse eraser drag removed just the crossed pen stroke. Undo restored it. Switching to Live Preview kept all three marks; later saves and a plugin reload retained them |
| Direct typing | Native UI clicks and paste entered an answer directly in a Live Preview field. The answer autosaved and remained editable |
| Recovery details | Opened Recovery copies from the PDF menu; it showed the original copy, preview action, storage location and the original/restore/draft retention rules |
| Search | Entering text found the second page, scrolled to it and highlighted the matching PDF text span |
| Reopening / independent output | Reloading the plugin recovered the saved answer and marks from the PDF. Independent PDF parsing confirmed the two pages, editable field value, two 4pt pen strokes and one 14pt marker before the final main-window pen check |

The first focus probe accidentally selected a hidden Live Preview instance. It could not focus that input and returned zero geometry; it is not counted as a focus/layout pass. The repeated checks explicitly selected visible surfaces. Old native PDF.js drag/drop errors were present in the main console before these checks; their count did not increase during the recorded pass. No tablet-pressure or hardware stylus testing was performed.

`npm run check` passes **52 tests**, lint, TypeScript, production build and plugin validation. New regressions cover gesture ownership across views, redo after saves, newer changes superseding prepared drafts, editable-text appearance removal while preserving checkbox appearances, and text/formatting/delete undo interleaved with ink. The obsolete native-page backdrop was removed. Pages are rendered near the viewport with capped raster memory; hidden surfaces skip painting and live ink previews use animation frames.

Remaining verification includes long and image-heavy school PDFs, sustained handwriting, every palette/keyboard choice, search edge cases and link navigation, rotation/zoom during gestures, abrupt app termination, other themes/platforms and physical pen devices. Main Reading/Live Preview mouse gestures have less coverage than the pop-out gesture pass. The DOM/save checks above are integration checks, not a guarantee of every PDF or Goodnotes feature. Historical records below describe earlier architectures and do not override 0.6.0 behavior.

## Version 0.5.0 persistent tools, formatting and stable drawing

Checked on 2026-10-05 through Computer Use in an isolated vault and **Obsidian 1.13.7 desktop on macOS**. Anonymous two-page fixtures contained authored fields, added boxes and saved marks. The build was installed only in the development vault; test PDFs, answers and screenshots remain outside Git.

| Scenario | Observed result |
| --- | --- |
| Persistent tools | Select was the opening tool. Text stayed active after placing/typing two lines, Save and Escape. Re-tapping Pen or Marker opened its color/width menu and retained the active tool |
| Drawing without per-stroke reload | Two blue pen strokes remained visible across idle checkpoints without a white page flash. The source PDF hash stayed unchanged while Pen was active; the hidden verified draft contained both new strokes. Choosing Select committed them |
| Blank clicks / direct typing | Select clicks on blank space did not add a field. A direct click on an existing field or box allowed typing |
| Eraser and undo | An eraser drag removed one complete pen stroke and kept the other marks. Undo restored that gesture. Eraser remained active; choosing Select committed the result |
| Select movement / deletion | Dragging a saved blue pen stroke moved it; saving retained the same annotation ID/reference. Selecting and deleting it removed it from the saved PDF |
| Contextual text controls | Selecting text showed family, color and size controls; clearing selection hid them. An added multiline box changed to red Serif at 16pt; saved values, styling and appearance retained the change |
| Reading view | Direct authored-field typing and Cmd+S persisted from the main note preview. Saved text and ink rendered there |
| Live Preview | Direct authored-field typing, Mono formatting and Cmd+S persisted. The annotation row fit a 700px embed without shifting the page when text controls appeared |
| PDF tab / pop-out | Direct field edits saved from the main PDF tab. The successful canvas drawing, erasing, moving, deleting and undo pass was in a note-preview pop-out |
| Recovery migration / preview | The visible legacy folder disappeared. All 15 older recovery PDFs retained their byte hashes in hidden storage. Original preview rendered embedded text in a pop-out; its read-only pagination reached page 2 |
| Independent output | PDF parsing verified editable values, Serif/Mono font metadata, color/size and remaining ink. Poppler rendered the saved file; the embedding note stayed byte-for-byte unchanged |

The gesture pass found and fixed two backdrop issues: native resets removed the plugin canvas while retaining the page element, and a native wrapper class caused canvas ownership collisions. The final backdrop uses its own class, recreates detached canvases and strips only owned ink from a display copy, avoiding duplicate/ghost marks after movement or deletion. Passing PDF.js `ownerDocument` fixed custom-font glyphs in pop-out recovery previews. A fixed-height annotation row stopped context controls changing PDF page geometry mid-gesture.

A main-window marker gesture did not produce a new stroke through coordinate automation; no error appeared. Canvas gesture support in main Reading/Live Preview embeds therefore remains provisional. Rendering and direct typing in those embeds passed. All palette colors/widths, Shift-marker locking, rapid strokes, cancellation/zoom during gestures, every resize handle and rotated/cropped edge combinations still need broader final-build app testing. Closing and reopening existing pop-outs is recommended after a development reload, since independently running windows can retain an earlier plugin build.

`npm run check` passes **47 tests**, lint, TypeScript, build and plugin validation. Seven new regressions cover verified draft checkpoints without source writes and recovery after a crash; stale recovered drafts; stable references and gesture-level move/erase undo; continuous eraser crossings/taps; whole-field fonts/colors/sizes with independently parsed appearance operators; interrupted hidden-folder migration; and display copies preserving foreign annotations and form content. The previous 40 tests remain green. Erasing removes a whole owned stroke; formatting affects a whole field, and no Wacom or pressure support is claimed.

## Version 0.4.0 direct editing, marker and scribble

Checked on 2026-10-05 through Computer Use in an isolated vault and **Obsidian 1.13.7 desktop on macOS**. Anonymous two-page fixtures contained one authored field and one existing plugin-created box. The final build was installed and reloaded; fixtures and answers remain outside Git.

| Scenario | Observed result |
| --- | --- |
| Default interaction | Select was active on opening; single clicks on the authored field and added box allowed typing without choosing Text |
| Blank space | A canvas click in the PDF pop-out left the two existing fields unchanged |
| Explicit placement | Text tool plus one tap created a focused box and returned to Select; Cmd+S saved it, leaving three fields |
| Box growth | Multiple typed lines grew the existing box; the font-spacing confirmation pass showed a narrow box wrapping into two visible lines, also retained in the saved appearance |
| Marker | Dragging across printed text produced a transparent yellow stroke; automatic save retained its color/opacity without double painting |
| Scribble | A dragged pen stroke and a tap dot produced owned ink items; undo removed the last dot, and selecting a saved pen stroke then pressing Delete removed it |
| Exit drawing | Escape returned to Select with normal direct text editing available |
| Reading view | Direct typing and Cmd+S persisted edits in the embedded PDF; saved marks rendered there |
| Live Preview | Direct typing, wrapping/growth and Cmd+S worked; native icon controls stayed within the existing bar |
| PDF tab / pop-out | Direct fields were editable in the tab; canvas drawing, blank clicks, one-shot placement, undo/removal and saved appearances were checked in its pop-out |
| Independent output | PDF parsing confirmed three fields, retained marker/pen styles and grown geometry; Poppler rendered the saved output; note Markdown remained byte-for-byte unchanged |
| Recovery | Editing and app reloads retained one original recovery PDF for the fixture |

The main-window coordinate tool again returned `windowNotFoundAtPosition`; the verified canvas gesture pass was in a pop-out. Drawing gestures inside Reading/Live Preview embeds, all brush-width choices, Shift-marker locking, rapid strokes, pointer cancellation/zoom during a stroke and edge/rotation combinations still need broader final-build app testing. Rendering and direct text editing in those embeds were checked. The final confirmation pass fixed browser kerning/ligature advances differing from the saved font advances, which had clipped the final wrapped line of a narrow box.

`npm run check` passes **40 tests**, lint, TypeScript, build and plugin validation. Six new tests cover standard ink/appearance and Multiply opacity through independent PDF.js annotation/operator parsing; stable IDs and preservation of foreign annotations/forms; save/reopen/delete/undo; tap dots and rotated cropped coordinates; interaction gates and external-change conflicts; invalid/locked strokes; and bounded simplification. Earlier text/recovery regressions remain green. Ink uses constant width; no tablet-pressure or Wacom compatibility claim is made.

## Version 0.3.0 Preview-style text boxes

Checked on 2026-10-05 through Computer Use in an isolated vault and **Obsidian 1.13.7 desktop on macOS**. The final 0.3.0 build was installed and reloaded there. Tests used anonymous form/worksheet fixtures; no private PDF or answers were committed.

| Scenario | Observed result |
| --- | --- |
| Reading view | A 24pt-high box grew to show multiple lines; selection displayed eight blue handles; keyboard movement/resizing changed the box and saved its text and geometry |
| Selected font size | The native size picker changed the selected box from 14pt to 16pt; saving and reopening retained it |
| Live Preview | Enter opened selected text for editing; new lines remained visible; explicit Save persisted them. The final shortcut fix saved with Cmd+S and retained text focus after native viewer replacement |
| Standalone PDF tab | Keyboard movement and resizing saved successfully; the final save indicator remained Saved across a subsequent idle autosave |
| Pop-out | Text editing, automatic growth and Cmd+S worked. A mouse drag of the right handle narrowed the box; dragging selected text moved it. Independent parsing confirmed both saved geometry changes |
| Tap placement | In the pop-out, a tap created a focused editable box, two lines grew its height, and the file on disk retained its previous field count throughout focused typing; Done saved the new box |
| Independent output | PDF parsing confirmed values and geometry; Poppler rendered the saved multiline answer; note Markdown stayed unchanged |

The main-window coordinate automation initially returned `windowNotFoundAtPosition`; the successful mouse gesture pass above was in a pop-out. One earlier corner drag changed the on-screen preview without verified persistence; the subsequent right-handle resize and move were verified on disk. All eight handles, drag-to-create, rapid consecutive placement, zoom during gestures and quarter-turn combinations still need broader final-build app testing. Earlier app-version coverage below is historical, not a substitute for those checks.

The save-stability work was developed under an unreleased 0.2.2 version before inclusion here. During that work, focused typing left the vault PDF unchanged, and leaving a field for the quick switcher saved its final value without stealing the switcher's focus.

`npm run check` passes **34 tests**, lint, TypeScript, build and plugin validation. Regressions cover movement/page bounds and rotated geometry; stable widgets after move/resize/font changes; long-word/grapheme wrapping and independently parsed appearances; blank placement without immediate writes; focus handoff; interactions during save preparation and the final vault read; explicit saving with another focused view; cancellation on reload; stale-file detection; and clean autosaves retaining Saved status. Existing recovery/form-preservation tests also pass.

Automatic saving waits while any view is typing, placing, moving or resizing a box, or using its toolbar/menu. Save, Done or Cmd/Ctrl+S commit explicitly; an explicit commit can refresh Obsidian's native viewer. The app pass found and fixed Live Preview shortcut interception and a queued clean autosave incorrectly changing Saved to Waiting.

## Version 0.2.1 refinement

Tested on 2026-10-05 through Computer Use in **Obsidian 1.13.7 desktop on macOS**, using an isolated vault and a newly generated anonymous form/worksheet.

| Scenario | Observed result |
| --- | --- |
| Native toolbar | Icon controls fit the existing PDF bar in PDF tabs, Reading view, Live Preview and pop-outs; no extra row or permanent instruction banner |
| Focus and typing | Transparent background stayed transparent while focused; hover/focus outlined the field; status showed one icon throughout typing |
| Font and multiline | Embedded font used in the editing overlay; three lines saved and remained editable; independent Poppler render verified matching saved leading |
| Autosave | Typing continued after a save and native viewer replacement |
| Session/app reload | Editing after a reload reused the same original recovery path and checksum |
| Restore and undo restore | Original restored; undo recovered saved answers; directory contained only original and before-restore PDFs |
| Reading view / Live Preview / pop-out | Answers saved from each context and read back from the PDF; note Markdown remained unchanged |
| Legacy index | Existing 0.2.0 recovery paths loaded; policy tests verified reuse without copying or deleting older files |

`npm run check` passes **21 tests**, lint, TypeScript/build and metadata validation. Seven recovery tests cover reuse across reloads, legacy migration, bounded restore slots, concurrent requests, verification/index failures and retries, changed backup detection, and rejection of recursive backups. A PDF.js appearance test verifies that three multiline baselines fit inside a 60pt box with the editor's 1.2em leading.

The app inspection found focused-input theme overrides and accumulating status SVGs; both were fixed before the final confirmation pass. Independent rendering also exposed PDF-LIB's larger default multiline leading; owned multiline boxes now use an appearance provider matching the editor's line spacing and font baseline. Broader compatibility limits below still apply.

## Version 0.2.0 initial editing beta

Tested on 2026-10-05 through the native Obsidian UI using Computer Use. App: **Obsidian 1.13.7 desktop on macOS**. Tests used an isolated vault and anonymous PDFs, not the user's worksheet or answers.

| Scenario | Observed result |
| --- | --- |
| Shared text field on two pages | Saved value appeared on both pages and in a second embed |
| German text | Umlauts persisted with visible font appearances |
| Printed answer line | Click created an editable field; independent render placed the answer on the line |
| Multiline area in Reading view | Three lines saved/rendered correctly and remained editable after reopening |
| Reading view and Live Preview | Toolbar/overlays present; direct PDF editing worked |
| Autosave with focused field | Continued typing after a pause and native refresh |
| PDF tab | Flat worksheet saved, reopened and edited again; mode/focus retained after viewer replacement |
| Pop-out window | Answer saved from a separate window and appeared in the original window/PDF |
| Cropped page rotated 90 degrees | Clicked answer stayed horizontal at the intended position; Poppler render verified it |
| Zoom and scrolling | Overlay position and font size followed the viewport |
| Remove created box | Field disappeared from the saved PDF |
| Restore/reverse restore | Current PDF backed up first; reverse restore recovered edited content |
| External edit with pending input | Stale write stopped; pending text retained; Reload asked before discarding |
| App/development reloads | Saved content remained; toolbar rebuilt without duplicates |
| Independent verification | pypdf read values; Poppler rendered typed/multiline text and German glyphs |

`npm run check` passes 13 integration tests plus lint, TypeScript/build and metadata validation. Backend tests additionally cover failed backups, simultaneous save requests, page/link/checkbox preservation, unsupported glyphs and XFA/signature rejection.

App tests found and resolved separate Reading view ownership, autosave focus loss, observer feedback during file switches, PDF-tab viewer replacement and widget/page rotation sign differences. This is representative first-version coverage, not a guarantee for every PDF.

Not established across releases: Windows/Linux/mobile, older app versions, malformed PDFs, large-file performance, all quarter-turn combinations, third-party PDF plugin interoperability, CJK/emoji fallback, non-text form editing or Wacom input. Test separately before expanding support claims.
