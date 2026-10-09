# PDF Editor

This repository contains a desktop PDF editing beta for Obsidian. Read `README.md` before changing it. Keep implementation status, compatibility claims and limitations accurate. Keep project-owned Markdown limited to `README.md` and `AGENTS.md`; preserve third-party license and notice files.

## Working conventions

- Use Node.js 24, TypeScript and the public Obsidian API wherever possible. Keep dependencies pinned and `package-lock.json` synchronized.
- Run `npm run check` after code or build changes. Run `npm run test:stress` for persistence, recovery, resource-management or release changes. Fixtures must be anonymous; generated audit artifacts belong in ignored `tmp/`.
- Test final assets in an isolated vault. Record the actual app version, platform, surfaces and actions checked. Do not turn automated fixtures, a declared minimum version or an older smoke test into a broad support claim.
- Test Reading view, Live Preview, PDF tabs and pop-out windows before claiming support. Include repeated/interrupted gestures, keyboard focus, shortcuts, save/reopen and external changes as relevant. Physical stylus/pressure behavior needs hardware evidence.
- Keep private PDFs, answers, vault paths, hardware details and credentials out of Git.
- Commit source and metadata. Generated `main.js` belongs in workflow artifacts/releases. Do not bundle Obsidian, Node/Electron modules, development fixture libraries or the upstream PDF.js test dependency.
- Preserve `LICENSE`, `THIRD_PARTY_NOTICES.txt` and bundled font/library licenses. Keep notices embedded in the production build.

## Architecture

- `src/main.ts`: commands, viewer lifecycle and vault events.
- `src/compat/native-pdf.ts`: all undocumented native-host access and transforms. Keep this isolated; native page DOM is not the editing surface.
- `src/ui/pdf-surface.ts`: persistent PDF.js pages, navigation, search, links and rendering.
- `src/ui/text-editor.ts` and `src/ui/tool-popover.ts`: editor controls, placement, selection, keyboard ownership and tool settings.
- `src/pdf/text-session.ts` and `src/pdf/vault-sessions.ts`: shared models, serialized saves, stale checks, verified recovery and session registry.
- `src/pdf/text-engine.ts`: forms, fonts, logical values and appearance streams.
- `src/pdf/draft-journal.ts`: alternating sequenced recovery slots.
- `src/pdf/answer-lines.ts`: bounded raster heuristics; suggestions must not edit the PDF until activated.
- `src/pdf/ink-assist.ts` and `src/pdf/held-shape.ts`: conservative single-stroke fitting and held-shape transformations.
- `tests/`: anonymous generated PDFs and independent PDF.js verification.

## Persistence and lifecycle safeguards

- Use vault APIs for PDF reads and writes; keep UI state separate from document sessions and save queues. Share one document and serialized writer across views.
- Preserve editable AcroForms and standard ink annotations with stable IDs. Avoid flattening, duplicate fields/strokes or accumulation of fonts/appearances across saves and reopen cycles. Preserve unrelated fields, links and annotations.
- Verify logical values and appearances before writing and read back the saved bytes. Check stale source state, checkpoint a verified draft and create required original recovery copies before source replacement. A missing indexed original must not silently become a new original.
- External-change comparisons cannot close the final read/write race: `vault.modifyBinary` has no atomic compare-and-swap. Keep the single-writer restriction explicit.
- Keep two verified sequenced draft slots and bounded alternating before-restore slots. Do not replace the only valid fallback before the next copy and metadata are verified.
- Serialize reload, restore, saves and rename/index work. Block edits during document replacement. Follow `TFile` identity so an obsolete session cannot overwrite a replacement file at the same path.
- File/folder moves and recovery-index updates are not a crash transaction. Do not claim power-loss durability from mocked I/O tests. Keep non-overwriting draft export available for damaged/conflicted source files.
- Register and dispose listeners, observers, timers, PDF.js tasks, portals, modals and sessions with the component lifecycle. Keep the editor mounted across ordinary saves; release distant page resources and clean sessions when no views remain.
- Scope clipboard/shortcut ownership to the selected editor and its document. Cancel asynchronous pastes when focus or object selection changes. Releasing a selected-object focus proxy must release its active interaction so autosave can finish.
- Reject unsupported/malformed documents before recursive traversal. Preserve hidden, locked and read-only appearances. Unsupported glyphs must fail explicitly rather than save invisible or incomplete text.

## Release rules

The installed ID is `pdf-editor`; legacy `pdf-form-studio` annotation identifiers remain unchanged for compatibility; PDF_Editor is the repository name. Keep desktop-only scope while Electron is required. Verify the declared minimum Obsidian version against real app tests.

Keep `package.json`, `manifest.json` and `versions.json` synchronized. Use exact `x.y.z` release tags without a `v` prefix. The release workflow creates drafts with `main.js`, `manifest.json` and `styles.css`; publication and Community submission require a separate decision. Check current official Obsidian submission requirements before submitting. Do not change repository visibility or install a GitHub App as part of routine release preparation.
