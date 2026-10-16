import { useEffect, useMemo, useRef, useState } from "react";
import TextBlock, { S, blockMatrix } from "./TextBlock.jsx";
import { extractTextItems } from "../lib/pdfjs.js";
import { ensureFont, missingChars } from "../lib/fonts.js";
import { buildBlocks } from "../lib/layout.js";
import { applyPoint, coverRect, multiply, rectCorners } from "../lib/geometry.js";
import { sampleColors } from "../lib/colors.js";

// Natural text width (pt) using the same fonts the editor displays.
function makeMeasure(fonts) {
  const ctx = document.createElement("canvas").getContext("2d");
  return (text, fontName, size) => {
    const f = fonts[fontName];
    ctx.font = `${f?.cssStyle || "normal"} ${f?.cssWeight || "normal"} ${size * 10}px ${f?.cssFamily || "sans-serif"}`;
    return ctx.measureText(text).width / 10;
  };
}

export default function PdfPage({ pdf, pageIndex, scale, edits, active, onActivate, onChange, onBlur, onRevert }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const renderChain = useRef(Promise.resolve());
  const textLoaded = useRef(false);
  const [page, setPage] = useState(null);
  const [visible, setVisible] = useState(false);
  const [blocks, setBlocks] = useState(null);
  const [fonts, setFonts] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    pdf.getPage(pageIndex + 1).then((p) => !cancelled && setPage(p));
    return () => {
      cancelled = true;
    };
  }, [pdf, pageIndex]);

  const viewport = useMemo(() => page?.getViewport({ scale }), [page, scale]);

  // Only render pages near the visible area.
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "1000px 0px" });
    io.observe(containerRef.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!page || !viewport || !visible) return;
    let cancelled = false;
    let task = null;
    // Renders are chained so a canvas is never used by two renders at once.
    renderChain.current = renderChain.current
      .then(async () => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        task = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await task.promise;
        if (cancelled || textLoaded.current) return;
        // Fonts are available from pdf.js once the page has been rendered.
        const items = await extractTextItems(page, pageIndex);
        const names = [...new Set(items.map((i) => i.fontName))];
        const infos = await Promise.all(names.map((n) => ensureFont(page, n)));
        const fontMap = Object.fromEntries(names.map((n, i) => [n, infos[i]]));
        const list = buildBlocks(items, { isBold: (n) => fontMap[n]?.bold, measure: makeMeasure(fontMap) });
        textLoaded.current = true;
        setFonts(fontMap);
        setBlocks(list);
      })
      .catch((err) => {
        if (err?.name !== "RenderingCancelledException") {
          console.error(err);
          setError("This page could not be displayed.");
        }
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [page, viewport, visible, pageIndex]);

  // First click on a paragraph: sample its colours from the rendered page.
  const handleActivate = (block, point) => {
    if (edits[block.id]) return onActivate(block.id, null, point);
    const canvas = canvasRef.current;
    const ratio = canvas.width / viewport.width;
    const itemColor = new Map();
    for (const it of block.items) {
      const corners = rectCorners(multiply(viewport.transform, it.transform), coverRect(it));
      itemColor.set(it.id, sampleColors(canvas, corners, ratio).color);
    }
    const { bg } = sampleColors(canvas, blockCorners(block, viewport), ratio);
    const content = block.content.map((r) => ({
      text: r.text,
      fontName: r.fontName,
      size: r.size,
      color: itemColor.get(r.itemIds[0]) || { r: 0, g: 0, b: 0 },
    }));
    onActivate(block.id, { id: block.id, pageIndex, block, content, text: block.text, bg, lines: null }, point);
  };

  const activeBlock = blocks && active ? blocks.find((b) => b.id === active.id) : null;

  return (
    <div
      ref={containerRef}
      className="page"
      style={{ width: viewport?.width ?? 600, height: viewport?.height ?? 800 }}
      data-page={pageIndex + 1}
    >
      <canvas ref={canvasRef} style={{ width: viewport?.width, height: viewport?.height }} />
      {error && <div className="page-error">{error}</div>}
      {blocks && viewport && (
        <div className="overlay">
          {blocks.map((block) => (
            <TextBlock
              key={block.id}
              block={block}
              viewportTransform={viewport.transform}
              fonts={fonts}
              entry={edits[block.id]}
              active={active?.id === block.id}
              caretPoint={active?.id === block.id ? active.point : null}
              onActivate={handleActivate}
              onChange={onChange}
              onBlur={onBlur}
            />
          ))}
          {activeBlock && edits[activeBlock.id] && (
            <ActiveChip
              block={activeBlock}
              viewport={viewport}
              fonts={fonts}
              entry={edits[activeBlock.id]}
              onRevert={onRevert}
            />
          )}
        </div>
      )}
      <div className="page-number">{pageIndex + 1}</div>
    </div>
  );
}

// Corners (viewport px) of a block's original bounding box.
function blockCorners(block, viewport) {
  const m = blockMatrix(block, viewport.transform);
  const x0 = (block.boxLeft - block.editorLeft) * S;
  const x1 = (block.x1 - block.editorLeft) * S;
  const h = (block.top - block.bottom) * S;
  return [applyPoint(m, x0, 0), applyPoint(m, x1, 0), applyPoint(m, x1, h), applyPoint(m, x0, h)];
}

function ActiveChip({ block, viewport, fonts, entry, onRevert }) {
  const corners = blockCorners(block, viewport);
  const minX = Math.min(...corners.map((p) => p[0]));
  const maxX = Math.max(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  const maxY = Math.max(...corners.map((p) => p[1]));
  const top = minY > 40 ? minY - 34 : maxY + 6;

  const missing = [...new Set(entry.content.flatMap((r) => missingChars(r.text.replace(/\n/g, ""), fonts[r.fontName])))];
  const fontNames = [...new Set(entry.content.map((r) => fonts[r.fontName]?.displayName).filter(Boolean))];
  const sizes = [...new Set(entry.content.map((r) => r.size.toFixed(1)))];
  const edited = entry.text !== block.text;
  const overflow = (entry.lines?.length || 0) > block.lineCount;

  return (
    <div
      className="chip"
      style={
        minX + 420 > viewport.width
          ? { right: Math.max(4, viewport.width - maxX), top }
          : { left: Math.max(4, minX), top }
      }
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="chip-font" title={fontNames.join(", ")}>
        {fontNames[0]}
        {fontNames.length > 1 ? ` +${fontNames.length - 1}` : ""}
      </span>
      <span className="chip-dim">{sizes.join("/")} pt</span>
      {missing.length > 0 && (
        <span
          className="chip-warn"
          title="The PDF only contains the letters it originally used. For new letters the full font installed on this computer is used (Chrome/Edge will ask for permission when downloading), otherwise the closest standard font."
        >
          ⚠ {missing.slice(0, 5).join(" ")} not in original font
        </span>
      )}
      {overflow && (
        <span className="chip-warn" title="The paragraph now has more lines than before and may overlap content below it.">
          ⚠ longer than original
        </span>
      )}
      {edited && (
        <button type="button" className="chip-btn" onClick={() => onRevert(block.id)}>
          Revert
        </button>
      )}
    </div>
  );
}
