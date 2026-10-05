# App test record

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
