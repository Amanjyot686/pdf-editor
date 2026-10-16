// Minimal TrueType / OpenType writer: replaces a font's character map
// ('cmap' table) and rebuilds the file with correct offsets and checksums.

function tagAt(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
}

function checksum(bytes) {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const dv = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
  return sum;
}

/** Builds a cmap with a format 4 (BMP) and a format 12 (full Unicode) subtable. */
function buildCmap(mapping) {
  const codes = [...mapping.keys()].sort((a, b) => a - b);

  // Format 4: runs of consecutive codes whose glyph ids are also consecutive.
  const segs = [];
  for (const c of codes) {
    if (c >= 0xffff) continue;
    const gid = mapping.get(c);
    const last = segs[segs.length - 1];
    if (last && c === last.end + 1 && gid === last.gid + (c - last.start)) last.end = c;
    else segs.push({ start: c, end: c, gid });
  }
  segs.push({ start: 0xffff, end: 0xffff, gid: 0, last: true });
  const n = segs.length;
  const f4 = new DataView(new ArrayBuffer(16 + 8 * n));
  const log2 = Math.floor(Math.log2(n));
  f4.setUint16(0, 4);
  f4.setUint16(2, 16 + 8 * n);
  f4.setUint16(4, 0);
  f4.setUint16(6, n * 2);
  f4.setUint16(8, 2 ** (log2 + 1));
  f4.setUint16(10, log2);
  f4.setUint16(12, n * 2 - 2 ** (log2 + 1));
  segs.forEach((s, i) => {
    f4.setUint16(14 + i * 2, s.end);
    f4.setUint16(16 + n * 2 + i * 2, s.start);
    f4.setUint16(16 + n * 4 + i * 2, s.last ? 1 : (s.gid - s.start) & 0xffff);
    f4.setUint16(16 + n * 6 + i * 2, 0);
  });

  // Format 12: same idea, 32-bit codes.
  const groups = [];
  for (const c of codes) {
    const gid = mapping.get(c);
    const last = groups[groups.length - 1];
    if (last && c === last.end + 1 && gid === last.gid + (c - last.start)) last.end = c;
    else groups.push({ start: c, end: c, gid });
  }
  const f12 = new DataView(new ArrayBuffer(16 + 12 * groups.length));
  f12.setUint16(0, 12);
  f12.setUint32(4, 16 + 12 * groups.length);
  f12.setUint32(12, groups.length);
  groups.forEach((g, i) => {
    f12.setUint32(16 + i * 12, g.start);
    f12.setUint32(20 + i * 12, g.end);
    f12.setUint32(24 + i * 12, g.gid);
  });

  const head = new DataView(new ArrayBuffer(4 + 8 * 2));
  head.setUint16(0, 0);
  head.setUint16(2, 2);
  head.setUint16(4, 3);
  head.setUint16(6, 1);
  head.setUint32(8, 20);
  head.setUint16(12, 3);
  head.setUint16(14, 10);
  head.setUint32(16, 20 + f4.byteLength);

  const out = new Uint8Array(head.byteLength + f4.byteLength + f12.byteLength);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(new Uint8Array(f4.buffer), head.byteLength);
  out.set(new Uint8Array(f12.buffer), head.byteLength + f4.byteLength);
  return out;
}

/**
 * Returns a copy of the font `data` whose cmap is exactly `mapping`
 * (Map<codePoint, glyphId>).
 */
export function replaceCmap(data, mapping) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = dv.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    const tag = tagAt(dv, o);
    const offset = dv.getUint32(o + 8);
    const length = dv.getUint32(o + 12);
    if (tag !== "cmap") tables.push({ tag, bytes: data.slice(offset, offset + length) });
  }
  tables.push({ tag: "cmap", bytes: buildCmap(mapping) });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));

  const head = tables.find((t) => t.tag === "head");
  if (head && head.bytes.length >= 12) new DataView(head.bytes.buffer, head.bytes.byteOffset).setUint32(8, 0);

  const dirSize = 12 + 16 * tables.length;
  let size = dirSize;
  for (const t of tables) size += (t.bytes.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  const log2 = Math.floor(Math.log2(tables.length));
  ov.setUint32(0, dv.getUint32(0)); // sfnt version (TrueType or 'OTTO')
  ov.setUint16(4, tables.length);
  ov.setUint16(6, 16 * 2 ** log2);
  ov.setUint16(8, log2);
  ov.setUint16(10, tables.length * 16 - 16 * 2 ** log2);

  let offset = dirSize;
  tables.forEach((t, i) => {
    const o = 12 + 16 * i;
    for (let k = 0; k < 4; k++) ov.setUint8(o + k, t.tag.charCodeAt(k));
    ov.setUint32(o + 4, checksum(t.bytes));
    ov.setUint32(o + 8, offset);
    ov.setUint32(o + 12, t.bytes.length);
    out.set(t.bytes, offset);
    t.offset = offset;
    offset += (t.bytes.length + 3) & ~3;
  });

  if (head && head.bytes.length >= 12) ov.setUint32(head.offset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
