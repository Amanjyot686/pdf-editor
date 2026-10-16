import { useEffect, useLayoutEffect, useRef } from "react";
import { multiply } from "../lib/geometry.js";
import { toCss } from "../lib/colors.js";

// Content is laid out at S CSS px per PDF point and scaled down by the CSS
// matrix, which keeps text crisp and positions precise.
export const S = 6;

/** Matrix mapping the block's content box (CSS px, y down) to viewport px. */
export function blockMatrix(block, viewportTransform) {
  const { cos, sin, editorLeft, top } = block;
  const ex = editorLeft * cos - top * sin;
  const fy = editorLeft * sin + top * cos;
  return multiply(viewportTransform, [cos / S, sin / S, sin / S, -cos / S, ex, fy]);
}

const colorKey = (c) => `${c.r},${c.g},${c.b}`;
const parseColor = (s) => {
  const [r, g, b] = (s || "0,0,0").split(",").map(Number);
  return { r, g, b };
};

function styleOf(el, root) {
  const span = el?.closest?.("[data-font]");
  const src = span && root.contains(span) ? span : root;
  return { fontName: src.dataset.font, size: Number(src.dataset.size), color: parseColor(src.dataset.color) };
}

const sameStyle = (a, b) => a.fontName === b.fontName && a.size === b.size && colorKey(a.color) === colorKey(b.color);

function applyFontStyle(el, run, font) {
  el.dataset.font = run.fontName;
  el.dataset.size = String(run.size);
  el.dataset.color = colorKey(run.color);
  el.style.fontFamily = font?.cssFamily || "sans-serif";
  el.style.fontWeight = font?.cssWeight || "normal";
  el.style.fontStyle = font?.cssStyle || "normal";
  el.style.fontSize = `${run.size * S}px`;
  el.style.color = toCss(run.color);
}

/** Renders styled runs ("\n" = line break) into the editor element. */
function renderContent(root, content, fonts) {
  root.textContent = "";
  for (const run of content) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) root.appendChild(document.createElement("br"));
      if (!part) return;
      const span = document.createElement("span");
      applyFontStyle(span, run, fonts[run.fontName]);
      span.textContent = part;
      root.appendChild(span);
    });
  }
  // A trailing line break needs a second <br> to be visible.
  if (content.length && content[content.length - 1].text.endsWith("\n")) root.appendChild(document.createElement("br"));
}

/** Reads the editor back into styled runs. */
function serialize(root) {
  const runs = [];
  const add = (text, style) => {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else runs.push({ ...style, text });
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.data) add(child.data.replace(/ /g, " "), styleOf(child.parentElement, root));
      } else if (child.nodeName === "BR") {
        add("\n", styleOf(child.parentElement, root));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const isBlock = child.nodeName === "DIV" || child.nodeName === "P";
        const text = runs.map((r) => r.text).join("");
        if (isBlock && text && !text.endsWith("\n")) add("\n", styleOf(child, root));
        walk(child);
      }
    }
  };
  walk(root);
  // Drop the placeholder <br> the browser keeps after a final line break.
  let lastNode = root.lastChild;
  while (lastNode && lastNode.nodeType === Node.ELEMENT_NODE && lastNode.nodeName !== "BR" && lastNode.lastChild) lastNode = lastNode.lastChild;
  const last = runs[runs.length - 1];
  if (lastNode?.nodeName === "BR" && last?.text.endsWith("\n")) {
    last.text = last.text.slice(0, -1);
    if (!last.text) runs.pop();
  }
  return runs;
}

/**
 * Splits the editor's text into the visual lines the browser laid out, by
 * measuring every character in an untransformed off-screen copy.
 */
function measureLines(root, lineHeightPx) {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  const clone = root.cloneNode(true);
  clone.removeAttribute("contenteditable");
  clone.style.position = "relative";
  clone.style.top = "0";
  clone.style.left = "0";
  host.appendChild(clone);
  document.body.appendChild(host);

  const rootTop = clone.getBoundingClientRect().top;
  const lines = [];
  const at = (i) => {
    while (lines.length <= i) lines.push({ runs: [], hard: false });
    return lines[i];
  };
  const range = document.createRange();
  let cur = 0;
  at(0);

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const style = styleOf(child.parentElement, clone);
        let i = 0;
        for (const ch of child.data) {
          range.setStart(child, i);
          range.setEnd(child, i + ch.length);
          const rect = range.getClientRects()[0];
          if (rect && rect.height > 0) {
            const idx = Math.floor((rect.top + rect.height / 2 - rootTop) / lineHeightPx);
            cur = Math.max(cur, idx);
          }
          const line = at(cur);
          const last = line.runs[line.runs.length - 1];
          const text = ch === " " ? " " : ch;
          if (last && sameStyle(last, style)) last.text += text;
          else line.runs.push({ ...style, text });
          i += ch.length;
        }
      } else if (child.nodeName === "BR") {
        at(cur).hard = true;
        cur += 1;
        at(cur);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const isBlock = child.nodeName === "DIV" || child.nodeName === "P";
        if (isBlock && at(cur).runs.length) {
          at(cur).hard = true;
          cur += 1;
        }
        walk(child);
      }
    }
  };
  walk(clone);
  host.remove();

  // The placeholder <br> after a final line break creates no real line.
  if (lines.length > 1 && !lines[lines.length - 1].runs.length && root.lastChild?.nodeName === "BR") lines.pop();
  lines[lines.length - 1].hard = true;
  return lines;
}

function placeCaret(el, point) {
  el.focus({ preventScroll: true });
  const sel = window.getSelection();
  let range = null;
  if (point) {
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(point.x, point.y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(point.x, point.y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range && !el.contains(range.startContainer)) range = null;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function BlockEditor({ block, entry, fonts, active, caretPoint, onFocus, onChange, onDone }) {
  const ref = useRef(null);
  const startContent = useRef(entry.content);
  const lineHeightPx = block.lineGap * S;

  const emit = () => {
    const content = serialize(ref.current);
    onChange({ content, lines: measureLines(ref.current, lineHeightPx) });
  };

  // Uncontrolled: React never rewrites the text while the user is typing.
  useLayoutEffect(() => {
    const el = ref.current;
    renderContent(el, entry.content, fonts);
    // Shift the editor so its first baseline sits exactly on the original one.
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    el.insertBefore(marker, el.firstChild);
    const baseline = marker.offsetTop;
    marker.remove();
    el.style.top = `${(block.top - block.firstBaseline) * S - baseline}px`;
    if (!entry.lines) emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active && document.activeElement !== ref.current) placeCaret(ref.current, caretPoint);
  }, [active, caretPoint]);

  const first = entry.content[0] || block.content[0];
  const firstFont = fonts[first?.fontName];

  return (
    <div
      ref={ref}
      className="tb-editor"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-font={first?.fontName}
      data-size={first?.size}
      data-color={colorKey(first?.color || { r: 0, g: 0, b: 0 })}
      style={{
        width: block.wrapWidth != null ? block.wrapWidth * S : undefined,
        whiteSpace: block.wrapWidth != null ? "pre-wrap" : "pre",
        lineHeight: `${lineHeightPx}px`,
        textAlign: block.align,
        textIndent: block.indent * S,
        fontFamily: firstFont?.cssFamily,
        fontWeight: firstFont?.cssWeight,
        fontStyle: firstFont?.cssStyle,
        fontSize: (first?.size || block.size) * S,
        color: first?.color ? toCss(first.color) : undefined,
      }}
      onFocus={() => {
        startContent.current = serialize(ref.current);
        onFocus();
      }}
      onInput={emit}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.execCommand("insertLineBreak");
          emit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          renderContent(ref.current, startContent.current, fonts);
          emit();
          ref.current.blur();
        } else if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) {
          e.preventDefault(); // keep the PDF's own fonts; no browser formatting
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const lines = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\t/g, " ").split("\n");
        lines.forEach((line, i) => {
          if (i > 0) document.execCommand("insertLineBreak");
          if (line) document.execCommand("insertText", false, line);
        });
        emit();
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

export default function TextBlock({ block, viewportTransform, fonts, entry, active, caretPoint, onActivate, onChange, onBlur }) {
  const m = blockMatrix(block, viewportTransform);
  const inv = 1 / Math.hypot(m[0], m[1]); // content px per screen px
  const edited = !!entry && entry.text !== block.text;
  const showEditor = !!entry && (active || edited);
  const pad = 0.12 * block.size * S;

  return (
    <div className="tb-wrap" style={{ transform: `matrix(${m.join(",")})`, "--inv": inv }}>
      <div
        className={`tb-box${active ? " active" : ""}${edited ? " edited" : ""}`}
        title={active ? undefined : "Click to edit"}
        aria-label={block.text}
        style={{
          left: (block.boxLeft - block.editorLeft) * S - pad,
          top: -pad,
          width: (block.x1 - block.boxLeft) * S + pad * 2,
          height: (block.top - block.bottom) * S + pad * 2,
          background: showEditor ? toCss(entry.bg) : undefined,
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onActivate(block, { x: e.clientX, y: e.clientY });
        }}
      />
      {showEditor && (
        <BlockEditor
          block={block}
          entry={entry}
          fonts={fonts}
          active={active}
          caretPoint={caretPoint}
          onFocus={() => !active && onActivate(block, null)}
          onChange={(data) => onChange(block.id, data)}
          onDone={() => onBlur(block.id)}
        />
      )}
    </div>
  );
}
