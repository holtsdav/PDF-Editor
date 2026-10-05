# Development and GitHub integration

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Commands, viewer discovery/lifecycle and vault events |
| `src/compat/native-pdf.ts` | All undocumented component/viewer access and viewport transforms |
| `src/ui/text-editor.ts` | Per-view controls, overlays, placement and focus restoration |
| `src/pdf/text-session.ts` | Shared model, stable IDs, serialized saves, stale detection and recovery |
| `src/pdf/vault-sessions.ts` | Public vault binary APIs, verified backups and session registry |
| `src/pdf/text-engine.ts` | Form writing, fonts, logical values and appearance verification |
| `src/pdf/inspect.ts` | Read-only PDF.js diagnostics |
| `tests/` | Anonymous PDFs generated in memory; independent PDF.js inspection |
| `assets/` | Noto Sans and license sources |
| `.github/` | CI, draft releases, Dependabot and contributor templates |

Existing fields remain AcroForms. Printed worksheets get transparent, borderless text fields. Each save serializes the session's original PDF plus its complete edit set, avoiding repeated field/font accumulation. Changed fields receive new appearances; unrelated fields and annotations retain their original state. This is not a complete PDF conformance validator.

Saving checks bytes against the session baseline, verifies output in memory, makes a verified recovery copy before the first write, checks staleness again, writes with `vault.modifyBinary`, then reads back and verifies bytes. Vault storage has no public atomic compare-and-swap operation: these checks cannot remove every external-writer race.

## Local loop

1. Use Node.js 24 and `npm ci`.
2. Run `npm run check` for lint, integration tests, TypeScript, build and metadata checks.
3. Open an isolated Obsidian vault with a `.obsidian` directory.
4. Build and run `npm run install:dev -- "/absolute/path/to/development-vault"`.
5. Enable PDF Form Studio in Community plugins and test anonymous forms/worksheets.
6. Rebuild/copy and use **Reload app without saving**, after PDF changes show **Saved**.

The installer copies only the three assets, does not enable plugins, refuses symlinked destinations and supports standard `.obsidian` configuration directories. For a custom configuration directory, copy assets manually. `npm run dev` watches/builds but does not install/reload.

The native viewer recreates page DOM and sometimes its entire viewer child after a write. Keep focus/mode across brief replacement, but clear it on file switches. Observers must disconnect around their own rebuilds. Dispose listeners, observers, overlays and modals on unload; keep private viewer access in the adapter.

## Verification and releases

Integration tests cover shared widgets, Unicode appearances, untouched page content/links/checkboxes, repeated saves, reopening/deletion, serialized writes, conflicts, backup failure, reversible restores, unsupported glyphs, CropBox rotation and signature/XFA rejection. PDF.js independently inspects saved fields and appearances. [TESTING.md](TESTING.md) records real app coverage. No Wacom test is part of this release.

CI runs `npm ci` and `npm run check` with Node.js 24, then uploads the three plugin assets. Generated builds and private PDFs are ignored by Git. Runtime writing dependencies are bundled; Obsidian, Node/Electron imports and the upstream PDF.js test library are not. Font and library license notices are embedded in the build banner.

```sh
npm version patch
npm run check
git push origin main
git push origin --tags
```

The version hook synchronizes the manifest and compatibility map. Tags must be exact `x.y.z` without a `v` prefix. Tag pushes validate metadata and create a **draft** release. The private repository cannot serve as public Community distribution. Submission requires broader testing and current [Obsidian requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).

Keep dependencies pinned and the lockfile synchronized. Do not commit private PDFs, answers, vault paths, credentials or hardware details. The API package's development-only Moment override does not alter Obsidian runtime modules.
