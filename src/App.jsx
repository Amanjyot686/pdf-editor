import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadZone from "./components/UploadZone.jsx";
import PdfPage from "./components/PdfPage.jsx";
import { openPdf } from "./lib/pdfjs.js";
import { getFontInfo, missingChars, resetFonts } from "./lib/fonts.js";
import { localFontsSupported, requestLocalFonts } from "./lib/localFonts.js";
import { exportEditedPdf } from "./lib/exportPdf.js";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function App() {
  const [doc, setDoc] = useState(null); // { name, bytes, pdf }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1.25);
  const [edits, setEdits] = useState({});
  const [active, setActive] = useState(null); // { id, point }
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const changed = useMemo(() => Object.values(edits).filter((e) => e.text !== e.block.text), [edits]);
  const changedRef = useRef(changed);
  changedRef.current = changed;

  const openFile = async (file) => {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      setError("Please choose a PDF file.");
      return;
    }
    if (dirty && !window.confirm("You have unsaved changes. Open a different PDF anyway?")) return;
    setLoading(true);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      doc?.pdf.destroy();
      resetFonts();
      const pdf = await openPdf(bytes);
      const first = await pdf.getPage(1);
      const width = first.getViewport({ scale: 1 }).width;
      const fit = (Math.min(window.innerWidth, 1400) - 96) / width;
      setScale(ZOOMS.reduce((best, z) => (z <= fit && z > best ? z : best), ZOOMS[0]));
      setEdits({});
      setActive(null);
      setDirty(false);
      setDoc({ id: Date.now(), name: file.name, bytes, pdf });
    } catch (err) {
      setError(err.message || "Could not open this PDF.");
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = useCallback((id, entry, point) => {
    setActive({ id, point });
    if (entry) setEdits((prev) => (prev[id] ? prev : { ...prev, [id]: entry }));
  }, []);

  const handleChange = useCallback((id, { content, lines }) => {
    setEdits((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const text = content.map((r) => r.text).join("");
      if (text !== cur.text) setDirty(true);
      return { ...prev, [id]: { ...cur, content, lines, text } };
    });
  }, []);

  const handleBlur = useCallback((id) => {
    setActive((cur) => (cur?.id === id ? null : cur));
  }, []);

  const handleRevert = useCallback((id) => {
    setActive(null);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const resetAll = () => {
    if (!changed.length || !window.confirm(`Discard all ${changed.length} change(s)?`)) return;
    setActive(null);
    setEdits({});
    setDirty(false);
  };

  const download = useCallback(async () => {
    if (!doc || saving) return;
    document.activeElement?.blur?.();
    setSaving(true);
    setError("");
    try {
      const entries = changedRef.current;
      if (localFontsSupported()) {
        const runs = entries.flatMap((e) => e.content);
        const infos = await Promise.all(runs.map((r) => getFontInfo(r.fontName)));
        // Letters missing from the PDF's embedded fonts: ask for the installed
        // fonts so they can be written in the exact same typeface.
        if (runs.some((r, i) => missingChars(r.text.replace(/\n/g, ""), infos[i]).length)) await requestLocalFonts();
      }
      const { bytes } = await exportEditedPdf(doc.bytes, entries);
      downloadBytes(bytes, doc.name.replace(/\.pdf$/i, "") + "-edited.pdf");
      setDirty(false);
    } catch (err) {
      console.error(err);
      setError(err.message || "Could not create the edited PDF.");
    } finally {
      setSaving(false);
    }
  }, [doc, saving]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        download();
      }
    };
    const onUnload = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [download, dirty]);

  const zoom = (dir) => {
    const i = ZOOMS.indexOf(scale);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? 3 : i) + dir))];
    setActive(null);
    setScale(next);
  };

  if (!doc) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">Teleforce PDF Editor</div>
        </header>
        <UploadZone onFile={openFile} loading={loading} error={error} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Teleforce PDF Editor</div>
        <div className="file-name" title={doc.name}>
          {doc.name}
          <span className="muted"> · {doc.pdf.numPages} page{doc.pdf.numPages > 1 ? "s" : ""}</span>
          {changed.length > 0 && <span className="badge">{changed.length} edited</span>}
        </div>
        <div className="actions">
          <div className="zoom">
            <button type="button" onClick={() => zoom(-1)} aria-label="Zoom out">−</button>
            <span>{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoom(1)} aria-label="Zoom in">+</button>
          </div>
          <label className="btn">
            Open another
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) openFile(f);
              }}
            />
          </label>
          <button type="button" className="btn" onClick={resetAll} disabled={!changed.length}>
            Reset all
          </button>
          <button type="button" className="btn primary" onClick={download} disabled={saving}>
            {saving ? "Preparing…" : "Download PDF"}
          </button>
        </div>
      </header>
      <div className="hint">
        Click any paragraph to edit it. <kbd>Enter</kbd> new line, <kbd>Esc</kbd> cancel, click outside to finish,{" "}
        <kbd>Ctrl</kbd>+<kbd>S</kbd> download.
      </div>
      {error && <div className="error-banner floating">{error}</div>}
      {loading && <div className="loading-veil">Opening PDF…</div>}
      <main className="viewer">
        {Array.from({ length: doc.pdf.numPages }, (_, i) => (
          <PdfPage
            key={`${doc.id}-${i}`}
            pdf={doc.pdf}
            pageIndex={i}
            scale={scale}
            edits={edits}
            active={active}
            onActivate={handleActivate}
            onChange={handleChange}
            onBlur={handleBlur}
            onRevert={handleRevert}
          />
        ))}
      </main>
    </div>
  );
}
