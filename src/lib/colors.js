// Samples the rendered page canvas to find the background colour behind a
// text run and the colour of the text itself.

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

function dist(p, c) {
  const dr = p.r - c.r, dg = p.g - c.g, db = p.b - c.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * @param canvas  rendered page canvas
 * @param corners points in CSS pixels (viewport space)
 * @param ratio   canvas pixels per CSS pixel
 */
export function sampleColors(canvas, corners, ratio) {
  try {
    const ctx = canvas.getContext("2d");
    const xs = corners.map((p) => p[0] * ratio);
    const ys = corners.map((p) => p[1] * ratio);
    const ix0 = Math.max(0, Math.floor(Math.min(...xs)));
    const iy0 = Math.max(0, Math.floor(Math.min(...ys)));
    const ix1 = Math.min(canvas.width, Math.ceil(Math.max(...xs)));
    const iy1 = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
    const pad = Math.max(2, Math.round(2 * ratio));
    const ox0 = Math.max(0, ix0 - pad);
    const oy0 = Math.max(0, iy0 - pad);
    const ox1 = Math.min(canvas.width, ix1 + pad);
    const oy1 = Math.min(canvas.height, iy1 + pad);
    const w = ox1 - ox0, h = oy1 - oy0;
    if (w <= 0 || h <= 0) return { bg: WHITE, color: BLACK };

    const data = ctx.getImageData(ox0, oy0, w, h).data;
    const buckets = new Map();
    const inner = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
        const gx = x + ox0, gy = y + oy0;
        const isInner = gx >= ix0 && gx < ix1 && gy >= iy0 && gy < iy1;
        if (isInner) {
          inner.push(p);
        } else {
          const key = (p.r >> 3) * 1024 + (p.g >> 3) * 32 + (p.b >> 3);
          const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          b.n++; b.r += p.r; b.g += p.g; b.b += p.b;
          buckets.set(key, b);
        }
      }
    }

    let bg = WHITE;
    let best = null;
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
    if (best) bg = { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };

    // Text colour: average of the pixels that differ most from the background.
    const scored = inner.map((p) => ({ p, d: dist(p, bg) })).sort((a, b) => b.d - a.d);
    let color = bg.r + bg.g + bg.b > 384 ? BLACK : WHITE;
    if (scored.length && scored[0].d > 40) {
      const take = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.04)));
      const sum = take.reduce((s, { p }) => ({ r: s.r + p.r, g: s.g + p.g, b: s.b + p.b }), { r: 0, g: 0, b: 0 });
      color = { r: Math.round(sum.r / take.length), g: Math.round(sum.g / take.length), b: Math.round(sum.b / take.length) };
    }
    return { bg, color };
  } catch {
    return { bg: WHITE, color: BLACK };
  }
}

export const toCss = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;
