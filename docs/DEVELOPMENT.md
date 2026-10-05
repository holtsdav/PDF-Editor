# Development and GitHub integration

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Commands, file menu, modal lifecycle |
| `src/pdf/inspect.ts` | Minimal PDF.js boundary and field/widget inspection |
| `src/ui/` | PDF inspection and pen diagnostic modals |
| `tests/` | Real, generated PDF integration fixtures parsed in memory |
| `scripts/` | Version updates, bundle/metadata checks, development installation |
| `.github/` | CI, draft releases, Dependabot, issue/PR templates |
| `docs/` | Research, proposed architecture, acceptance criteria |

No native viewer patches or PDF-writing code are present yet. Keep future undocumented viewer access in a dedicated adapter; keep file persistence and edit sessions outside UI classes.

## Local loop

1. Install Node.js 24 (`.nvmrc`) and run `npm ci`.
2. Run `npm run check` for lint, integration tests, type checking, build, and metadata validation.
3. Create/open an isolated Obsidian development vault so that its `.obsidian` directory exists.
4. Run `npm run build`, then `npm run install:dev -- "/absolute/path/to/vault"`.
5. Enable the plugin in that vault's community plugin settings.
6. Test **Inspect PDF form fields** and **Test pen input** from the command palette.
7. Rebuild/copy/reload after edits. `npm run dev` watches source and rebuilds `main.js`; it does not automatically copy builds or reload Obsidian.

The development installer supports standard `.obsidian` configuration folders. For a custom Obsidian configuration directory, manually copy the three assets into that config directory's `plugins/pdf-form-studio/`. The installer deliberately refuses destinations resolving through symlinks.

## Validation scope

Integration tests generate PDFs in memory with pdf-lib and parse them with upstream PDF.js 5.3.31. They verify shared field widgets across pages, read-only flags, printed lines without fields, and incomplete page scans. They do not prove native viewer compatibility or PDF editing/saving correctness.

The runtime obtains PDF.js through `loadPdfJs()`; neither development PDF library is bundled. The inspector scans at most 200 pages for visible widgets and reports incomplete coverage. Field discovery is supplemented with page widgets; it is not a full signature/encryption/XFA validator. Password-protected PDFs can fail inspection because no password UI is implemented.

The initial app minimum is conservative and provisional. Hardware diagnostics show what pointer events arrive; varying values should be tested with the actual Wacom device. Synthetic/unit tests cannot establish pressure support or latency.

Manual checks before trusting the scaffold in Obsidian:

| Check | Expected result |
| --- | --- |
| Enable/disable repeatedly | Commands/menu entries appear once, then disappear |
| Choose a flat worksheet | No discovered interactive fields; annotation path explained |
| Choose a multipage form | Field names/types and visible widget pages shown |
| Close inspector while loading | No late UI update or lingering PDF.js task |
| Draw with mouse | Mouse input and usually constant pressure shown |
| Draw with Wacom light/heavy | Actual received type/pressure range recorded |
| Unload with modals open | Modals close and listeners/resources are disposed |

## GitHub Actions

CI runs for branch pushes and pull requests, with read-only repository permissions. It runs `npm ci` and `npm run check`, then uploads `main.js`, `manifest.json`, and `styles.css` as a workflow artifact. Those generated files are ignored by Git. The package lock pins the dependency graph.

Dependabot checks development packages and Actions monthly. Runtime behavior remains independent of npm registry access. There are no project secrets or custom tokens required: release creation uses the repository-scoped `GITHUB_TOKEN`.

The lockfile overrides the API package's development-only Moment dependency to 2.31.0 to address its published path-traversal advisory. Obsidian itself supplies runtime modules; this override does not alter the installed app.

## Version and release workflow

From a clean checkout, update `minAppVersion` only after checking compatibility, then:

```sh
npm version patch
npm run check
git push origin main
git push origin --tags
```

The version hook updates the manifest and compatibility map. `.npmrc` removes npm's default `v` prefix, because Obsidian plugin release tags must be exact `x.y.z` versions. Validation rejects a tag/manifest mismatch.

Tag pushes run the checks and create a **draft** GitHub release. Review its three assets, release notes, and behavior in a development vault, then publish when the implementation is ready. Draft releases are not normal community installation releases. No tag or release is needed for this research scaffold.

Public community distribution requires making source and release assets accessible. Once ready, use [Obsidian's current submission guide](https://docs.obsidian.md/plugins/releasing/submit-plugin) and [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins). Do not submit the diagnostic-only scaffold as a finished PDF editor.

## Rules for upcoming PDF-writing work

Use the vault API for file writes; avoid runtime filesystem access. Do not rewrite on every pointer sample. Keep document sessions/queues keyed by vault PDF path, invalidate stale sessions after external file changes or renames, and close/dispose resources on unload. Verify both logical fields and appearances, standard annotation identity, independent rendering, and unchanged unrelated content before claiming successful saving.

Use anonymous test PDFs. Do not commit private worksheets, personal answers, local vault paths, or the user's Wacom configuration. MIT applies to this project's original code; review licensing before borrowing code or bundling fonts.
