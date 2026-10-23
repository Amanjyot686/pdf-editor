import { useEffect, useReducer, useState } from "react";
import { documentFamilies, familyKey, getLoadedFont, missingChars, pickFamilyFont, resolveVariant, runWeight } from "../lib/fonts.js";
import { isEdited } from "../lib/entries.js";

const toHex = (c) => (c ? "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("") : "#000000");
const fromHex = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
const roundSize = (n) => Math.round(n * 2) / 2;

const ALIGNS = [
  { value: "left", label: "Align left", icon: "M3 5h18M3 10h12M3 15h18M3 20h12" },
  { value: "center", label: "Centre", icon: "M3 5h18M6 10h12M3 15h18M6 20h12" },
  { value: "right", label: "Align right", icon: "M3 5h18M9 10h12M3 15h18M9 20h12" },
  { value: "justify", label: "Justify", icon: "M3 5h18M3 10h18M3 15h18M3 20h18" },
];

/**
 * Formatting bar for the paragraph being edited. Commands apply to the
 * selected text, or to the whole paragraph when nothing is selected.
 */
export default function FormatToolbar({ block, entry, api, position, onRevert, onLeave }) {
  const [, refresh] = useReducer((x) => x + 1, 0);
  const [sizeDraft, setSizeDraft] = useState(null);

  // Re-read the selection's styles whenever the selection moves.
  useEffect(() => {
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, []);

  if (!api) return null;
  const st = api.state();
  const fam = st.fontName ? familyKey(getLoadedFont(st.fontName)) : "";
  const families = documentFamilies();

  const missing = [
    ...new Set(
      entry.content.flatMap((r) => {
        const v = resolveVariant(r);
        return missingChars(r.text.replace(/\n/g, ""), getLoadedFont(v.fontName));
      })
    ),
  ];
  const overflow = (entry.lines?.length || 0) > block.lineCount;
  const simulated = entry.content.some((r) => r.text.trim() && !resolveVariant(r).exact);

  const commitSize = () => {
    const n = parseFloat(sizeDraft);
    setSizeDraft(null);
    if (Number.isFinite(n) && n >= 1 && n <= 300) api.format((r) => ({ ...r, size: n }));
  };
  const step = (dir) => api.format((r) => ({ ...r, size: Math.max(1, roundSize(r.size + dir * (r.size < 12 ? 0.5 : 1))) }));

  // Leaving the toolbar for anywhere but the editor ends the edit.
  const onBlurControl = (e) => {
    const to = e.relatedTarget;
    if (!to || !(to.closest(".fmt-toolbar") || to.closest(".tb-editor"))) onLeave();
  };

  return (
    <div
      className="fmt-toolbar"
      style={position}
      onMouseDown={(e) => {
        // Buttons must not steal focus (that would lose the text selection).
        if (e.target.closest("button")) e.preventDefault();
      }}
      role="toolbar"
      aria-label="Text formatting"
    >
      <div className="fmt-row">
        <select
          className="fmt-font"
          value={fam}
          title="Font"
          onChange={(e) => {
            const key = e.target.value;
            api.format((r) => {
              const w = runWeight(r);
              return { ...r, fontName: pickFamilyFont(key, w.bold, w.italic) || r.fontName, bold: w.bold, italic: w.italic };
            });
          }}
          onBlur={onBlurControl}
        >
          {!fam && <option value="">Mixed fonts</option>}
          {families.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>

        <div className="fmt-size" title="Font size (pt)">
          <button type="button" onClick={() => step(-1)} aria-label="Smaller">
            −
          </button>
          <input
            value={sizeDraft ?? (st.size != null ? String(roundSize(st.size)) : "")}
            placeholder="–"
            inputMode="decimal"
            aria-label="Font size"
            onChange={(e) => setSizeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitSize();
                api.focus();
              } else if (e.key === "Escape") {
                setSizeDraft(null);
                api.focus();
              }
            }}
            onBlur={(e) => {
              if (sizeDraft != null) commitSize();
              onBlurControl(e);
            }}
          />
          <button type="button" onClick={() => step(1)} aria-label="Larger">
            +
          </button>
        </div>

        <span className="fmt-sep" />
        <button type="button" className={`fmt-btn fmt-b${st.bold ? " on" : ""}`} aria-pressed={st.bold} title="Bold (Ctrl+B)" onClick={() => api.format((r) => ({ ...r, bold: !st.bold }))}>
          B
        </button>
        <button type="button" className={`fmt-btn fmt-i${st.italic ? " on" : ""}`} aria-pressed={st.italic} title="Italic (Ctrl+I)" onClick={() => api.format((r) => ({ ...r, italic: !st.italic }))}>
          I
        </button>
        <button type="button" className={`fmt-btn fmt-u${st.underline ? " on" : ""}`} aria-pressed={st.underline} title="Underline (Ctrl+U)" onClick={() => api.format((r) => ({ ...r, underline: !st.underline }))}>
          U
        </button>
        <label className="fmt-color" title="Text colour">
          <span className="fmt-color-a" style={{ borderBottomColor: toHex(st.color) }}>
            A
          </span>
          <input
            type="color"
            value={toHex(st.color)}
            onChange={(e) => api.format((r) => ({ ...r, color: fromHex(e.target.value) }), { refocus: false })}
            onBlur={onBlurControl}
          />
        </label>

        {st.canAlign && (
          <>
            <span className="fmt-sep" />
            {ALIGNS.map((a) => (
              <button
                key={a.value}
                type="button"
                className={`fmt-btn${st.align === a.value ? " on" : ""}`}
                title={a.label}
                aria-pressed={st.align === a.value}
                onClick={() => api.setAlign(a.value)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                  <path d={a.icon} />
                </svg>
              </button>
            ))}
          </>
        )}

        {isEdited(entry) && (
          <>
            <span className="fmt-sep" />
            <button type="button" className="fmt-revert" onClick={() => onRevert(block.id)}>
              Revert
            </button>
          </>
        )}
      </div>

      {(missing.length > 0 || overflow || simulated) && (
        <div className="fmt-notes">
          {missing.length > 0 && (
            <span title="The PDF only contains the letters it originally used. For new letters the full font installed on this computer is used (Chrome/Edge will ask for permission when downloading), otherwise the closest standard font.">
              ⚠ {missing.slice(0, 5).join(" ")} not in original font
            </span>
          )}
          {simulated && (
            <span title="This PDF has no bold/italic version of this font. The installed version is used if available, otherwise bold/italic is simulated.">
              ⓘ bold/italic not in PDF – using installed or simulated style
            </span>
          )}
          {overflow && <span title="The paragraph now has more lines than before and may overlap content below it.">⚠ longer than original</span>}
        </div>
      )}
    </div>
  );
}
