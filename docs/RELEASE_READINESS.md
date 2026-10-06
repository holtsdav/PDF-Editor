# Release readiness — 2026-10-06

**Status: development beta; do not claim general production safety or submit to the Community directory yet.** This is a current checklist, not a claim that all supported PDFs or operating systems have been exercised. See the [production audit](PRODUCTION_AUDIT.md) for fault injection and the [testing log](TESTING.md) for historical app checks.

## Verified in this working tree

- `npm run check`: 155 tests, lint, TypeScript, production build and metadata validation passed.
- `npm run test:stress`: four workloads passed. The 24 MiB image fixture needed about 2.1 seconds for five PDF rewrites, with a 130 ms event-loop delay sample and roughly 1.2 GiB peak RSS in the isolated Node test process. These are not Obsidian app memory measurements.
- `main.js` is ignored and not tracked; the build and manifest use version `0.7.10` and retain the installed ID `pdf-form-studio`. `README.md`, `LICENSE`, `manifest.json`, `versions.json`, and a draft-release workflow exist. The manifest marks the plugin desktop-only.
- The toolbar offset setting accepts 0–160 px, defaults to 0, and updates open surfaces. A checked build was installed in the existing local vault, reloaded, and its slider and visible toolbar movement were observed in Obsidian 1.14.4 on macOS.
- A fresh dependency advisory check could not run because the terminal could not reach npm's registry. The earlier audit's zero-vulnerability result is historical.

## Safety gates before broad use

1. **External writers:** another process or sync engine can change a PDF after the final stale read and before `Vault.modifyBinary`; the current save path has no atomic compare-and-swap. Decide and document a single-writer support contract, or implement cross-writer coordination that actually closes this window. Repeat the controlled race test.
2. **Damaged-source recovery:** make the complete verified draft exportable to a new file without overwriting the source when the source is unparseable or conflicted. Exercise actual app termination and disk-failure recovery, then verify the exported PDF independently.
3. **Rename/index recovery:** add a resumable receipt and reconciliation for file/folder moves and metadata writes. Test interruption after each storage boundary and reopen from a cold process.
4. **Resource limits:** set and enforce sensible PDF/page/annotation/input limits, and measure peak memory, latency and UI responsiveness inside Obsidian with representative large files. Avoid promising arbitrary-size support based on synthetic Node workloads.
5. **Compatibility and polish:** test the final build on macOS, Windows and Linux at the declared minimum app version and current stable release. Cover Reading view, Live Preview, PDF tabs, pop-outs, themes, narrow embeds, zoom/rotation, keyboard and IME, third-party PDF plugins, external changes and a varied PDF corpus. Check unsupported-document fallback and physical pen hardware where advertised. Native outlines, thumbnails, PDF context-menu actions and new subpath navigation remain feature gaps; either implement them or describe them clearly for the first release.

## Community directory gates

1. Finish the safety and compatibility gates; decide the supported PDF and single-writer limits and state them prominently in the README and release notes. Recheck third-party license notices, bundled assets, production bundle and dependency advisories.
2. Commit the reviewed source and metadata, including this untracked/in-progress work. Confirm the GitHub repository is public and the default branch contains the final `README.md`, `LICENSE`, `manifest.json` and source. The README currently describes the repository as private; a live GitHub visibility check failed because the terminal could not reach GitHub.
3. Confirm the global uniqueness of `pdf-form-studio`, the `minAppVersion` supported by final app tests, and that the manifest description and desktop scope match the shipped build. Run the official plugin guidelines/review checks on the release candidate.
4. Tag an exact `x.y.z` version matching the manifest, verify the workflow's draft release assets (`main.js`, `manifest.json`, `styles.css`) and their install behavior, then publish the GitHub release. A draft release alone cannot be installed by Community users.
5. Sign in at the [Obsidian Community directory](https://community.obsidian.md/), connect the GitHub account, and submit the repository with **Plugins → New plugin**. Address automated and human review feedback with a new version/release as needed. The current official workflow uses this form, not a pull request to `obsidian-releases`.

Official references: [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin), [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins), [Developer policies](https://docs.obsidian.md/community-directory/developer-policies), [Community release asset behavior](https://github.com/obsidianmd/obsidian-releases#how-community-plugins-are-pulled).
