// 2D affine helpers using the PDF matrix layout [a, b, c, d, e, f].

export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Padding (in em) added around a text run when covering the original glyphs.
export const PAD_X = 0.04;
export const PAD_Y = 0.03;

// Rectangle (in glyph space, 1 unit = 1 em, y-up) that covers a text run.
export function coverRect(item, widthEm = item.widthEm) {
  return {
    x: -PAD_X,
    y: item.descent - PAD_Y,
    w: Math.max(item.widthEm, widthEm) + PAD_X * 2,
    h: item.ascent - item.descent + PAD_Y * 2,
  };
}

// Corners of the glyph-space rect after applying matrix m.
export function rectCorners(m, r) {
  return [
    applyPoint(m, r.x, r.y),
    applyPoint(m, r.x + r.w, r.y),
    applyPoint(m, r.x + r.w, r.y + r.h),
    applyPoint(m, r.x, r.y + r.h),
  ];
}
