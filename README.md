# PDF Editor

Write, fill answers, highlight and draw on PDFs without leaving Obsidian. Works in PDF tabs, notes and pop-out windows.

### Write and fill answers
<img src="assets/demos/text-and-answers.gif" alt="Add text and fill detected answer lines" width="480">

Existing editable form fields show their borders and backgrounds; click a field to type. Authored fields keep their geometry, alignment, length limits and multiline options. Opening a PDF or clearing an existing answer retains its blank fields. Only newly placed, unsaved empty boxes disappear when abandoned. Read-only and unsupported form fields retain their original appearances.

Text widgets omitted from the PDF's form tree are recovered when their identities and hierarchy are unambiguous. They become editable without changing the file on open; the recovered form tree is saved with the next edit. Ambiguous names and malformed field hierarchies are rejected before editing.

Text options include **Letter spacing** (0–20 pt, default 0) and **Line spacing** (0.8–3×, default 1.2) for added text boxes. Changes are saved in editable PDF appearances and survive copy, undo and reopen. Detected answer blocks keep their printed line pitch; resize the box before choosing custom line spacing. Authored form fields retain their existing layout. Other PDF editors may regenerate appearances with their own spacing when editing a field.

### Draw and highlight
<img src="assets/demos/ink-and-shapes.gif" alt="Draw, highlight and hold for shapes" width="480">

Selected drawings and marker strokes have resize handles. Drag a handle or use its arrow keys; hold Shift on a corner to keep proportions. Resizing preserves the mark's identity, color, opacity and line thickness. Escape and interrupted gestures cancel the preview.

Enable **Snap to text** in Highlighter options to align marks with selectable words. Separate lines remain separate editable marks and one gesture is one undo action. Scanned pages, uncertain text geometry and unsupported text sizes remain freehand; this is not OCR.

Use **Cmd/Ctrl+Z** and **Cmd/Ctrl+Shift+Z** for undo and redo while the PDF editor owns focus. Typing retains native text-input undo. Object history is shared across PDF views and ordinary saves, and resets on reload or restore.

### Edit inside your notes
<img src="assets/demos/embeds-and-popouts.gif" alt="Edit PDFs in notes and pop-out windows" width="480">

## Get started

[Open the Community plugin listing](https://community.obsidian.md/plugins/pdf-editor) and choose **Add to Obsidian**.

For manual installation, copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/holtsdav/PDF-Editor/releases/latest) into `.obsidian/plugins/pdf-editor/`, then enable **PDF Editor**.

Desktop only, Obsidian **1.13.7+**. Tested on Linux 1.14.4, with a basic check on 1.13.7; macOS 1.14.4 is user-confirmed. Windows and mobile are unverified.

Those app compatibility checks predate 0.8.0. This version has automated PDF and interaction regression coverage and an isolated-vault installation check on macOS 27.0.1 / Obsidian 1.14.4. Final feature checks in Reading view, Live Preview, PDF tabs and pop-out windows, including native drag/drop cleanup, are pending. The minimum-version feature checks and physical stylus behavior are also unverified.

**Beta:** keep backups and edit each PDF in only one app or device at a time. Wait for **Saved** and sync to finish before switching. Existing printed text cannot be rewritten; not every PDF is supported.

The PDF picker enumerates vault file names to find PDFs. Copy and paste use the system clipboard when invoked in the active PDF editor; pasted text can become PDF content. PDF Editor does not poll the clipboard in the background.

**Move original PDF to Trash after import** is an optional setting, off by default. It observes the native external PDF drop into a note, verifies the exact imported attachment and source, then uses system Trash. It never permanently deletes a source or removes vault PDFs or recovery copies. Changed, failed, cancelled, ambiguous or unsupported imports keep their originals. Cleanup also skips linked/symlinked sources and batches above 32 PDFs or 100 MB. It uses a guarded desktop native-import compatibility hook; future host changes can make cleanup unavailable. Verification and moving a path to Trash are not one atomic operation, so an external replacement in the final verification/trash interval remains a limitation.

[MIT license](LICENSE) · [Third-party credits and licenses](THIRD_PARTY_NOTICES.txt)
