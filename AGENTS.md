# PDF_Editor / PDF Editor

This repository contains research and a first text editing development beta for Obsidian. Read `README.md`, `docs/RESEARCH.md`, `docs/ROADMAP.md`, and `docs/TESTING.md` before extending editing features. Keep implementation status accurate in the README and manifest description.

## Working conventions

- Use Node.js 24, TypeScript, and the public Obsidian API wherever possible.
- Run `npm run check` after code or build changes. Keep `package-lock.json` synchronized with dependencies.
- Do not bundle Obsidian, Node/Electron modules, or development fixture libraries in `main.js`.
- Keep undocumented native PDF viewer access isolated in a compatibility adapter. Test Reading view, Live Preview, PDF tabs, and pop-out windows before claiming support.
- Register/dispose listeners, observers, modals, PDF.js tasks, and any editor sessions using the relevant component lifecycle.
- Use the vault API for PDF persistence. Separate UI state from document sessions and save queues.
- Before implementing PDF writes, establish backup/recovery, stale-session detection, serialized writes, and verification of logical values and appearance streams.
- Preserve editable forms and standard annotations. Use stable IDs; avoid accidental flattening or duplicate items on repeated saves.
- Keep private PDFs, answers, vault paths, hardware details, and credentials out of Git.
- Commit source and metadata; generated `main.js` belongs in workflow artifacts/releases.
- Use exact `x.y.z` plugin release tags with no `v` prefix. The release workflow creates drafts.

The plugin ID is `pdf-form-studio`; PDF_Editor is the folder/repository name. The minimum app version and desktop scope are provisional until real app/hardware tests establish compatibility.
