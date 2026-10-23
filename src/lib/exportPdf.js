// Writes paragraph edits into the original PDF:
//   1. the original glyphs of each edited paragraph are removed from the page
//      content (see contentStream.js); if that is not fully possible they are
//      covered with the sampled background colour instead;
//   2. the new text is drawn line by line, exactly as it was wrapped in the
//      editor, with each run's original embedded font, size and colour.
// Letters missing from an embedded font subset fall back to the installed
// copy of the same font, then to a standard PDF font.
import {
  PDFDocument,
  StandardFonts,
  beginText,
  concatTransformationMatrix,
  endText,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import dejaVuSansUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import dejaVuSansBoldUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";
import { getFontInfo, isWinAnsi, resolveVariant } from "./fonts.js";
import { removeOriginalText } from "./contentStream.js";
import { lineGapOf } from "./entries.js";
import { findLocalFont } from "./localFonts.js";

function standardFontFor(info) {
  const b = info?.bold, i = info?.italic;
  if (info?.mono) return b && i ? StandardFonts.CourierBoldOblique : b ? StandardFonts.CourierBold : i ? StandardFonts.CourierOblique : StandardFonts.Courier;
  if (info?.serif) return b && i ? StandardFonts.TimesRomanBoldItalic : b ? StandardFonts.TimesRomanBold : i ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  return b && i ? StandardFonts.HelveticaBoldOblique : b ? StandardFonts.HelveticaBold : i ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

const unit = (c) => [c.r / 255, c.g / 255, c.b / 255];

export async function exportEditedPdf(originalBytes, entries) {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) {
    throw new Error("This PDF is encrypted, so it cannot be saved with changes. Please upload an unencrypted copy.");
  }
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();

  const cache = new Map();
  const once = (key, make) => {
    if (!cache.has(key)) cache.set(key, make().catch(() => null));
    return cache.get(key);
  };
  const embedOriginal = (info) =>
    once(`orig:${info.loadedName}`, () =>
      // fontkit's subsetter is reliable for TrueType but not for CFF fonts.
      doc.embedFont(info.data, { subset: info.mimetype === "font/truetype" })
    );
  // Full installed copy of the font, for letters missing from the PDF's subset.
  const embedLocal = (info) =>
    once(`local:${info.loadedName}`, async () => {
      const bytes = await findLocalFont(info);
      if (!bytes) return null;
      const fk = fontkit.create(bytes);
      const isCff = String.fromCharCode(...bytes.subarray(0, 4)) === "OTTO";
      const font = await doc.embedFont(bytes, { subset: !isCff });
      return { font, hasGlyph: (ch) => fk.hasGlyphForCodePoint(ch.codePointAt(0)) };
    });
  // Installed font of the same family in another style (bold / italic).
  const embedLocalStyle = (info, bold, italic) =>
    once(`localstyle:${info.families.join("|")}:${bold}:${italic}`, async () => {
      const bytes = await findLocalFont({ psName: "", families: info.families, bold, italic });
      if (!bytes) return null;
      const fk = fontkit.create(bytes);
      const isCff = String.fromCharCode(...bytes.subarray(0, 4)) === "OTTO";
      const font = await doc.embedFont(bytes, { subset: !isCff });
      return { font, hasGlyph: (ch) => fk.hasGlyphForCodePoint(ch.codePointAt(0)) };
    });
  const embedStandard = (name) => once(`std:${name}`, () => doc.embedFont(name));
  const embedUnicode = (bold) =>
    once(`uni:${bold}`, async () => {
      const bytes = await fetch(bold ? dejaVuSansBoldUrl : dejaVuSansUrl).then((r) => r.arrayBuffer());
      return doc.embedFont(bytes, { subset: true });
    });

  /**
   * Splits one styled run into drawable parts: { font, text, width } for
   * glyphs and { gap, width, space } for spaces the chosen font cannot draw.
   * Widths are in pt.
   */
  async function resolveRun(run, needsAll) {
    // Bold / italic: the document's own variant, else the installed one,
    // else the original font with simulated bold / slant.
    const v = resolveVariant(run);
    const info = v.info || (await getFontInfo(run.fontName));
    const chars = [...run.text];
    let primary = null;
    let local = null;
    let synthBold = false;
    let synthItalic = false;
    let styleInfo = info;
    if (v.exact || !info) {
      primary = info?.embedded ? await embedOriginal(info) : null;
      if (chars.some((ch) => !(primary && info.hasGlyph(ch))) && info) local = await embedLocal(info);
    } else {
      styleInfo = { ...info, bold: v.bold, italic: v.italic };
      local = await embedLocalStyle(info, v.bold, v.italic);
      const removing = (!v.bold && info.bold) || (!v.italic && info.italic);
      if (!local && !removing && info.embedded) {
        primary = await embedOriginal(info);
        synthBold = v.bold && !info.bold;
        synthItalic = v.italic && !info.italic;
        if (chars.some((ch) => !info.hasGlyph(ch))) local = await embedLocal(info);
      }
    }
    const standard = await embedStandard(standardFontFor(styleInfo));
    const has = (font, ch) =>
      font === primary ? info.hasGlyph(ch) : font === local?.font ? local.hasGlyph(ch) : font === standard ? isWinAnsi(ch) : true;
    const spaceFont = primary && info.hasGlyph(" ") ? primary : local?.hasGlyph(" ") ? local.font : standard;
    const spaceWidth = spaceFont.widthOfTextAtSize(" ", run.size);

    // Prefer one font for the whole run: the PDF's own, else the installed copy.
    let pick;
    if (primary && chars.every((ch) => ch === " " || info.hasGlyph(ch))) pick = () => primary;
    else if (local && chars.every((ch) => local.hasGlyph(ch))) pick = () => local.font;
    else
      pick = async (ch) =>
        primary && info.hasGlyph(ch) ? primary : local?.hasGlyph(ch) ? local.font : isWinAnsi(ch) ? standard : embedUnicode(info?.bold);

    const parts = [];
    for (const ch of chars) {
      const last = parts[parts.length - 1];
      if (ch === " ") {
        // Separate spaces when justifying, so the gaps can be stretched.
        if (!needsAll && last?.font && has(last.font, " ")) last.text += ch;
        else parts.push({ gap: true, space: true, width: spaceWidth, underline: !!run.underline, size: run.size, color: run.color });
        continue;
      }
      const font = await pick(ch);
      if (!font) continue;
      if (last?.font === font) last.text += ch;
      else parts.push({ font, text: ch });
    }
    for (const p of parts) {
      if (!p.gap) p.width = p.font.widthOfTextAtSize(p.text, run.size);
      p.size = run.size;
      p.color = run.color;
      p.underline = !!run.underline;
      // Simulated styles apply to the original-style fonts, not to the
      // standard fallback (which already has the right style).
      const original = p.font === primary || (synthBold || synthItalic ? p.font === local?.font : false);
      p.synthBold = synthBold && original;
      p.synthItalic = synthItalic && original;
    }
    return parts;
  }

  // 1. Remove the original wording from each page.
  const byPage = new Map();
  for (const entry of entries) byPage.set(entry.pageIndex, [...(byPage.get(entry.pageIndex) || []), entry]);
  const cleared = new Set();
  for (const [pageIndex, list] of byPage) {
    if (!pages[pageIndex]) continue;
    const targets = list.flatMap((e) => e.block.items);
    for (const it of removeOriginalText(doc, pages[pageIndex], targets)) cleared.add(it);
  }

  // 2. Draw each edited paragraph.
  for (const entry of entries) {
    const page = pages[entry.pageIndex];
    if (!page) continue;
    // Wraps the existing content in q/Q so our drawing starts from a clean state.
    page.node.normalize();
    const b = entry.block;
    const lines = entry.lines || [{ runs: entry.content, hard: true }];
    const align = entry.align || b.align;
    const justify = align === "justify";

    const laid = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stretch = justify && !line.hard && i < lines.length - 1;
      // Trailing spaces never take part in alignment.
      const runs = line.runs.map((r) => ({ ...r, text: r.text.replace(/\n/g, "") }));
      for (let k = runs.length - 1; k >= 0; k--) {
        runs[k].text = runs[k].text.replace(/\s+$/, "");
        if (runs[k].text) break;
      }
      const parts = [];
      for (const run of runs) if (run.text) parts.push(...(await resolveRun(run, stretch)));
      const natural = parts.reduce((w, p) => w + p.width, 0);
      const indent = i === 0 ? b.indent : 0;
      const avail = b.wrapWidth != null ? b.wrapWidth - indent : natural;
      let x = b.editorLeft + indent;
      let extra = 0;
      if (b.wrapWidth != null) {
        if (align === "center") x += (avail - natural) / 2;
        else if (align === "right") x += avail - natural;
        else if (stretch) {
          const spaces = parts.filter((p) => p.space).length;
          if (spaces && avail > natural) extra = (avail - natural) / spaces;
        }
      }
      laid.push({ parts, x, extra, y: b.firstBaseline - i * lineGapOf(entry), width: natural + extra * parts.filter((p) => p.space).length });
    }

    // Local frame (x along the text, y up) -> page user space.
    const { cos, sin } = b;
    const toUser = (x, y) => [x * cos - y * sin, x * sin + y * cos];
    const ops = [];

    // Cover only if the original glyphs could not all be removed: the
    // original paragraph area plus each new line, never the whole column.
    if (!b.items.every((it) => cleared.has(it))) {
      const pad = 0.1 * b.size;
      const rects = [[b.boxLeft - pad, b.bottom - pad, b.x1 - b.boxLeft + 2 * pad, b.top - b.bottom + 2 * pad]];
      for (const l of laid) {
        if (l.width > 0) rects.push([l.x - pad, l.y + b.descent * b.size - pad, l.width + 2 * pad, (b.top - b.firstBaseline - b.descent * b.size) + 2 * pad]);
      }
      ops.push(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, 0, 0), setFillingRgbColor(...unit(entry.bg)));
      for (const r of rects) ops.push(rectangle(...r), fill());
      ops.push(popGraphicsState());
    }

    ops.push(pushGraphicsState(), beginText());
    let color = null;
    let outlined = false;
    const underlines = [];
    for (const line of laid) {
      let x = line.x;
      for (const p of line.parts) {
        const w = p.width + (p.space ? line.extra : 0);
        if (p.underline) {
          const last = underlines[underlines.length - 1];
          if (last && last.line === line && Math.abs(last.x1 - x) < 0.01 && last.size === p.size) last.x1 = x + w;
          else underlines.push({ line, x0: x, x1: x + w, size: p.size, color: p.color });
        }
        if (p.gap) {
          x += w;
          continue;
        }
        const key = page.node.newFontDictionary(p.font.name, p.font.ref);
        const c = unit(p.color);
        if (!color || c.some((v, k) => v !== color[k])) {
          ops.push(setFillingRgbColor(...c), setStrokingRgbColor(...c));
          color = c;
        }
        // Simulated bold: fill and outline the glyphs.
        if (p.synthBold !== outlined) {
          ops.push(setTextRenderingMode(p.synthBold ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill));
          if (p.synthBold) ops.push(setLineWidth(p.size * 0.035));
          outlined = p.synthBold;
        }
        // Simulated italic: slant the glyphs by ~11 degrees.
        const k = p.synthItalic ? 0.2 : 0;
        const [ux, uy] = toUser(x, line.y);
        ops.push(
          setFontAndSize(key, p.size),
          setTextMatrix(cos, sin, k * cos - sin, k * sin + cos, ux, uy),
          showText(p.font.encodeText(p.text))
        );
        x += p.width;
      }
    }
    ops.push(endText(), popGraphicsState());
    if (underlines.length) {
      ops.push(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, 0, 0));
      for (const u of underlines) {
        const thickness = Math.max(0.05 * u.size, 0.5);
        ops.push(setFillingRgbColor(...unit(u.color)), rectangle(u.x0, u.line.y - 0.12 * u.size - thickness / 2, u.x1 - u.x0, thickness), fill());
      }
      ops.push(popGraphicsState());
    }
    page.pushOperators(...ops);
  }

  const bytes = await doc.save();
  return { bytes, cleared: cleared.size };
}
