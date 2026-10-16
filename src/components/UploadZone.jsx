import { useRef, useState } from "react";

export default function UploadZone({ onFile, loading, error }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const pick = (files) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div className="upload-screen">
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onClick={() => !loading && inputRef.current.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current.click()}
      >
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M12 18v-6M9 15l3-3 3 3" />
        </svg>
        <h2>{loading ? "Opening PDF…" : "Upload a PDF to edit"}</h2>
        <p>Drag &amp; drop a file here, or click to choose one</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ol className="how-to">
        <li>Upload your PDF</li>
        <li>Click any text and type. It keeps the original font, size and colour</li>
        <li>Download the edited PDF</li>
      </ol>
    </div>
  );
}
