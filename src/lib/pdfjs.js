import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { applyPoint, multiply } from "./geometry.js";

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

const { OPS } = pdfjsLib;
const STROKE_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILL_OPS = new Set([OPS.fill, OPS.eoFill]);

/**
 * Finds the ruling lines on a page (table borders, separators), in PDF user
 * space, as segments { x0, y0, x1, y1 }. Text is never grouped across them.
 */
export async function extractRules(page) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const rules = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let pending = []; // subpaths (point lists, page space) of the current path

  const addSubpaths = (stroked) => {
    for (const pts of pending) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const w = maxX - minX, h = maxY - minY;
      // A thin shape (a hairline rectangle or a drawn line) is a rule.
      if (Math.min(w, h) <= 2.5 && Math.max(w, h) >= 4) {
        if (w < h) rules.push({ x0: (minX + maxX) / 2, y0: minY, x1: (minX + maxX) / 2, y1: maxY });
        else rules.push({ x0: minX, y0: (minY + maxY) / 2, x1: maxX, y1: (minY + maxY) / 2 });
      } else if (stroked) {
        // The axis-aligned edges of a stroked box (e.g. a table cell).
        pts.forEach((p, i) => {
          const q = pts[(i + 1) % pts.length];
          const dx = Math.abs(p[0] - q[0]), dy = Math.abs(p[1] - q[1]);
          if ((dx < 0.5 || dy < 0.5) && Math.max(dx, dy) >= 4) rules.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1] });
        });
      }
    }
    pending = [];
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      let cur = null;
      const pt = (x, y) => applyPoint(ctm, x, y);
      for (let k = 0, j = 0; k < ops.length; k++) {
        switch (ops[k]) {
          case OPS.rectangle: {
            const [x, y, w, h] = coords.slice(j, (j += 4));
            pending.push([pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]);
            cur = null;
            break;
          }
          case OPS.moveTo:
            cur = [pt(coords[j], coords[j + 1])];
            pending.push(cur);
            j += 2;
            break;
          case OPS.lineTo:
            (cur || (pending.push((cur = [])), cur)).push(pt(coords[j], coords[j + 1]));
            j += 2;
            break;
          case OPS.curveTo:
            cur?.push(pt(coords[j + 4], coords[j + 5]));
            j += 6;
            break;
          case OPS.curveTo2:
          case OPS.curveTo3:
            cur?.push(pt(coords[j + 2], coords[j + 3]));
            j += 4;
            break;
        }
      }
    } else if (STROKE_OPS.has(fn)) addSubpaths(true);
    else if (FILL_OPS.has(fn)) addSubpaths(false);
    else if (fn === OPS.endPath) pending = [];
  }
  return rules;
}
