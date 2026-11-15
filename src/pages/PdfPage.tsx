import { useEffect, useRef, useState } from "react";
// The legacy build carries polyfills that older Android WebViews need.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { Back, errorText } from "../components/ui";
import { storedUrl } from "../platform";
import { repo } from "../store";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** One page at a time, fitted to the screen width. Remembers the page you were on. */
export default function PdfPage({ uid }: { uid: string }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let task: pdfjs.PDFDocumentLoadingTask | undefined;
    (async () => {
      const r = await repo().resource(uid);
      if (!r?.file) throw new Error("This item has no PDF attached.");
      setTitle(r.title);
      setPage(Number(r.position) || 1);
      // Loaded by URL so pdf.js can fetch byte ranges instead of holding a whole textbook in memory.
      task = pdfjs.getDocument({ url: await storedUrl(r.file) });
      setDoc(await task.promise);
    })().catch((e) => setError(errorText(e)));
    return () => void task?.destroy();
  }, [uid]);

  useEffect(() => {
    if (!doc || !canvas.current || !holder.current) return;
    let cancelled = false;
    let render: pdfjs.RenderTask | undefined;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const width = holder.current!.clientWidth;
      const scale = (width / p.getViewport({ scale: 1 }).width) * zoom;
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: scale * ratio });
      const c = canvas.current!;
      c.width = viewport.width;
      c.height = viewport.height;
      c.style.width = `${viewport.width / ratio}px`;
      c.style.height = `${viewport.height / ratio}px`;
      render = p.render({ canvas: c, viewport });
      await render.promise;
    })().catch((e) => e?.name !== "RenderingCancelledException" && setError(errorText(e)));
    void repo().updateResource(uid, { position: String(page) });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, page, zoom, uid]);

  const pages = doc?.numPages ?? 0;
  const go = (n: number) => {
    setPage(Math.min(Math.max(1, n), pages || 1));
    window.scrollTo(0, 0);
  };

  return (
    <div className="page wide">
      <Back label={title || "Back"} />
      {error && <div className="status error">{error}</div>}
      {!doc && !error && <div className="status">Opening…</div>}
      {doc && (
        <div className="pdf-bar">
          <button className="button small" disabled={page <= 1} onClick={() => go(page - 1)}>
            ‹ Prev
          </button>
          <input
            type="number"
            aria-label="Page"
            min={1}
            max={pages}
            value={page}
            onChange={(e) => e.target.value && go(Number(e.target.value))}
          />
          <span className="muted small">of {pages}</span>
          <button className="button small" disabled={page >= pages} onClick={() => go(page + 1)}>
            Next ›
          </button>
          <span className="spacer" />
          <button className="button small" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => z - 0.5)}>
            −
          </button>
          <button className="button small" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((z) => z + 0.5)}>
            +
          </button>
        </div>
      )}
      <div className="pdf-page" ref={holder} style={{ visibility: doc ? "visible" : "hidden" }}>
        <canvas ref={canvas} />
      </div>
    </div>
  );
}
