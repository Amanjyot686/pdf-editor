// Pulls the fonts embedded in the PDF out of pdf.js so the same typeface can
// be used both in the on-screen editor and when writing the edited PDF.
import fontkit from "@pdf-lib/fontkit";
import { replaceCmap } from "./sfnt.js";

const registry = new Map(); // pdf.js loadedName -> Promise<FontInfo>
const faces = [];
let counter = 0;

// Characters encodable by the PDF standard 14 fonts (WinAnsiEncoding).
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function isWinAnsi(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(ch);
}

export function resetFonts() {
  for (const face of faces) document.fonts.delete(face);
  faces.length = 0;
  registry.clear();
}

export function getFontInfo(loadedName) {
  return registry.get(loadedName) || Promise.resolve(null);
}

export function ensureFont(page, loadedName) {
  if (!registry.has(loadedName)) registry.set(loadedName, loadFont(page, loadedName));
  return registry.get(loadedName);
}

function getRawFont(page, loadedName) {
  try {
    if (page.commonObjs.has(loadedName)) return page.commonObjs.get(loadedName);
  } catch {
    /* font not resolved */
  }
  return null;
}

// "TimesNewRomanPS-BoldMT" -> ["Times New Roman", "TimesNewRoman"]
function familyNames(psName) {
  const base = psName.split(/[-,]/)[0].replace(/(PSMT|MT|PS)$/, "").trim();
  if (!base) return [];
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2");
  return [...new Set([spaced, base])];
}

const isPrivateUse = (cp) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;

/**
 * pdf.js builds the font's Unicode map from the PDF's ToUnicode data, but a
 * ligature glyph ("ti", "ft", "fi"…) can overwrite the entry of its first
 * letter, so typing "t" would draw "ti". Rebuild the map from the exact
 * per-glyph data, ignoring multi-letter (ligature) mappings.
 */
function fixUnicodeMap(data, raw) {
  const tu = raw.toUnicode;
  const toFontChar = raw.toFontChar;
  if (!tu || !toFontChar) return data;
  try {
    const fk = fontkit.create(data);
    const mapping = new Map();
    const add = (code, str) => {
      if (typeof str !== "string") return;
      const cps = [...str];
      if (cps.length !== 1) return;
      const cp = cps[0].codePointAt(0);
      const fontChar = toFontChar[code];
      if (fontChar == null || mapping.has(cp) || isPrivateUse(cp)) return;
      const gid = fk.glyphForCodePoint(fontChar)?.id;
      if (gid) mapping.set(cp, gid);
    };
    if (tu._map) for (const key of Object.keys(tu._map)) add(Number(key), tu._map[key]);
    else if (typeof tu.firstChar === "number") for (let c = tu.firstChar; c <= tu.lastChar; c++) add(c, String.fromCharCode(c));
    if (!mapping.size) return data;
    // Keep the private-use entries pdf.js itself renders through.
    for (const cp of fk.characterSet) {
      if (!isPrivateUse(cp) || mapping.has(cp)) continue;
      const gid = fk.glyphForCodePoint(cp)?.id;
      if (gid) mapping.set(cp, gid);
    }
    return replaceCmap(data, mapping);
  } catch (err) {
    console.warn("Could not rebuild font map", err);
    return data;
  }
}

async function loadFont(page, loadedName) {
  const raw = getRawFont(page, loadedName);
  const psName = (raw?.name || "").replace(/^[A-Z]{6}\+/, "");
  const displayName = psName || "Unknown font";

  const bold = !!(raw?.bold || raw?.black) || /bold|black|heavy|semibold|demi/i.test(psName);
  const italic = !!raw?.italic || /italic|oblique/i.test(psName);
  const mono = !!raw?.isMonospace || /courier|mono|consol/i.test(psName);
  const serif =
    !mono && !/sans/i.test(psName) && (!!raw?.isSerifFont || /times|serif|georgia|garamond|cambria|roman/i.test(psName));

  const generic = mono
    ? '"Courier New", Courier, monospace'
    : serif
    ? '"Times New Roman", Times, serif'
    : "Arial, Helvetica, sans-serif";

  const usable = raw && raw.data && !raw.isType3Font;
  const data = usable ? fixUnicodeMap(new Uint8Array(raw.data), raw) : null;
  // Only fonts actually embedded in the PDF are re-embedded on export;
  // for non-embedded ones the closest standard PDF font is used instead.
  const embedded = !!data && !raw.missingFile;

  const cssWeight = bold ? "bold" : "normal";
  const cssStyle = italic ? "italic" : "normal";
  const families = familyNames(psName);

  // Fallback chain: the PDF's own font, then the same family installed on
  // this computer (for letters missing from the embedded subset), then generic.
  let face = null;
  const chain = families.map((f) => `"${f}"`);
  if (data) {
    const family = `pdfedit-font-${++counter}`;
    try {
      // Declared with its real weight/style so the browser never fakes bold.
      face = new FontFace(family, data, { weight: bold ? "700" : "400", style: cssStyle });
      await face.load();
      document.fonts.add(face);
      faces.push(face);
      chain.unshift(`"${family}"`);
    } catch {
      face = null;
    }
  }
  const cssFamily = [...chain, generic].join(", ");

  let fkFont = null;
  if (embedded) {
    try {
      fkFont = fontkit.create(data);
    } catch {
      fkFont = null;
    }
  }

  return {
    loadedName,
    displayName,
    psName,
    families,
    bold,
    italic,
    serif,
    mono,
    embedded: embedded && !!fkFont,
    data,
    mimetype: raw?.mimetype,
    fkFont,
    cssFamily,
    cssWeight,
    cssStyle,
    baseline: measureBaseline(cssFamily, cssWeight, cssStyle),
    hasGlyph(ch) {
      if (!fkFont) return false;
      try {
        return fkFont.hasGlyphForCodePoint(ch.codePointAt(0));
      } catch {
        return false;
      }
    },
  };
}

// Distance (px) from the top of a 100px-font / 100px-line-height box to the
// text baseline, measured from real browser layout.
function measureBaseline(family, weight, style) {
  const box = document.createElement("div");
  box.style.cssText =
    `position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;` +
    `font-family:${family};font-size:100px;line-height:100px;font-weight:${weight};font-style:${style}`;
  box.textContent = "Hxgy";
  const marker = document.createElement("span");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  box.appendChild(marker);
  document.body.appendChild(box);
  const value = marker.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.remove();
  return value || 80;
}

/** Characters of `text` that are not available in the original font. */
export function missingChars(text, info) {
  if (!info) return [];
  const out = new Set();
  for (const ch of text) {
    if (ch === " ") continue;
    const ok = info.embedded ? info.hasGlyph(ch) : isWinAnsi(ch);
    if (!ok) out.add(ch);
  }
  return [...out];
}
