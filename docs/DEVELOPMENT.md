# Development and GitHub integration

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Commands, viewer discovery/lifecycle and vault events |
| `src/compat/native-pdf.ts` | All undocumented component/viewer access and viewport transforms |
| `src/ui/pdf-surface.ts` | Persistent PDF.js pages, navigation, search, links and render lifecycle |
| `src/ui/text-editor.ts` | Fixed per-view controls, placement and editing overlays |
| `src/ui/tool-popover.ts` | Document-local accessible visual tool settings |
| `src/pdf/ink-assist.ts` | Arc-length sampling, centerline stabilization and conservative single-stroke fitting |
| `src/pdf/held-shape.ts` | Original-fit transformations while a snapped shape remains held |
| `src/pdf/answer-lines.ts` | Bounded local raster heuristics returning transient field suggestions |
| `src/pdf/file-name.ts` | Header filename validation within the current folder |
| `src/pdf/text-session.ts` | Shared model, stable IDs, serialized saves, stale detection and recovery |
| `src/pdf/vault-sessions.ts` | Public vault binary APIs, verified backups and session registry |
| `src/pdf/text-engine.ts` | Form writing, fonts, logical values and appearance verification |
| `src/pdf/inspect.ts` | Read-only PDF.js diagnostics |
| `tests/` | Anonymous PDFs generated in memory; independent PDF.js inspection |
| `assets/` | Noto Sans and license sources |
| `.github/` | CI, draft releases, Dependabot and contributor templates |

Existing fields remain AcroForms. Printed worksheets get transparent, borderless text fields. Each save serializes the session's original PDF plus its complete edit set, avoiding repeated field/font accumulation. Changed fields receive new appearances; unrelated fields and annotations retain their original state. This is not a complete PDF conformance validator.

Saving checks bytes against the session baseline, verifies output in memory, makes a verified recovery copy before the first write, checks staleness again, writes with `vault.modifyBinary`, then reads back and verifies bytes. Vault storage has no public atomic compare-and-swap operation: these checks cannot remove every external-writer race.

The audited writer also checkpoints explicit saves before source replacement. `draft-journal.ts` alternates two verified sequenced slots instead of overwriting the only valid fallback. Restore protection alternates two slots and keeps the current pointer until verification/index persistence succeeds. Reload and restore serialize with saves and temporarily block mutations. Sessions use `TFile` identity, serialize journal/index operations with renames, and release clean state after the last view closes. These are in-process safeguards; see the [production audit](PRODUCTION_AUDIT.md) for crash/multiple-writer gaps.

`object-references.ts` follows document references to prune replaced appearance resources only when no live object still references them. This avoids font/appearance growth across reopening without removing shared resources from untouched fields. Page/form traversal and duplicate-name guards run before high-level recursive field enumeration. Unsupported visibility/locking fields keep their original rendered appearances.

## Local loop

1. Use Node.js 24 and `npm ci`.
2. Run `npm run check` for lint, integration tests, TypeScript, build and metadata checks.
3. Open an isolated Obsidian vault with a `.obsidian` directory.
4. Build and run `npm run install:dev -- "/absolute/path/to/development-vault"`.
5. Enable PDF Form Studio in Community plugins and test anonymous forms/worksheets.
6. Rebuild/copy and use **Reload app without saving**, after PDF changes show **Saved**.

The installer copies only the three assets, does not enable plugins, refuses symlinked destinations and supports standard `.obsidian` configuration directories. For a custom configuration directory, copy assets manually. `npm run dev` watches/builds but does not install/reload.

The native viewer can still reload after a write, but its DOM is hidden while the persistent editor is active. Mount the editor as a sibling of native content and retain it while the host/file identity is unchanged, including the interval when the native child clears its file reference. Session events and ResizeObserver drive editor updates; discovery polling does not repaint it. Background canvas rendering uses a display copy with editable text widgets and owned ink omitted, preserving other annotation appearances. Dispose render tasks, text layers, observers, overlays, portals and modals on unload. Keep undocumented host discovery in the adapter.

Rendering tracks queued and painted revisions separately: offscreen/cancelled work must not be marked complete. Embed hosts and editor children share one height constraint. Hold detection belongs to the pointer gesture lifecycle; end, cancel and unload clear its timer. Assisted points are stored as ordinary editable Ink, without an extra sidecar format. See [ink research](INK_RESEARCH.md) for algorithms, defaults and exclusions.

Whole-box focus claims are counted in the shared session so another view's active empty box is not pruned. Deletion records exact widget references before PDF-LIB removes dictionaries: its 1.17.1 `removeField` implementation otherwise leaves separate widgets in page annotation arrays. Ink lookup tolerates pre-existing unresolved annotation entries without deleting unrelated content.

## Verification and releases

The jsdom development fixture runs actual TextEditor/InkLayer event handlers with a mocked host and layout. It is not bundled into main.js and does not establish hardware behavior.

Integration tests cover shared widgets, Unicode appearances, untouched page content/links/checkboxes, repeated saves, reopening/deletion, serialized writes, conflicts, backup failure, reversible restores, unsupported glyphs, CropBox rotation and signature/XFA rejection. PDF.js independently inspects saved fields and appearances. [TESTING.md](TESTING.md) records real app coverage. No Wacom test is part of this release.

CI runs `npm ci` and `npm run check` with Node.js 24, then uploads the three plugin assets. Generated builds and private PDFs are ignored by Git. Runtime writing dependencies are bundled; Obsidian, Node/Electron imports and the upstream PDF.js test library are not. Font and library license notices are embedded in the build banner.

Run `npm run test:stress` separately for deterministic mixed-edit concurrency, a 120-page/1,200-stroke PDF, 50 reopen/save cycles and a 24 MiB image workload. It writes anonymous PDF artifacts under ignored `tmp/production-audit/`. Use an isolated process for memory measurements; see the audit's reproduction commands.

```sh
npm version patch
npm run check
git push origin main
git push origin --tags
```

The version hook synchronizes the manifest and compatibility map. Tags must be exact `x.y.z` without a `v` prefix. Tag pushes validate metadata and create a **draft** release. The private repository cannot serve as public Community distribution. Submission requires broader testing and current [Obsidian requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).

Keep dependencies pinned and the lockfile synchronized. Do not commit private PDFs, answers, vault paths, credentials or hardware details. The API package's development-only Moment override does not alter Obsidian runtime modules.
