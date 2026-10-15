# PDF Editor

Write, fill answers, highlight and draw on PDFs without leaving Obsidian. Edit in PDF tabs, notes and pop-out windows.

### Write and fill answers

<img src="assets/demos/text-and-answers.gif" alt="Add text and fill detected answer lines" width="480">

Click an editable form field to type, or add your own text box. Adjust font, size, color and alignment. Added text boxes also support letter and line spacing: drag a spacing value to adjust it, or click to type a number.

Use **Detect answer lines** to find places to type on worksheets. Longer answers can wrap across consecutive lines.

### Draw and highlight

<img src="assets/demos/ink-and-shapes.gif" alt="Draw, highlight and hold for shapes" width="480">

Draw with the pen or highlighter, then select a mark to move or resize it. Hold **Shift** while dragging a corner to keep its proportions. Press **Escape** to cancel a drag.

Enable **Snap to text** in the highlighter options to follow printed text. When text is unavailable, highlighting falls back to freehand. Optional drawing assistance smooths strokes and snaps held lines and shapes.

### Edit inside your notes

<img src="assets/demos/embeds-and-popouts.gif" alt="Edit PDFs in notes and pop-out windows" width="480">

Work in Reading view, Live Preview or a separate PDF window. Scrolling continues into the surrounding note when you reach the PDF's edge.

Select printed text to copy it. Zoom with the viewer controls or **Cmd/Ctrl + wheel**, and use **Fit width** to reset. Undo and redo are shared across views of the same PDF.

## Get started

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/holtsdav/PDF-Editor/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/pdf-editor/`.
3. Enable **PDF Editor** under **Settings → Community plugins**.

Requires **Obsidian 1.13.7+**, desktop only. Windows support is unverified.

**Beta:** Keep backups, edit each PDF in only one app or device at a time, and wait for **Saved** and sync before switching. Existing printed text cannot be rewritten. Encrypted PDFs, XFA forms and documents containing signature fields are not supported for editing.

[MIT license](LICENSE) · [Third-party credits and licenses](THIRD_PARTY_NOTICES.txt)

## Changelog

### 0.8.2

- Text alignment, letter spacing and line spacing with compact controls.
- Resizable drawings and optional highlighter snapping to text.
- Improved zoom, scrolling, printed-text selection and shared undo/redo.
- Better handling of large PDFs.
- Loading fixes for PDFs saved by Apple Preview and other editors, including incremental updates and empty object indexes.
- Optional Trash cleanup for imported originals, off by default.
