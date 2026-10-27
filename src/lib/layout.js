// Groups pdf.js text runs into editable paragraphs ("blocks").
//
// PDFs have no notion of paragraphs: they only place glyph runs on the page.
// We rebuild them in two steps:
//   1. runs on the same baseline that sit close together form a line segment
//      (a wide gap, e.g. between two columns, or a table border starts a new
//      segment);
//   2. consecutive segments with the same font size, regular line spacing and
//      a shared left / right / centre edge are merged into a block.
// Each block keeps its styled runs (font, size, colour) and its original
// geometry, so it can be edited as a paragraph and re-flowed on export.

const BULLETS = new Set([..."•●○◦▪▫■□‣⁃∙·*➢➤►▶✓✔❖◆◇-–—"]);

function isBullet(str) {
  const t = str.trim();
  if ([...t].length !== 1) return false;
  const cp = t.codePointAt(0);
  return BULLETS.has(t) || (cp >= 0xe000 && cp <= 0xf8ff); // icon fonts use the private use area
}

/**
 * @param items  text runs from extractTextItems()
 * @param opts.isBold   (fontName) => boolean
 * @param opts.measure  (text, fontName, sizePt) => natural width in pt
 * @param opts.rules    ruling lines from extractRules(); text is never grouped across them
 */
export function buildBlocks(items, { isBold, measure, rules = [] }) {
  // Work in each run's own reading direction, so rotated text groups too.
  const runs = items.map((it) => {
    const [a, b, , , e, f] = it.transform;
    const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return {
      it,
      deg,
      cos,
      sin,
      x: e * cos + f * sin,
      y: -e * sin + f * cos,
      w: it.widthEm * Math.hypot(a, b),
      size: it.fontSizePt,
    };
  });

  /* ---- 1. rows and line segments ---- */
  const segments = [];
  const byDeg = new Map();
  for (const r of runs) byDeg.set(r.deg, [...(byDeg.get(r.deg) || []), r]);
  const rulesByDeg = new Map();
  for (const group of byDeg.values()) {
    const { deg, cos, sin } = group[0];
    const framed = rulesInFrame(rules, cos, sin);
    rulesByDeg.set(deg, framed);
    group.sort((p, q) => q.y - p.y || p.x - q.x);
    const rows = [];
    for (const r of group) {
      const row = rows.find((rw) => Math.abs(rw.y - r.y) < 0.35 * Math.min(rw.size, r.size));
      if (row) row.runs.push(r);
      else rows.push({ y: r.y, size: r.size, runs: [r] });
    }
    for (const row of rows) {
      row.runs.sort((p, q) => p.x - q.x);
      let seg = null;
      for (const r of row.runs) {
        const gap = seg ? r.x - seg.x1 : 0;
        const size = Math.max(r.size, seg?.size || 0);
        if (!seg || gap > 1.5 * size || gap < -0.3 * size || crossesVertical(framed.vertical, seg, r)) {
          const afterBullet = !!seg && seg.runs.length === 1 && isBullet(seg.runs[0].it.str);
          if (afterBullet) seg.isBullet = true;
          seg = { deg: r.deg, cos: r.cos, sin: r.sin, runs: [], x0: r.x, x1: r.x, y: r.y, size: 0, isBullet: false, afterBullet };
          segments.push(seg);
        }
        seg.runs.push(r);
        seg.x1 = Math.max(seg.x1, r.x + r.w);
        if (r.size > seg.size) {
          seg.size = r.size;
          seg.y = r.y;
        }
      }
    }
  }

  // A row-leading bullet glyph followed by text becomes its own block, and
  // the text after it always starts a new paragraph.
  for (const seg of [...segments]) {
    const [first, second] = seg.runs;
    if (second && isBullet(first.it.str) && second.x - (first.x + first.w) > 0.2 * seg.size) {
      segments.push({ ...seg, runs: [first], x1: first.x + first.w, isBullet: true, afterBullet: false });
      seg.runs = seg.runs.slice(1);
      seg.x0 = second.x;
      seg.afterBullet = true;
    }
  }

  for (const seg of segments) {
    const bold = seg.runs.map((r) => !!isBold(r.it.fontName));
    seg.weight = bold.every(Boolean) ? "bold" : bold.some(Boolean) ? "mixed" : "regular";
    seg.lineRuns = toStyledRuns(seg.runs, seg.size);
  }

  /* ---- 2. paragraphs ---- */
  segments.sort((p, q) => p.deg - q.deg || q.y - p.y || p.x0 - q.x0);
  const blocks = [];
  for (const s of segments) {
    let best = null;
    if (!s.isBullet && !s.afterBullet) {
      for (const b of blocks) {
        if (b.isBullet || b.deg !== s.deg) continue;
        const last = b.lines[b.lines.length - 1];
        const gap = last.y - s.y;
        if (gap < 0.85 * b.size || gap > 1.8 * b.size) continue;
        if (b.lines.length >= 2 && Math.abs(gap - b.lineGap) > 0.2 * b.size) continue;
        const ratio = s.size / b.size;
        if (ratio < 0.85 || ratio > 1.18) continue;
        if (!(s.x0 < last.x1 && s.x1 > last.x0)) continue;
        if (crossesHorizontal(rulesByDeg.get(s.deg).horizontal, last, s)) continue;
        const align = alignWith(b, s);
        if (!align) continue;
        // Bold heading followed by regular text (or vice versa): new paragraph.
        if (b.lines.length === 1 && last.weight !== "mixed" && s.weight !== "mixed" && last.weight !== s.weight) continue;
        // A clearly short previous line ended the paragraph.
        if (b.lines.length >= 2 && b.align === "left" && last.x1 < b.x1 - 4 * b.size) continue;
        if (!best || gap < best.gap) best = { b, gap, align };
      }
    }
    if (best) addLine(best.b, s, best.align);
    else blocks.push(newBlock(s));
  }

  return blocks.map((b, i) => finalize(b, i, measure));
}

// Ruling lines in a reading direction's frame, split into vertical and horizontal.
function rulesInFrame(rules, cos, sin) {
  const vertical = [], horizontal = [];
  for (const r of rules) {
    const x0 = r.x0 * cos + r.y0 * sin, y0 = -r.x0 * sin + r.y0 * cos;
    const x1 = r.x1 * cos + r.y1 * sin, y1 = -r.x1 * sin + r.y1 * cos;
    if (Math.abs(x1 - x0) < 0.5) vertical.push({ x: (x0 + x1) / 2, lo: Math.min(y0, y1), hi: Math.max(y0, y1) });
    else if (Math.abs(y1 - y0) < 0.5) horizontal.push({ y: (y0 + y1) / 2, lo: Math.min(x0, x1), hi: Math.max(x0, x1) });
  }
  return { vertical, horizontal };
}

// A vertical rule (e.g. a table cell border) between a segment and the next run.
function crossesVertical(vertical, seg, r) {
  return vertical.some((v) => v.x > seg.x1 - 1 && v.x < r.x + 1 && v.lo < r.y + 0.6 * r.size && v.hi > r.y);
}

// A horizontal rule between a paragraph's last line and the segment below it.
function crossesHorizontal(horizontal, last, s) {
  const lo = Math.max(last.x0, s.x0), hi = Math.min(last.x1, s.x1);
  return horizontal.some((h) => h.y < last.y && h.y > s.y + 0.5 * s.size && h.lo < hi && h.hi > lo);
}

// Merges a segment's runs into styled runs, inserting spaces at visual gaps.
function toStyledRuns(segRuns, size) {
  const out = [];
  let prev = null;
  for (const r of segRuns) {
    let text = r.it.str;
    if (prev) {
      const gap = r.x - (prev.x + prev.w);
      const prevText = prev.it.str;
      if (gap > 0.15 * size && !/\s$/.test(prevText) && !/^\s/.test(text)) {
        out[out.length - 1].text += " ";
      }
    }
    const last = out[out.length - 1];
    if (last && last.fontName === r.it.fontName && Math.abs(last.size - r.size) < 0.01) {
      last.text += text;
      last.items.push(r.it);
    } else {
      out.push({ text, fontName: r.it.fontName, size: r.size, items: [r.it] });
    }
    prev = r;
  }
  return out;
}

function newBlock(s) {
  return {
    deg: s.deg,
    cos: s.cos,
    sin: s.sin,
    isBullet: s.isBullet,
    lines: [s],
    x0: s.x0,
    x1: s.x1,
    size: s.size,
    lineGap: s.size * 1.2,
    align: "left",
    indent: 0,
  };
}

function alignWith(b, s) {
  const tol = 0.6 * b.size;
  const cx = (s.x0 + s.x1) / 2;
  if (b.lines.length === 1) {
    const f = b.lines[0];
    if (Math.abs(s.x0 - f.x0) < tol) return "left";
    if (Math.abs(s.x1 - f.x1) < tol) return "right";
    if (Math.abs(cx - (f.x0 + f.x1) / 2) < tol) return "center";
    // First-line indent, or a hanging indent after a bullet / number.
    if (s.x0 < f.x0 - tol && f.x0 - s.x0 < 4 * b.size) return "indent";
    const lead = f.lineRuns[0].text.trimStart();
    if (s.x0 > f.x0 + tol && s.x0 - f.x0 < 3 * b.size && (isBullet(lead[0] || "") || /^\(?\d{1,3}[.)]/.test(lead))) return "indent";
    return null;
  }
  if (b.align === "left") return Math.abs(s.x0 - b.x0) < tol ? "left" : null;
  if (b.align === "right") return Math.abs(s.x1 - b.x1) < tol ? "right" : null;
  const last = b.lines[b.lines.length - 1];
  return Math.abs(cx - (last.x0 + last.x1) / 2) < tol ? "center" : null;
}

function addLine(b, s, align) {
  if (b.lines.length === 1) {
    b.align = align === "indent" ? "left" : align;
    if (align === "indent") {
      // x0 is the left edge of the body lines; the first line is offset by indent.
      b.indent = b.lines[0].x0 - s.x0;
      b.x0 = s.x0;
    }
  }
  b.lines.push(s);
  if (align !== "indent") b.x0 = Math.min(b.x0, s.x0);
  b.x1 = Math.max(b.x1, s.x1);
  b.lineGap = (b.lines[0].y - s.y) / (b.lines.length - 1);
}

const firstWord = (line) => {
  const text = line.lineRuns.map((r) => r.text).join("");
  return text.trimStart().split(/\s+/)[0] || "";
};

function lineWidth(line, measure) {
  return line.lineRuns.reduce((w, r, i, all) => w + measure(i === all.length - 1 ? r.text.trimEnd() : r.text, r.fontName, r.size), 0);
}

function finalize(b, index, measure) {
  const lines = b.lines;
  const n = lines.length;
  const first = lines[0];
  const last = lines[n - 1];
  const allItems = lines.flatMap((l) => l.runs.map((r) => r.it));
  const ascent = Math.max(...first.runs.map((r) => r.it.ascent));
  const descent = Math.min(...last.runs.map((r) => r.it.descent));

  // Justified: left aligned and every line but the last reaches the right edge.
  let align = b.align;
  if (align === "left" && n >= 3 && lines.slice(0, -1).every((l) => Math.abs(l.x1 - b.x1) < 0.3 * b.size)) {
    align = "justify";
  }

  // Original line breaks: a break is "soft" (word wrap) unless the next line's
  // first word would clearly have fitted on the previous line.
  const firstRun = (l) => l.lineRuns[0];
  const lastRun = (l) => l.lineRuns[l.lineRuns.length - 1];
  const space = (l) => measure(" ", lastRun(l).fontName, lastRun(l).size);
  const hard = lines.map((l, i) => {
    if (i === n - 1) return true;
    const next = lines[i + 1];
    const fw = measure(firstWord(next), firstRun(next).fontName, firstRun(next).size);
    return align !== "justify" && l.x1 - l.x0 + space(l) + fw < b.x1 - b.x0 - 0.2 * b.size;
  });

  // Paragraph content: styled runs, soft breaks joined with a space.
  const content = [];
  const push = (text, r) => {
    const prev = content[content.length - 1];
    if (prev && prev.fontName === r.fontName && prev.size === r.size && prev.itemIds.join() === r.items.map((x) => x.id).join()) {
      prev.text += text;
    } else {
      content.push({ text, fontName: r.fontName, size: r.size, itemIds: r.items.map((x) => x.id) });
    }
  };
  lines.forEach((l, i) => {
    l.lineRuns.forEach((r, k) => {
      let text = r.text;
      if (k === l.lineRuns.length - 1 && i < n - 1) {
        text = text.replace(/\s+$/, "");
        const nextText = lines[i + 1].lineRuns[0].text;
        if (hard[i]) text += "\n";
        else if (!(/[-‐]$/.test(text) && /^\p{L}/u.test(nextText))) text += " ";
      }
      push(text, r);
    });
  });

  // Wrap width: wide enough for every original line, narrow enough that the
  // first word of each soft-wrapped line still does not fit on the line above.
  const indentOf = (i) => (i === 0 ? b.indent : 0);
  let wrapWidth = null;
  if (n > 1) {
    const natural = lines.map((l, i) => lineWidth(l, measure) + indentOf(i));
    const lo = Math.max(...natural);
    let hi = Infinity;
    lines.forEach((l, i) => {
      if (hard[i]) return;
      const next = lines[i + 1];
      const fw = measure(firstWord(next), firstRun(next).fontName, firstRun(next).size);
      hi = Math.min(hi, natural[i] + space(l) + fw);
    });
    // The real column width lies in [lo, hi); text usually fills it closely.
    const slack = 0.6 * b.size;
    if (align === "justify") wrapWidth = Math.max(lo, b.x1 - b.x0) + 0.05;
    else if (hi < Infinity && hi > lo) wrapWidth = Math.min((lo + hi) / 2, lo + slack);
    else wrapWidth = lo + slack;
  }

  let editorLeft = b.x0;
  if (wrapWidth != null && align === "center") editorLeft = (b.x0 + b.x1) / 2 - wrapWidth / 2;
  if (wrapWidth != null && align === "right") editorLeft = b.x1 - wrapWidth;

  return {
    id: `${allItems[0].pageIndex}:b${index}`,
    pageIndex: allItems[0].pageIndex,
    cos: b.cos,
    sin: b.sin,
    boxLeft: Math.min(b.x0, b.x0 + b.indent),
    x0: b.x0,
    x1: b.x1,
    top: first.y + ascent * first.size,
    bottom: last.y + descent * last.size,
    firstBaseline: first.y,
    lineGap: n > 1 ? b.lineGap : first.size * 1.2,
    lineCount: n,
    size: b.size,
    align,
    indent: b.indent,
    wrapWidth,
    editorLeft,
    descent,
    items: allItems,
    content,
    text: content.map((r) => r.text).join(""),
  };
}
