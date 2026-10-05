# App test record

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

Not established: Windows/Linux/mobile, older app versions, malformed PDFs, large-file performance, all quarter-turn combinations, third-party PDF plugin interoperability, CJK/emoji fallback, non-text form editing, moving/resizing boxes or Wacom input. Test separately before expanding support claims.
