# PDF Editor

Write, fill answers, highlight and draw on PDFs without leaving Obsidian. Works in PDF tabs, notes and pop-out windows.

### Write and fill answers
<img src="assets/demos/text-and-answers.gif" alt="Add text and fill detected answer lines" width="480">

Existing editable form fields show their borders and backgrounds; click a field to type. Authored fields keep their geometry, alignment, length limits and multiline options. Opening a PDF or clearing an existing answer retains its blank fields. Only newly placed, unsaved empty boxes disappear when abandoned. Read-only and unsupported form fields retain their original appearances.

Text widgets omitted from the PDF's form tree are recovered when their identities and hierarchy are unambiguous. They become editable without changing the file on open; the recovered form tree is saved with the next edit. Ambiguous names and malformed field hierarchies are rejected before editing.

### Draw and highlight
<img src="assets/demos/ink-and-shapes.gif" alt="Draw, highlight and hold for shapes" width="480">

### Edit inside your notes
<img src="assets/demos/embeds-and-popouts.gif" alt="Edit PDFs in notes and pop-out windows" width="480">

## Get started

[Open the Community plugin listing](https://community.obsidian.md/plugins/pdf-editor) and choose **Add to Obsidian**.

For manual installation, copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/holtsdav/PDF-Editor/releases/latest) into `.obsidian/plugins/pdf-editor/`, then enable **PDF Editor**.

Desktop only, Obsidian **1.13.7+**. Tested on Linux 1.14.4, with a basic check on 1.13.7; macOS 1.14.4 is user-confirmed. Windows and mobile are unverified.

**Beta:** keep backups and edit each PDF in only one app or device at a time. Wait for **Saved** and sync to finish before switching. Existing printed text cannot be rewritten; not every PDF is supported.

The PDF picker enumerates vault file names to find PDFs. Copy and paste use the system clipboard when invoked in the active PDF editor; pasted text can become PDF content. PDF Editor does not poll the clipboard in the background.

[MIT license](LICENSE) · [Third-party credits and licenses](THIRD_PARTY_NOTICES.txt)
