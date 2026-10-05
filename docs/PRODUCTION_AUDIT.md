# Production readiness audit — 2026-10-05

**Verdict: keep this as a development beta.** The audited working tree is materially safer, but unrestricted production use is not established. In particular, another process or sync writer can still win the gap between the final read and the binary replacement. Large files also impose substantial main-thread and memory costs.

This audit covers the in-progress 0.7.1 working tree, including its persistent editor. Existing local changes were retained. Nothing was published or tagged. Fixtures are anonymous and generated locally; PDFs and renders stay under ignored `tmp/` directories.

## Remaining release blockers

| Priority | Finding and evidence | Needed before expanding the support claim |
| --- | --- | --- |
| P1 | **An external update can be silently overwritten.** A controlled store inserted an external PDF update after the final stale read and immediately before `write`. The session finished as `saved`, but the external title/update was lost. Both pre-write comparisons and post-write read-back passed. | An explicit single-writer support contract, or a storage design with atomic compare-and-swap/locking across every writer. Public Obsidian `modifyBinary` has no compare-and-swap argument; an extra read alone cannot close this window. |
| P1 | **Recovery from an actually damaged source still needs a usable recovery flow.** A partial write now leaves a complete verified draft. Reopening that draft against damaged/different source bytes conservatively enters conflict. The ordinary Reload action cannot repair an unparseable source, and conflict disables in-place restore. | A tested, non-overwriting export/recovery workflow for the retained candidate, plus real process-termination and disk-failure exercises. Do not label the mocked I/O tests as power-loss durability. |
| P2 | **Rename/index operations are not a crash transaction.** File/folder moves and draft operations are serialized within one running registry, but the two draft filenames and plugin metadata are separate filesystem operations. Cold folder moves cannot locate every legacy unindexed draft; failure while moving/persisting can leave recovery files associated with an old path. | A resumable rename receipt and recovery-index reconciliation. Test termination after each rename/index boundary. Recovery bytes are retained; automatic association is not guaranteed. |
| P2 | **Large-file latency and memory remain significant.** In the final isolated Node run, five saves of a 25,180,015-byte synthetic image PDF took about 2.16 seconds in total, with a 135 ms event-loop-delay sample and roughly 658 MiB process peak RSS before verification. | Defined document/input limits, worker/off-main-thread work where possible, and app memory/latency measurements on representative documents. These numbers describe this test process, including its fixture/store, not Obsidian's exact memory footprint. |
| P2 | **Compatibility/corpus coverage is limited.** Current-build smoke tests cover four macOS app surfaces, but not Windows/Linux, other app builds, physical pens, arbitrary malformed/compressed PDFs, lengthy IME sessions, third-party writers, or a sustained real-world PDF corpus. | A release matrix and application soak tests. The recursive-tree guards are not a complete hostile-PDF sandbox or conformance validator. |

Existing intentional limits remain: unsupported glyphs fail saving; checkbox/radio/select editing is not implemented; signed/encrypted/XFA documents are not editable. Read-only/hidden/password widgets now retain their saved appearances rather than entering the plain-text editing layer.

## Confirmed defects fixed

The first added fault-injection tests failed against the original working tree. Regression coverage now includes these fixes:

- Reload and restore exclusively own the document queue. Editing is blocked while replacing a snapshot, preventing input typed during asynchronous I/O from disappearing under a clean/Saved state. Queued explicit saves also respect replacement epochs.
- A delayed external-change check cannot compare an old read against a newer save baseline and incorrectly freeze subsequent edits as a conflict.
- Explicit saves journal a complete verified candidate before writing the source. A source write that truncates and then throws retains the candidate and pending state. A leftover journal identical to the committed source reopens as saved.
- Drafts alternate between two checksummed, sequenced slots. A torn primary followed by another failed write cannot overwrite the only valid fallback. Cleanup removes the older slot first.
- Sessions follow `TFile` identity across folder moves. A removed/recreated path receives a new session, and the obsolete file object cannot overwrite its replacement. Recovery and journal work is serialized with rename operations; errors are surfaced.
- A missing original backup is not silently replaced with a newer edited PDF. Restore copies also alternate slots, so a failed next restore-copy write preserves the last reversal. Legacy originals named like restore slots remain protected. Recovery-index traversal paths are rejected.
- Foreign annotations that happen to share an owned ink `/NM` survive movement/deletion. Both the annotation subtype and ownership tag are required to target them.
- Password, read-only, rich-text, hidden and locked fields stay out of editable overlays. Hidden ink stays hidden. The writer preserves these existing appearances and flags.
- Duplicate canonical field names, inline signature dictionaries, cyclic/repeated page/form trees, cyclic parent chains and excessively deep trees reject editing before recursive library traversal. Empty/non-PDF/truncated inputs fail without source writes.
- Added text geometry/page/font/rotation is validated before mutating the session.
- Replaced appearance/font resources are reclaimed only when no live document object references them. Shared resources used by untouched widgets are retained. Ink-only saves no longer embed an unused text font.
- Clean sessions release document/undo state after the last editor closes. Failed/conflicted sessions remain available. Superseded PDF.js loading tasks are destroyed; search promise failures are caught.

## Executed verification

`npm run check` passes **88 regression tests**, ESLint, TypeScript, production bundling and plugin metadata validation. `npm run test:stress` adds **4 stress workloads**. `npm audit --json` reported **0 known dependency vulnerabilities** at the time of the audit; this is not a security certification.

| Workload | Result |
| --- | --- |
| 1,200 deterministic mixed text/ink/undo/redo operations; 240 overlapping save/checkpoint/external-check requests | Final values, geometry, styles and IDs agree after every batch; maximum concurrent source writers = 1; 40 physical writes; original page text, links, checkboxes and title retained. Approximately 1.8–2.1 seconds. |
| 120 pages; 1,200 strokes; 153,600 points | All strokes and page counts survive. Independent PDF.js checks beginning/middle/end pages and appearance operators. Approximately 1.5–1.8 seconds; about 2.24 MB output. |
| 50 reopen/edit/save cycles | Before the fix: 7,446 → 222,346 bytes (29.86×). After: approximately 7.1 → 7.4 KB (1.04×). The regression enforces less than 1.2× growth. |
| Eight pages with 24 MiB of incompressible RGB image samples; five rewrites | Every compressed image stream remains byte-identical. The logical edited value survives reopening. The isolated save-path timing/memory result is listed above. |
| Malformed trees and interrupted I/O | Repeated/cyclic structure rejection; partial source writes; torn draft fallback; missing/corrupt backups; interrupted restore copy; source identity replacement; reload/restore locking and stale-read races. These use controlled in-memory adapters. |

PDF.js independently parsed forms/annotations/operators. Poppler successfully rendered the mixed-edits fixture, page 120 of the ink fixture, and the image-heavy fixture; those renders were visually inspected. Poppler emitted a local Fontconfig configuration warning, although the rendered pages and embedded text were present. Rendering was sampled, not performed on every page in every workload.

## Current-build application smoke test

Used the existing isolated development vault in Obsidian 1.13.7 on macOS with a newly generated two-page fixture. The installed `main.js` hash matched the audited build.

- Reading view, Live Preview, standalone PDF tab and pop-out each accepted and saved an authored text-field edit.
- Read-only appearance content remained visible and was absent from the editable-field accessibility controls.
- Three pop-out pen strokes were saved. Undo removed the latest stroke; redo restored it; saving retained all three.
- Restore original returned the original answers and removed the new strokes. Undo last restore recovered the final answer and all three strokes.
- Independent disk parsing confirmed the final answer, the three ink annotations and the untouched read-only values. The embedding Markdown was byte-for-byte unchanged.
- After the final appearance-resource fix, the app was reloaded again and a further PDF-tab edit saved successfully. Independent parsing and the installed build hash were rechecked.

This was a smoke test, not a full rerun of every old gesture/theme/zoom/keyboard test. No actual application kill, power cut, real disk exhaustion or physical stylus was used.

## Reproduce

```sh
npm ci
npm run check
npm run test:stress
node --test --test-name-pattern='24 MiB' tests/stress/*.test.ts
npm audit
```

Stress output PDFs are written to ignored `tmp/production-audit/`. The random operation seed is fixed in the workload. Timings are observations, not pass/fail budgets. Do not downgrade to an older journal reader with pending edits; reach Saved and copy the recovery directory first.
