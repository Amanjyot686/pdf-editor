// Uses the Local Font Access API (Chrome / Edge) to find the full version of
// a font installed on this computer. PDFs usually embed only the letters they
// use, so this lets newly typed letters use the exact same typeface.

let fontsPromise = null;

export const localFontsSupported = () => typeof window !== "undefined" && "queryLocalFonts" in window;

/** Must be called while handling a user click (it may show a permission prompt). */
export function requestLocalFonts() {
  if (!localFontsSupported()) return Promise.resolve([]);
  if (!fontsPromise) {
    fontsPromise = window.queryLocalFonts().catch(() => {
      fontsPromise = null; // allow asking again later
      return [];
    });
  }
  return fontsPromise;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function styleKey(style) {
  const s = norm(style).replace("oblique", "italic");
  if (s === "regular" || s === "normal" || s === "roman" || s === "book") return "";
  return s;
}

/** Returns the font file bytes for the installed equivalent of `info`, or null. */
export async function findLocalFont(info) {
  const fonts = await (fontsPromise || Promise.resolve([]));
  if (!fonts.length || !(info?.psName || info?.families?.length)) return null;

  let match = info.psName ? fonts.find((f) => norm(f.postscriptName) === norm(info.psName)) : null;
  if (!match) {
    const families = info.families.map(norm);
    const want = `${info.bold ? "bold" : ""}${info.italic ? "italic" : ""}`;
    match = fonts.find((f) => families.includes(norm(f.family)) && styleKey(f.style) === want);
  }
  if (!match) return null;
  try {
    const bytes = new Uint8Array(await (await match.blob()).arrayBuffer());
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    // Font collections (.ttc) cannot be embedded directly.
    return magic === "ttcf" ? null : bytes;
  } catch {
    return null;
  }
}
