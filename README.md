# PDF Editor

Write, fill answers, highlight and draw on PDFs without leaving Obsidian. Works in PDF tabs, notes and pop-out windows.

### Write and fill answers
<img src="assets/demos/text-and-answers.gif" alt="Add text and fill detected answer lines" width="480">

Existing editable form fields show their borders and backgrounds; click a field to type. Authored fields keep their geometry, alignment, length limits and multiline options. Opening a PDF or clearing an existing answer retains its blank fields. Only newly placed, unsaved empty boxes disappear when abandoned. Read-only and unsupported form fields retain their original appearances.

Text settings include Left, Center and Right alignment. Added text boxes also have letter spacing in PDF points (0–20 pt) and line spacing as a multiplier (0.8–3×, default 1.2×). These settings are saved in editable PDF appearances and shared undo/redo history. Authored forms retain their alignment until explicitly changed; spacing controls are disabled for authored forms. Ruled answer blocks keep their detected line pitch until resized into ordinary boxes.

The spacing controls share one compact row. Edit a value directly, use decimal points or commas, step with Up/Down, or drag its icon horizontally (right increases, left decreases). A completed drag is one undo operation; Escape, pointer cancellation, loss of window focus or closing the control cancels its preview. Text-box resizing uses one printable grapheme's font advance plus insets, or an M for an empty box, instead of a fixed 40-point floor. Wider remaining characters that cannot fit produce an explicit save error; text is retained without shrinking the font.

Text widgets omitted from the PDF's form tree are recovered when their identities and hierarchy are unambiguous. They become editable without changing the file on open; the recovered form tree is saved with the next edit. Ambiguous names and malformed field hierarchies are rejected before editing.

### Draw and highlight
<img src="assets/demos/ink-and-shapes.gif" alt="Draw, highlight and hold for shapes" width="480">

### Edit inside your notes
<img src="assets/demos/embeds-and-popouts.gif" alt="Edit PDFs in notes and pop-out windows" width="480">

Vertical wheel input scrolls the PDF while it has room, then sends the remaining distance to the enclosing note at either boundary. A PDF without a vertical scroll range lets the note scroll. Horizontal input retains native scrolling. Cmd/Ctrl+wheel and two-touch pinch handlers zoom around the pointer or midpoint within 35–300%; Fit width resets the view. Zoom's extra canvas margins do not trap vertical wheel input in blank space.

Development validation on macOS 27.0.1 with Obsidian 1.14.4 checked PDF tabs, Live Preview, Reading view and a PDF pop-out, including Unicode text, compact settings, spacing edits, toolbar undo/redo, shared pop-out edits, saves and reopen. Upward note handoff was observed in Live Preview. Regression tests independently inspect saved appearances with PDF.js and cover alignment, tracking, wrapping, glyph resize limits at quarter turns, zoom anchoring with clamped scroll bounds, Fit width at an unchanged scale, modifier-wheel cancellation of text placement, history ownership and interrupted scrubs. Physical pinch/momentum and native keyboard shortcuts remain unconfirmed: native automation lost its isolated-window target during testing. The final zoom-margin and wheel-cancellation adjustments are covered by automated tests but have not been exercised in Obsidian. Real Downloads drops, duplicate-name imports and interrupted gestures across every surface also remain unverified. These development changes have not been installed in a personal vault or released.

## Get started

[Open the Community plugin listing](https://community.obsidian.md/plugins/pdf-editor) and choose **Add to Obsidian**.

For manual installation, copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/holtsdav/PDF-Editor/releases/latest) into `.obsidian/plugins/pdf-editor/`, then enable **PDF Editor**.

Desktop only, Obsidian **1.13.7+**. Tested on Linux 1.14.4, with a basic check on 1.13.7; macOS 1.14.4 is user-confirmed. Windows and mobile are unverified.

**Beta:** keep backups and edit each PDF in only one app or device at a time. Wait for **Saved** and sync to finish before switching. Existing printed text cannot be rewritten; not every PDF is supported.

The PDF picker enumerates vault file names to find PDFs. Copy and paste use the system clipboard when invoked in the active PDF editor; pasted text can become PDF content. PDF Editor does not poll the clipboard in the background.

[MIT license](LICENSE) · [Third-party credits and licenses](THIRD_PARTY_NOTICES.txt)
