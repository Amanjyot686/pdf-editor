// Removes the original text of edited runs from a page's content stream, so
// the old wording can no longer be selected, copied or searched.
//
// Each text-showing operator (Tj, TJ, ', ") is replayed with a minimal text
// state machine to find where it starts and ends on the page. Operators that
// lie entirely inside an edited run are replaced by an equal-width blank move
// ([-n] TJ), so all following text keeps its exact position. Anything that
// cannot be measured reliably is left untouched (the cover rectangle still
// hides it visually).
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { applyPoint, multiply } from "./geometry.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => "()<>[]{}/%".includes(String.fromCharCode(c));
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/* ---------------- Tokenizer ---------------- */

function readLiteralString(s, i) {
  // s[i] === "("
  const bytes = [];
  let depth = 1;
  i++;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === "\\") {
      const nx = s[i + 1];
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (nx in map) {
        bytes.push(map[nx]);
        i += 2;
      } else if (/[0-7]/.test(nx)) {
        let oct = "";
        let j = i + 1;
        while (j < s.length && oct.length < 3 && /[0-7]/.test(s[j])) oct += s[j++];
        bytes.push(parseInt(oct, 8) & 0xff);
        i = j;
      } else if (nx === "\r") {
        i += s[i + 2] === "\n" ? 3 : 2;
      } else if (nx === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    bytes.push(s.charCodeAt(i));
    i++;
  }
  return { bytes, end: i };
}

function tokenize(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWs(c)) {
      i++;
      continue;
    }
    const start = i;
    const ch = s[i];
    if (ch === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      const { bytes, end } = readLiteralString(s, i);
      i = end;
      tokens.push({ t: "str", v: bytes, start, end: i });
    } else if (ch === "<" && s[i + 1] === "<") {
      i += 2;
      tokens.push({ t: "<<", start, end: i });
    } else if (ch === ">" && s[i + 1] === ">") {
      i += 2;
      tokens.push({ t: ">>", start, end: i });
    } else if (ch === "<") {
      const close = s.indexOf(">", i);
      if (close < 0) throw new Error("bad hex string");
      let hex = s.slice(i + 1, close).replace(/\s+/g, "");
      if (hex.length % 2) hex += "0";
      const bytes = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      i = close + 1;
      tokens.push({ t: "str", v: bytes, start, end: i });
    } else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      i++;
      tokens.push({ t: ch, start, end: i });
    } else if (ch === "/") {
      i++;
      while (i < n && !isWs(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++;
      tokens.push({ t: "name", v: s.slice(start + 1, i), start, end: i });
    } else {
      while (i < n && !isWs(s.charCodeAt(i)) && !isDelim(s.charCodeAt(i))) i++;
      if (i === start) i++; // stray delimiter such as ")" or ">"
      const word = s.slice(start, i);
      if (NUMBER_RE.test(word)) {
        tokens.push({ t: "num", v: parseFloat(word), start, end: i });
      } else if (word === "true" || word === "false" || word === "null") {
        tokens.push({ t: "kw", v: word, start, end: i });
      } else {
        tokens.push({ t: "op", v: word, start, end: i });
        if (word === "ID") {
          // Inline image data: skip binary bytes up to the "EI" operator.
          let j = i + 1;
          const re = /\sEI(?=[\s]|$)/g;
          re.lastIndex = j;
          const m = re.exec(s);
          j = m ? m.index + m[0].length : n;
          tokens.push({ t: "op", v: "EI", start: j - 2, end: j });
          i = j;
        }
      }
    }
  }
  return tokens;
}

// Groups tokens into operations: { op, args, start, end }.
function parseOperations(tokens) {
  const ops = [];
  let stack = [];
  let argStart = null;
  const containers = [];
  for (const tok of tokens) {
    if (argStart === null && tok.t !== "op") argStart = tok.start;
    if (tok.t === "[" || tok.t === "<<" || tok.t === "{") {
      containers.push({ type: tok.t, items: [] });
      continue;
    }
    if (tok.t === "]" || tok.t === ">>" || tok.t === "}") {
      const done = containers.pop();
      const value = { t: "arr", v: done ? done.items : [] };
      if (containers.length) containers[containers.length - 1].items.push(value);
      else stack.push(value);
      continue;
    }
    if (containers.length) {
      containers[containers.length - 1].items.push(tok);
      continue;
    }
    if (tok.t === "op") {
      ops.push({ op: tok.v, args: stack, start: argStart ?? tok.start, end: tok.end });
      stack = [];
      argStart = null;
    } else {
      stack.push(tok);
    }
  }
  return ops;
}

/* ---------------- Font metrics ---------------- */

function num(obj, fallback = 0) {
  return obj instanceof PDFNumber ? obj.asNumber() : fallback;
}

function fontMetrics(fontDict) {
  const subtype = fontDict.lookup(PDFName.of("Subtype"));
  if (subtype === PDFName.of("Type0")) {
    if (fontDict.lookup(PDFName.of("Encoding")) !== PDFName.of("Identity-H")) return null;
    const descendants = fontDict.lookup(PDFName.of("DescendantFonts"), PDFArray);
    const cid = descendants?.lookup(0, PDFDict);
    if (!cid) return null;
    const dw = num(cid.lookup(PDFName.of("DW")), 1000);
    const widths = new Map();
    const w = cid.lookup(PDFName.of("W"));
    if (w instanceof PDFArray) {
      const arr = w.asArray().map((x) => cid.context.lookup(x));
      for (let k = 0; k < arr.length; ) {
        const first = num(arr[k]);
        const next = arr[k + 1];
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => widths.set(first + j, num(cid.context.lookup(x))));
          k += 2;
        } else {
          const last = num(next);
          const width = num(arr[k + 2]);
          for (let c = first; c <= last; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    return { twoByte: true, width: (code) => widths.get(code) ?? dw };
  }
  if (subtype === PDFName.of("Type3")) return null;
  const widthsArr = fontDict.lookup(PDFName.of("Widths"));
  if (!(widthsArr instanceof PDFArray)) return null; // standard 14 font without metrics
  const firstChar = num(fontDict.lookup(PDFName.of("FirstChar")));
  const widths = widthsArr.asArray().map((x) => num(fontDict.context.lookup(x)));
  const descriptor = fontDict.lookup(PDFName.of("FontDescriptor"));
  const missing = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("MissingWidth"))) : 0;
  return {
    twoByte: false,
    width: (code) => {
      const w = widths[code - firstChar];
      return w === undefined ? missing : w;
    },
  };
}

/* ---------------- Text state replay ---------------- */

function fmt(n) {
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "0";
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/**
 * Returns { content, removed, cleared } with the rewritten latin1 content, or
 * null if nothing was removed.
 */
function rewriteContent(content, edits, getFont) {
  const ops = parseOperations(tokenize(content));
  const targets = edits
    .map((e) => ({ e, inv: invert(e.transform), size: Math.hypot(e.transform[2], e.transform[3]), removedEm: 0 }))
    .filter((t) => t.inv);

  let gs = { ctm: IDENTITY, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, font: null, Tfs: 0 };
  const stack = [];
  let Tm = IDENTITY;
  let Tlm = IDENTITY;
  const replacements = [];
  const nums = (args) => args.map((a) => (a.t === "num" ? a.v : 0));

  const moveLine = (tx, ty) => {
    Tlm = multiply(Tlm, [1, 0, 0, 1, tx, ty]);
    Tm = Tlm;
  };

  const tol = 0.06;
  // A glyph belongs to a run when it starts inside it; it may overhang the
  // end a little (pdf.js leaves trailing space glyphs out of run widths).
  const glyphIn = (t, p0, p1) => {
    const a = applyPoint(t.inv, ...p0);
    const b = applyPoint(t.inv, ...p1);
    return a[0] >= -tol && a[0] <= t.e.widthEm + tol && b[0] <= t.e.widthEm + 0.5 && Math.abs(a[1]) < 0.2 && Math.abs(b[1]) < 0.2;
  };

  // Measures one text-showing operation and removes it when every glyph it
  // draws lies inside an edited run (one operation may span several runs).
  const show = (op, items, prefix) => {
    const metrics = gs.font ? getFont(gs.font) : null;
    let tx = 0;
    const glyphs = [];
    for (const item of items) {
      if (item.t === "num") {
        tx -= (item.v / 1000) * gs.Tfs * gs.Th;
      } else if (item.t === "str" && metrics) {
        const b = item.v;
        const step = metrics.twoByte ? 2 : 1;
        for (let k = 0; k + step - 1 < b.length; k += step) {
          const code = metrics.twoByte ? (b[k] << 8) | b[k + 1] : b[k];
          const spacing = !metrics.twoByte && code === 32 ? gs.Tw : 0;
          const w = (metrics.width(code) / 1000) * gs.Tfs * gs.Th;
          if (w > 0) glyphs.push([tx, tx + w]);
          tx += ((metrics.width(code) / 1000) * gs.Tfs + gs.Tc + spacing) * gs.Th;
        }
      }
    }
    const textToUser = multiply(gs.ctm, Tm);
    if (metrics && gs.Tfs && gs.Th && glyphs.length) {
      const size = Math.hypot(...applyPoint([textToUser[0], textToUser[1], textToUser[2], textToUser[3], 0, 0], 0, gs.Tfs));
      const cands = targets.filter((t) => Math.abs(size - t.size) <= t.size * 0.08);
      const hits = [];
      for (const [a, b] of glyphs) {
        const p0 = applyPoint(textToUser, a, gs.Ts);
        const p1 = applyPoint(textToUser, b, gs.Ts);
        const t = cands.find((c) => glyphIn(c, p0, p1));
        if (!t) {
          hits.length = 0;
          break;
        }
        hits.push({ t, p0, p1 });
      }
      if (hits.length) {
        const n = (-tx * 1000) / (gs.Tfs * gs.Th);
        replacements.push({ start: op.start, end: op.end, text: `${prefix}[${fmt(n)}] TJ` });
        // Track how much of each run's width has been removed (in em).
        for (const { t, p0, p1 } of hits) t.removedEm += Math.abs(applyPoint(t.inv, ...p1)[0] - applyPoint(t.inv, ...p0)[0]);
      }
    }
    Tm = multiply(Tm, [1, 0, 0, 1, tx, 0]);
  };

  for (const op of ops) {
    const a = op.args;
    switch (op.op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        if (stack.length) gs = stack.pop();
        break;
      case "cm":
        if (a.length === 6) gs.ctm = multiply(gs.ctm, nums(a));
        break;
      case "BT":
        Tm = IDENTITY;
        Tlm = IDENTITY;
        break;
      case "Tc":
        gs.Tc = nums(a)[0] ?? 0;
        break;
      case "Tw":
        gs.Tw = nums(a)[0] ?? 0;
        break;
      case "Tz":
        gs.Th = (nums(a)[0] ?? 100) / 100;
        break;
      case "TL":
        gs.TL = nums(a)[0] ?? 0;
        break;
      case "Ts":
        gs.Ts = nums(a)[0] ?? 0;
        break;
      case "Tf":
        gs.font = a[0]?.t === "name" ? a[0].v : null;
        gs.Tfs = a[1]?.t === "num" ? a[1].v : 0;
        break;
      case "Td":
        moveLine(...nums(a));
        break;
      case "TD": {
        const [tx, ty] = nums(a);
        gs.TL = -ty;
        moveLine(tx, ty);
        break;
      }
      case "Tm":
        if (a.length === 6) {
          Tlm = nums(a);
          Tm = Tlm;
        }
        break;
      case "T*":
        moveLine(0, -gs.TL);
        break;
      case "Tj":
        if (a[0]?.t === "str") show(op, [a[0]], "");
        break;
      case "TJ":
        if (a[0]?.t === "arr") show(op, a[0].v, "");
        break;
      case "'":
        moveLine(0, -gs.TL);
        if (a[0]?.t === "str") show(op, [a[0]], "T* ");
        break;
      case '"': {
        const [aw, ac] = nums(a);
        gs.Tw = aw;
        gs.Tc = ac;
        moveLine(0, -gs.TL);
        if (a[2]?.t === "str") show(op, [a[2]], `${fmt(aw)} Tw ${fmt(ac)} Tc T* `);
        break;
      }
      default:
        break;
    }
  }

  if (!replacements.length) return null;
  replacements.sort((x, y) => y.start - x.start);
  let out = content;
  for (const r of replacements) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  // Runs whose glyphs were (almost) entirely taken out of the content stream.
  const cleared = new Set(targets.filter((t) => t.removedEm >= t.e.widthEm * 0.85).map((t) => t.e));
  return { content: out, removed: replacements.length, cleared };
}

/* ---------------- Page integration ---------------- */

const toLatin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};
const fromLatin1 = (s) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

function streamBytes(context, ref) {
  const stream = ref instanceof PDFRef ? context.lookup(ref) : ref;
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream && typeof stream.getContents === "function") return stream.getContents();
  throw new Error("unsupported content stream");
}

/**
 * Strips the original glyphs of the text runs in `targets` (objects with
 * `transform` and `widthEm`) from `page`. Returns the set of runs that were
 * fully removed. Never throws: on any problem the page is left as is.
 */
export function removeOriginalText(doc, page, targets) {
  try {
    const context = doc.context;
    const node = page.node;
    const contents = node.get(PDFName.of("Contents"));
    if (!contents) return new Set();
    const resolved = context.lookup(contents);
    const refs = resolved instanceof PDFArray ? resolved.asArray() : [contents];
    const content = refs.map((r) => toLatin1(streamBytes(context, r))).join("\n");

    const resources = node.getInheritableAttribute(PDFName.of("Resources"));
    const fontDir = context.lookup(resources) instanceof PDFDict ? context.lookup(resources).lookup(PDFName.of("Font")) : null;
    const metricsCache = new Map();
    const getFont = (name) => {
      if (!metricsCache.has(name)) {
        let m = null;
        try {
          const dict = fontDir instanceof PDFDict ? fontDir.lookup(PDFName.of(name)) : null;
          m = dict instanceof PDFDict ? fontMetrics(dict) : null;
        } catch {
          m = null;
        }
        metricsCache.set(name, m);
      }
      return metricsCache.get(name);
    };

    const result = rewriteContent(content, targets, getFont);
    if (!result) return new Set();
    const stream = context.flateStream(fromLatin1(result.content));
    node.set(PDFName.of("Contents"), context.register(stream));
    return result.cleared;
  } catch (err) {
    console.warn("Could not remove original text; it will only be covered.", err);
    return new Set();
  }
}
