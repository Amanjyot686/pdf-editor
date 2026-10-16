import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { multiply } from "../lib/geometry.js";
import { toCss } from "../lib/colors.js";
import { getLoadedFont } from "../lib/fonts.js";

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

// Clipboard format carrying the styled runs of text copied in the editor.
const CLIP_MIME = "application/x-teleforce-pdf-runs";
let lastCopy = null; // { text, runs } fallback if the browser drops the custom type

const fontOf = (fonts, name) => fonts[name] || getLoadedFont(name);

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
      applyFontStyle(span, run, fontOf(fonts, run.fontName));
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

/** Styled runs of the part of the editor covered by `range`. */
function selectedRuns(root, range) {
  const runs = [];
  const add = (text, style) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else runs.push({ ...style, text });
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (!range.intersectsNode(child)) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        const start = child === range.startContainer ? range.startOffset : 0;
        const end = child === range.endContainer ? range.endOffset : child.data.length;
        add(child.data.slice(start, end).replace(/\u00a0/g, " "), styleOf(child.parentElement, root));
      } else if (child.nodeName === "BR") {
        add("\n", styleOf(child.parentElement, root));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }
  };
  walk(root);
  return runs;
}

/** Inserts styled runs at `range`, keeping their own font, size and colour. */
function insertRuns(range, runs, fonts) {
  range.deleteContents();
  const frag = document.createDocumentFragment();
  let lastNode = null;
  for (const run of runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) frag.appendChild((lastNode = document.createElement("br")));
      if (!part) return;
      const span = document.createElement("span");
      applyFontStyle(span, run, fontOf(fonts, run.fontName));
      span.textContent = part;
      frag.appendChild((lastNode = span));
    });
  }
  if (!lastNode) return;
  range.insertNode(frag);
  const caret = document.createRange();
  caret.setStartAfter(lastNode);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);
}

/** Inserts plain text at the caret, taking the style of the text around it. */
function insertPlain(text) {
  text.split("\n").forEach((line, i) => {
    if (i > 0) document.execCommand("insertLineBreak");
    if (line) document.execCommand("insertText", false, line);
  });
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
  // Styled text waiting for the user to pick a paste option.
  const [pending, setPending] = useState(null);

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

  const selectionRange = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return ref.current.contains(range.commonAncestorContainer) ? range : null;
  };

  const copySelection = (e) => {
    const range = selectionRange();
    if (!range || range.collapsed) return false;
    const runs = selectedRuns(ref.current, range);
    const text = runs.map((r) => r.text).join("");
    e.clipboardData.setData("text/plain", text);
    e.clipboardData.setData(CLIP_MIME, JSON.stringify(runs));
    lastCopy = { text, runs };
    e.preventDefault();
    return true;
  };

  const choosePaste = (keepSource) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    ref.current.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(p.range);
    if (keepSource) insertRuns(p.range, p.runs, fonts);
    else insertPlain(p.text);
    emit();
  };

  const first = entry.content[0] || block.content[0];
  const firstFont = fontOf(fonts, first?.fontName);

  return (
    <>
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
      onBlur={() => {
        setPending(null);
        onDone();
      }}
      onKeyDown={(e) => {
        if (pending) {
          // Paste options are open: Enter keeps the source style, M matches
          // the destination, Esc cancels the paste.
          e.preventDefault();
          if (e.key === "Enter") choosePaste(true);
          else if (e.key.toLowerCase() === "m") choosePaste(false);
          else if (e.key === "Escape") setPending(null);
          return;
        }
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
      onCopy={copySelection}
      onCut={(e) => {
        if (copySelection(e)) {
          document.execCommand("delete");
          emit();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
        let runs = null;
        try {
          runs = JSON.parse(e.clipboardData.getData(CLIP_MIME) || "null");
        } catch {
          runs = null;
        }
        if (!runs && lastCopy && lastCopy.text === text) runs = lastCopy.runs;
        const range = selectionRange();
        if (runs?.length && range) {
          // Styled text copied in this editor: ask whether to keep its style,
          // unless it already matches the text it is pasted into.
          const at = range.startContainer;
          const dest = styleOf(at.nodeType === Node.TEXT_NODE ? at.parentElement : at, ref.current);
          if (runs.some((r) => !sameStyle(r, dest))) {
            const rect = range.getClientRects()[0] || ref.current.getBoundingClientRect();
            setPending({ runs, text, dest, range: range.cloneRange(), x: rect.left, y: rect.bottom });
            return;
          }
        }
        insertPlain(text);
        emit();
      }}
      onDrop={(e) => e.preventDefault()}
    />
    {pending &&
      createPortal(
        <PasteOptions pending={pending} fonts={fonts} onChoose={choosePaste} onCancel={() => setPending(null)} />,
        document.body
      )}
    </>
  );
}

function Preview({ run, text, fonts }) {
  const font = fontOf(fonts, run.fontName);
  return (
    <span
      className="paste-preview"
      style={{ fontFamily: font?.cssFamily, fontWeight: font?.cssWeight, fontStyle: font?.cssStyle, color: toCss(run.color) }}
    >
      {text}
    </span>
  );
}

function PasteOptions({ pending, fonts, onChoose, onCancel }) {
  const sample = pending.text.replace(/\s+/g, " ").trim();
  const short = sample.length > 24 ? `${sample.slice(0, 24)}…` : sample;
  const name = (run) => fontOf(fonts, run.fontName)?.displayName || "font";
  const src = pending.runs[0];
  const left = Math.min(Math.max(8, pending.x), window.innerWidth - 340);
  const top = Math.min(pending.y + 6, window.innerHeight - 170);
  return (
    <div className="paste-menu" style={{ left, top }} onMouseDown={(e) => e.preventDefault()} role="dialog" aria-label="Paste options">
      <div className="paste-title">Paste as</div>
      <button type="button" className="paste-option keep" onClick={() => onChoose(true)}>
        <Preview run={src} text={short} fonts={fonts} />
        <span className="paste-label">
          <span className="paste-name">Keep source formatting <kbd>Enter</kbd></span>
          <small>
            {name(src)} · {src.size.toFixed(1)} pt{pending.runs.length > 1 ? " · mixed styles" : ""}
          </small>
        </span>
      </button>
      <button type="button" className="paste-option match" onClick={() => onChoose(false)}>
        <Preview run={pending.dest} text={short} fonts={fonts} />
        <span className="paste-label">
          <span className="paste-name">Match destination <kbd>M</kbd></span>
          <small>
            {name(pending.dest)} · {pending.dest.size.toFixed(1)} pt
          </small>
        </span>
      </button>
      <button type="button" className="paste-cancel" onClick={onCancel}>
        Cancel <kbd>Esc</kbd>
      </button>
    </div>
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
