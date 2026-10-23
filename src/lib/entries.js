// Helpers for edit entries (one per edited paragraph).

/** True when a paragraph differs from the original: text, styles or alignment. */
export function isEdited(entry) {
  if (!entry) return false;
  return entry.text !== entry.block.text || !!entry.formatted || (!!entry.align && entry.align !== entry.block.align);
}

/** Line spacing, scaled when the paragraph's font size was changed. */
export function lineGapOf(entry) {
  const b = entry.block;
  const sizes = (entry.content || []).filter((r) => r.text.trim()).map((r) => r.size);
  const max = sizes.length ? Math.max(...sizes) : b.size;
  return Math.abs(max - b.size) < 0.01 ? b.lineGap : b.lineGap * (max / b.size);
}
