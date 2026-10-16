# Teleforce PDF Editor

A React web app for the sales team to edit the text of an existing PDF and download the result.

1. Upload a PDF (drag and drop, or click to choose a file).
2. Click any paragraph and type. Text **wraps inside the original column**, and `Enter` starts a new line. Bold and regular words inside a paragraph keep their own font, size and colour.
3. Click outside the paragraph to finish, or press `Esc` to cancel that edit.
4. Click **Download PDF** (or press `Ctrl+S`) to get `<name>-edited.pdf`.

**Copy and paste between text boxes:** text copied inside the editor remembers its font, size and colour. When you paste it somewhere with a different style, a small menu asks how to paste it:

- **Keep source formatting** (`Enter`) pastes the text exactly as it looked where you copied it (for example, green "Confirmed").
- **Match destination** (`M`) pastes the text in the style of the place you paste into (for example, yellow like "Pending").
- **Cancel** (`Esc`) pastes nothing.

Text copied from outside the editor always matches the destination.

The **Revert** button on the floating bar undoes a single paragraph, and **Reset all** undoes every change.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/ (static files, host anywhere)
```

Everything runs in the browser. PDFs are never uploaded to a server.

## How it works

| Step | What happens | Code |
| --- | --- | --- |
| Render | pdf.js draws each page and returns every text run with its position, size and font. | `src/lib/pdfjs.js`, `src/components/PdfPage.jsx` |
| Paragraphs | Text runs on the same baseline become lines. Lines with the same size, regular spacing and a shared left/right/centre edge become one paragraph. Alignment (left, right, centre, justified), first-line and hanging indents, and the column width are detected too. | `src/lib/layout.js` |
| Same font on screen | The font embedded in the PDF is extracted from pdf.js and loaded as a web font, so the editable text uses the real typeface. Its character map is rebuilt so ligature glyphs ("ti", "fi"…) never replace normal letters. | `src/lib/fonts.js`, `src/lib/sfnt.js` |
| Editing | Each paragraph is a rich-text editor whose wrapping matches the original. The exact line breaks the editor shows are measured and reused for the PDF. | `src/components/TextBlock.jsx` |
| Colours | The rendered page is sampled to find each run's text colour and background colour. | `src/lib/colors.js` |
| Remove old text | The page content stream is parsed, and the original text operators of each edited run are replaced with blank moves of the same width. The old wording therefore can't be selected, copied or found by search, and the rest of the line stays exactly in place. | `src/lib/contentStream.js` |
| Write new text | pdf-lib re-embeds the original fonts and draws each wrapped line, applying the paragraph's alignment (including justification). | `src/lib/exportPdf.js` |

### Letters that aren't in the PDF

PDFs usually embed only the letters they actually use (a "subset"). If you type a letter the PDF never contained, for example a `G` in a document that had none:

1. **Chrome/Edge:** the app asks for permission to use locally installed fonts, then embeds the **full installed copy of the same font** (Calibri, Arial, Times New Roman, …), so the result is visually identical.
2. Otherwise the closest standard PDF font is used (Helvetica, Times or Courier, with matching bold and italic).
3. Symbols such as `₹` that the standard fonts can't encode use DejaVu Sans.

When this happens, the floating bar above the text you're editing shows a ⚠ warning.

## Limitations

- A PDF has no page flow: if a paragraph becomes longer than its original space, it overlaps whatever is below it. The floating bar shows "longer than original" when that happens.
- Single-line text (headings, labels) does not wrap; it just extends to the right.
- Paragraph detection is heuristic. If two paragraphs get merged or split differently than expected, edit them as they are grouped. `Enter` and `Backspace` let you fix line breaks.
- Scanned PDFs (images of text) have no editable text.
- Password-protected or encrypted PDFs can't be saved. Upload an unlocked copy.
- Text drawn inside form XObjects (rare) is covered and redrawn but not removed from the file.
