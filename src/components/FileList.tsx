import { useState } from "react";
import type { RemoteFile } from "../api/supplements";
import { isTabular } from "../data/table";
import { openExternal } from "../platform";
import { MAX_DOWNLOAD, openRemote } from "../viewer";
import { errorText, formatBytes } from "./ui";

/** Remote files; tables open in the Data tab, anything else in the browser. */
export function FileList({ files, title }: { files: RemoteFile[]; title: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (f: RemoteFile) => {
    const viewable = isTabular(f.name) && (f.size ?? 0) <= MAX_DOWNLOAD;
    if (!viewable) return openExternal(f.url);
    setBusy(f.name);
    setError(null);
    try {
      await openRemote(f, title);
    } catch (e) {
      setError(`${f.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="list">
        {files.map((f) => {
          const viewable = isTabular(f.name) && (f.size ?? 0) <= MAX_DOWNLOAD;
          return (
            <button key={f.url} className="item" disabled={busy !== null} onClick={() => open(f)}>
              <span className="item-main">
                <span className="item-title">{f.name}</span>
                <div className="item-meta">
                  {busy === f.name ? "Downloading…" : viewable ? "Open as a table" : "Open in browser"}
                </div>
              </span>
              <span className="item-side">{formatBytes(f.size)}</span>
            </button>
          );
        })}
      </div>
      {error && <div className="status error">{error}</div>}
    </>
  );
}
