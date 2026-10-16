// Copies the pdf.js standard fonts and CMaps into /public so the viewer can
// render PDFs that use non-embedded or CJK fonts.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");

mkdirSync(dest, { recursive: true });
for (const dir of ["standard_fonts", "cmaps"]) {
  const from = join(src, dir);
  if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
