import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { multiply } from "../lib/geometry.js";
import { toCss } from "../lib/colors.js";
import { getLoadedFont, runCss } from "../lib/fonts.js";
import { isEdited, lineGapOf } from "../lib/entries.js";

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

const flag = (v) => (v === "1" ? true : v === "0" ? false : undefined);

function styleOf(el, root) {
  const span = el?.closest?.("[data-font]");
  const src = span && root.contains(span) ? span : root;
  const style = { fontName: src.dataset.font, size: Number(src.dataset.size), color: parseColor(src.dataset.color) };
  const bold = flag(src.dataset.bold);
  const italic = flag(src.dataset.italic);
  if (bold !== undefined) style.bold = bold;
  if (italic !== undefined) style.italic = italic;
  if (src.dataset.underline === "1") style.underline = true;
  return style;
}

const sameStyle = (a, b) =>
  a.fontName === b.fontName &&
  a.size === b.size &&
  colorKey(a.color) === colorKey(b.color) &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  !!a.underline === !!b.underline;

/** Drops bold / italic settings that just repeat what the font already is. */
function normalizeRun(run) {
  const info = getLoadedFont(run.fontName);
  const out = { ...run };
  if (info && out.bold === info.bold) delete out.bold;
  if (info && out.italic === info.italic) delete out.italic;
  if (!out.underline) delete out.underline;
  return out;
}

// Clipboard format carrying the styled runs of text copied in the editor.
const CLIP_MIME = "application/x-teleforce-pdf-runs";
let lastCopy = null; // { text, runs } fallback if the browser drops the custom type

const fontOf = (fonts, name) => fonts[name] || getLoadedFont(name);

// eslint-disable-next-line no-unused-vars
function applyFontStyle(el, run, font) {
  el.dataset.font = run.fontName;
  el.dataset.size = String(run.size);
  el.dataset.color = colorKey(run.color);
  if (run.bold !== undefined) el.dataset.bold = run.bold ? "1" : "0";
  if (run.italic !== undefined) el.dataset.italic = run.italic ? "1" : "0";
  if (run.underline) el.dataset.underline = "1";
  // Shows bold / italic the way the export will draw it.
  const css = runCss(run);
  el.style.fontFamily = css.family;
  el.style.fontWeight = css.weight;
  el.style.fontStyle = css.style;
  el.style.fontSize = `${run.size * S}px`;
  el.style.color = toCss(run.color);
  el.style.textDecoration = run.underline ? "underline" : "none";
}

/** Text offset of a DOM position (BR counts as one "\n"). */
function offsetOf(root, container, offset) {
  let count = 0;
  let found = null;
  const walk = (node) => {
    if (found !== null) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === container) found = count + offset;
      else count += node.data.length;
      return;
    }
    if (node.nodeName === "BR") {
      count += 1;
      return;
    }
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (node === container && i === offset) {
        found = count;
        return;
      }
      walk(kids[i]);
      if (found !== null) return;
    }
    if (node === container) found = count;
  };
  walk(root);
  return found ?? count;
}

/** DOM position of a text offset. */
function positionAt(root, target) {
  let count = 0;
  let result = null;
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length && !result; i++) {
      const child = node.childNodes[i];
      if (child.nodeType === Node.TEXT_NODE) {
        if (target <= count + child.data.length) result = { node: child, offset: target - count };
        else count += child.data.length;
      } else if (child.nodeName === "BR") {
        if (target <= count) result = { node, offset: i };
        else count += 1;
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return result || { node: root, offset: root.childNodes.length };
}

function selectOffsets(root, a, b) {
  const start = positionAt(root, a);
  const end = positionAt(root, b);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return range;
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

function BlockEditor({ block, entry, fonts, active, caretPoint, onFocus, onChange, onDone, registerEditor }) {
  const ref = useRef(null);
  const startContent = useRef(entry.content);
  const savedRange = useRef(null);
  const lineHeightPx = lineGapOf(entry) * S;
  // Styled text waiting for the user to pick a paste option.
  const [pending, setPending] = useState(null);

  // Keeps the first baseline exactly on the original one.
  const alignBaseline = () => {
    const el = ref.current;
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    el.insertBefore(marker, el.firstChild);
    const baseline = marker.offsetTop;
    marker.remove();
    el.style.top = `${(block.top - block.firstBaseline) * S - baseline}px`;
  };

  const emit = (extra) => {
    const content = serialize(ref.current);
    const gap = lineGapOf({ ...entry, content }) * S;
    ref.current.style.lineHeight = `${gap}px`;
    onChange({ content, lines: measureLines(ref.current, gap), ...extra });
  };

  // Remember the selection, so toolbar controls that take focus can use it.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (sel.rangeCount && ref.current?.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        savedRange.current = sel.getRangeAt(0).cloneRange();
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  /** Selection as text offsets; a bare caret means the whole paragraph. */
  const targetOffsets = () => {
    const root = ref.current;
    const total = offsetOf(root, root, root.childNodes.length);
    // The live selection while the editor has focus (selectionchange fires
    // late, so the saved copy can lag); the saved one when a toolbar control
    // has taken focus.
    const sel = window.getSelection();
    const live = document.activeElement === root && sel.rangeCount ? sel.getRangeAt(0) : null;
    const r = live && root.contains(live.commonAncestorContainer) ? live : savedRange.current;
    if (!r || !root.contains(r.commonAncestorContainer)) return [0, total, true];
    const a = offsetOf(root, r.startContainer, r.startOffset);
    const b = offsetOf(root, r.endContainer, r.endOffset);
    return a === b ? [0, total, true] : [Math.min(a, b), Math.max(a, b), false];
  };

  /** Runs inside the target range (for the toolbar's on/off states). */
  const targetRuns = () => {
    const [a, b] = targetOffsets();
    const out = [];
    let pos = 0;
    for (const r of serialize(ref.current)) {
      const s0 = pos;
      pos += r.text.length;
      if (pos > a && s0 < b && r.text.trim()) out.push(r);
    }
    return out.length ? out : serialize(ref.current).slice(0, 1);
  };

  /** Applies `patch(run)` to the selected text (or the whole paragraph). */
  const format = (patch, { refocus = true } = {}) => {
    const root = ref.current;
    const [a, b, whole] = targetOffsets();
    const out = [];
    let pos = 0;
    for (const r of serialize(root)) {
      const s0 = pos;
      const e0 = pos + r.text.length;
      pos = e0;
      const cuts = [s0, Math.min(e0, Math.max(s0, a)), Math.min(e0, Math.max(s0, b)), e0];
      for (let k = 0; k < 3; k++) {
        const text = r.text.slice(cuts[k] - s0, cuts[k + 1] - s0);
        if (!text) continue;
        const piece = k === 1 ? normalizeRun(patch({ ...r, text })) : { ...r, text };
        const last = out[out.length - 1];
        if (last && sameStyle(last, piece)) last.text += piece.text;
        else out.push(piece);
      }
    }
    renderContent(root, out, fonts);
    alignBaseline();
    if (refocus) root.focus({ preventScroll: true });
    savedRange.current = whole ? null : selectOffsets(root, a, b).cloneRange();
    emit({ formatted: true });
  };

  const api = {
    state() {
      const runs = targetRuns();
      const w = runs.map((r) => {
        const info = getLoadedFont(r.fontName);
        return { bold: r.bold ?? !!info?.bold, italic: r.italic ?? !!info?.italic };
      });
      const uniform = (fn) => (runs.every((r) => fn(r) === fn(runs[0])) ? fn(runs[0]) : null);
      return {
        bold: w.every((x) => x.bold),
        italic: w.every((x) => x.italic),
        underline: runs.every((r) => r.underline),
        size: uniform((r) => r.size),
        color: runs[0]?.color,
        fontName: uniform((r) => r.fontName),
        align: entry.align || block.align,
        canAlign: block.wrapWidth != null,
      };
    },
    format,
    setAlign(align) {
      ref.current.style.textAlign = align;
      emit({ align, formatted: true });
    },
    focus() {
      ref.current.focus({ preventScroll: true });
      if (savedRange.current) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      }
    },
  };
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    // A stable facade, so the toolbar always calls the latest handlers.
    const facade = {
      state: () => apiRef.current.state(),
      format: (...a) => apiRef.current.format(...a),
      setAlign: (a) => apiRef.current.setAlign(a),
      focus: () => apiRef.current.focus(),
    };
    registerEditor?.(block.id, facade);
    return () => registerEditor?.(block.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (key) => {
    const st = api.state();
    format((r) => ({ ...r, [key]: !st[key] }));
  };

  // Uncontrolled: React never rewrites the text while the user is typing.
  useLayoutEffect(() => {
    renderContent(ref.current, entry.content, fonts);
    alignBaseline();
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
    alignBaseline();
    emit(keepSource ? { formatted: true } : undefined);
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
        textAlign: entry.align || block.align,
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
      onBlur={(e) => {
        setPending(null);
        // Focus moving into the formatting toolbar keeps the paragraph active.
        if (e.relatedTarget?.closest?.(".fmt-toolbar")) return;
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
          e.preventDefault();
          toggle({ b: "bold", i: "italic", u: "underline" }[e.key.toLowerCase()]);
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

export default function TextBlock({ block, viewportTransform, fonts, entry, active, caretPoint, onActivate, onChange, onBlur, registerEditor }) {
  const m = blockMatrix(block, viewportTransform);
  const inv = 1 / Math.hypot(m[0], m[1]); // content px per screen px
  const edited = isEdited(entry);
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
          registerEditor={registerEditor}
        />
      )}
    </div>
  );
}
