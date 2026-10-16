import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const base = import.meta.env.BASE_URL;

export async function openPdf(bytes) {
  // pdf.js transfers (detaches) the buffer it is given, so hand it a copy.
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    fontExtraProperties: true,
    isEvalSupported: false,
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new Error("This PDF is password protected. Please upload an unlocked copy.");
    }
    throw new Error("Could not read this file. Make sure it is a valid PDF.");
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Extracts editable text runs from a page, in PDF user space. */
export async function extractTextItems(page, pageIndex) {
  const content = await page.getTextContent();
  const items = [];
  content.items.forEach((it, idx) => {
    if (!("str" in it) || !it.str.trim()) return;
    const [a, b, c, d] = it.transform;
    const xScale = Math.hypot(a, b);
    const yScale = Math.hypot(c, d);
    const style = content.styles[it.fontName] || {};
    if (!xScale || !yScale || !it.width || style.vertical) return;
    items.push({
      id: `${pageIndex}:${idx}`,
      pageIndex,
      str: it.str,
      fontName: it.fontName,
      // Maps glyph space (1 unit = 1 em, y up) to page user space.
      transform: it.transform,
      widthEm: it.width / xScale,
      fontSizePt: yScale,
      ascent: clamp(style.ascent || 0.8, 0.6, 1.05),
      descent: clamp(style.descent || -0.22, -0.35, -0.12),
    });
  });
  return items;
}
