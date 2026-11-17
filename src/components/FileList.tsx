import { useEffect, useState } from "react";
import { gunzipSync } from "fflate";
import { geoStub, platformSymbols, seriesSamples } from "../api/geo";
import type { RemoteFile } from "../api/supplements";
import { addSymbols, annotate, mergeSampleFiles, parseSeriesMatrix } from "../data/geo";
import { isTabular, readTables, type Table } from "../data/table";
import type { Download } from "../db/repo";
import {
  IN_APP,
  downloadToStore,
  onDownloadProgress,
  openExternal,
  readStored,
  removeStored,
  tarExtract,
  tarList,
} from "../platform";
import { repo } from "../store";
import { MAX_TABLE_BYTES, showLoadedTables } from "../viewer";
import { ask, errorText, formatBytes } from "./ui";

/** GEO context, when the files belong to a series: its sample annotations label columns. */
export interface GeoContext {
  accession: string;
  platforms: string[];
}

const ARCHIVE = /\.(tar|tar\.gz|tgz)$/i;
const UNREADABLE: [RegExp, string][] = [
  [/\.cel(\.gz)?$/i, "raw Affymetrix scans"],
  [/\.(bam|sam|cram|fastq|fq)(\.gz)?$/i, "sequencing reads"],
  [/\.(bw|bigwig|bed|wig)(\.gz)?$/i, "genome tracks"],
  [/\.(idat|chp)(\.gz)?$/i, "raw array files"],
  [/\.(h5|h5ad|rds|rdata|loom|mtx)(\.gz)?$/i, "single-cell or R objects"],
];

function describe(name: string): string | null {
  return UNREADABLE.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Downloads above this size ask first. */
const LARGE = 50 * 1024 * 1024;

/** Why a file is not worth downloading, or null when Corpus can open it. An archive is judged
 *  by its listed contents: one with no tables inside holds nothing Corpus can read. */
function unreadable(f: RemoteFile): string | null {
  if (!f.contents || !ARCHIVE.test(f.name)) return describe(f.name);
  if (f.contents.some((e) => isTabular(e.name) && !ARCHIVE.test(e.name))) return null;
  const kinds = [...new Set(f.contents.map((e) => describe(e.name)).filter(Boolean))];
  return `archive of ${kinds.length ? kinds.join(" and ") : "files Corpus cannot read"}`;
}

/** GEO also serves each file of a series' RAW archive on its own, under its sample. */
function sampleUrl(name: string): string | null {
  const gsm = name.match(/^GSM\d+/)?.[0];
  return gsm ? `https://ftp.ncbi.nlm.nih.gov/geo/samples/${geoStub(gsm)}/${gsm}/suppl/${encodeURIComponent(name)}` : null;
}

/** An archive whose files can be fetched one at a time, so you pick which ones to keep. */
const pickable = (f: RemoteFile) => ARCHIVE.test(f.name) && !!f.contents?.length && f.contents.every((e) => sampleUrl(e.name));

const decode = (name: string, bytes: Uint8Array) => new TextDecoder().decode(/\.gz$/i.test(name) ? gunzipSync(bytes) : bytes);

/** Remote files that download into app storage and open in the Data tab: tables, GEO series
 *  matrices (with sample annotations and gene symbols) and archives of per-sample files. */
export function FileList({ files, owner, title, geo }: { files: RemoteFile[]; owner: string; title: string; geo?: GeoContext }) {
  const [stored, setStored] = useState<Map<string, Download>>(new Map());
  const [progress, setProgress] = useState<Map<string, number | null>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archive, setArchive] = useState<{ file: RemoteFile; path: string; entries: { name: string; size: number }[] } | null>(
    null,
  );

  const [picking, setPicking] = useState<RemoteFile | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickStatus, setPickStatus] = useState<string | null>(null);

  const folder = `files/${owner.replace(/[^\w.-]+/g, "_")}`;
  const pathOf = (f: RemoteFile) => `${folder}/${f.name}`;

  const reload = async () => setStored(new Map((await repo().downloads(owner)).map((d) => [d.name, d])));
  useEffect(() => {
    void reload();
    return onDownloadProgress((p) => setProgress((m) => new Map(m).set(p.id, p.total ? p.received / p.total : null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  /** Labels columns with GEO sample annotations; tables without matching columns are unchanged. */
  const withSamples = async (tables: Table[]): Promise<Table[]> => {
    if (!geo) return tables;
    try {
      const samples = await seriesSamples(geo.accession);
      return tables.map((t) => annotate(t, samples));
    } catch {
      return tables;
    }
  };

  const openMatrix = async (f: RemoteFile, path: string) => {
    const { table, samples } = parseSeriesMatrix(f.name, decode(f.name, await readStored(path)));
    let result = annotate(table, samples);
    // Microarray rows are probe IDs; add gene symbols from the platform's annotation.
    const platform = f.name.match(/GPL\d+/)?.[0] ?? (geo?.platforms.length === 1 ? geo.platforms[0] : undefined);
    if (platform && /_at$|^ILMN_|^A_\d/.test(String(table.rows[0]?.[0] ?? "")))
      result = addSymbols(result, await platformSymbols(platform));
    showLoadedTables(title, [result]);
  };

  const openArchive = async (f: RemoteFile, path: string) => {
    setArchive({ file: f, path, entries: await tarList(path) });
  };

  const open = async (f: RemoteFile) => {
    if (pickable(f) && !stored.has(f.name)) {
      setError(null);
      setPicked(new Set());
      setPicking(f);
      return;
    }
    if (
      !stored.has(f.name) &&
      (f.size ?? 0) > LARGE &&
      !(await ask(`Download ${f.name} (${formatBytes(f.size)}) to this phone?`))
    )
      return;
    setError(null);
    setBusy(f.name);
    const path = pathOf(f);
    try {
      if (!stored.has(f.name)) {
        setProgress((m) => new Map(m).set(path, 0));
        const size = await downloadToStore(f.url, path, path);
        await repo().addDownload({ path, owner_uid: owner, name: f.name, url: f.url, size });
        await reload();
      }
      const size = stored.get(f.name)?.size ?? f.size ?? 0;
      if (f.kind === "matrix") await openMatrix(f, path);
      else if (ARCHIVE.test(f.name)) await openArchive(f, path);
      else if (isTabular(f.name)) {
        if (size > MAX_TABLE_BYTES) throw new Error(`At ${formatBytes(size)} this table is too large to open on a phone.`);
        showLoadedTables(title, await withSamples(readTables(f.name, await readStored(path))));
      } else {
        const kind = describe(f.name);
        setError(`${f.name} is saved on this phone, but Corpus cannot read ${kind ?? "this kind of file"}.`);
      }
    } catch (e) {
      setError(`${f.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
      setProgress((m) => {
        const next = new Map(m);
        next.delete(path);
        return next;
      });
    }
  };

  const combine = async () => {
    if (!archive) return;
    const tables = archive.entries.filter((e) => isTabular(e.name) && !ARCHIVE.test(e.name));
    setBusy(archive.file.name);
    setError(null);
    try {
      const into = `${archive.path}.d`;
      const extracted = await tarExtract(
        archive.path,
        tables.map((e) => e.name),
        into,
      );
      const contents = await Promise.all(
        extracted.map(async (p) => ({ name: p.split("/").pop()!, text: decode(p, await readStored(p)) })),
      );
      await removeStored(into);
      const merged = mergeSampleFiles(`${archive.file.name} (${contents.length} samples)`, contents);
      setArchive(null);
      showLoadedTables(title, await withSamples([merged]));
    } catch (e) {
      setError(`${archive.file.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (f: RemoteFile) => {
    if (!(await ask(`Remove ${f.name} from this phone?`))) return;
    await removeStored(pathOf(f));
    await repo().removeDownload(pathOf(f));
    await reload();
  };

  if (picking) {
    const entryPath = (name: string) => `${folder}/${picking.name}.files/${name}`;
    const entryKey = (name: string) => `${picking.name}/${name}`;
    const entries = picking.contents!;
    const readable = (name: string) => isTabular(name) && !ARCHIVE.test(name);
    const chosen = entries.filter((e) => picked.has(e.name));
    const missing = chosen.filter((e) => !stored.has(entryKey(e.name)));
    const missingBytes = missing.reduce((n, e) => n + e.size, 0);
    const onPhone = chosen.filter((e) => stored.has(entryKey(e.name)));
    const toggle = (name: string) =>
      setPicked((s) => {
        const next = new Set(s);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });

    /** Downloads the chosen files that are not on the phone yet. False when you decline. */
    const fetchChosen = async () => {
      if (missingBytes > LARGE && !(await ask(`Download ${missing.length} files (${formatBytes(missingBytes)}) to this phone?`)))
        return false;
      for (const [i, e] of missing.entries()) {
        setPickStatus(`Downloading ${i + 1} of ${missing.length}: ${e.name}`);
        const path = entryPath(e.name);
        const url = sampleUrl(e.name)!;
        const size = await downloadToStore(url, path, path);
        await repo().addDownload({ path, owner_uid: owner, name: entryKey(e.name), url, size });
      }
      await reload();
      return true;
    };

    const run = async (task: () => Promise<void>) => {
      setBusy(picking.name);
      setError(null);
      try {
        await task();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(null);
        setPickStatus(null);
      }
    };

    const keep = () => run(async () => void (await fetchChosen()));
    const view = () =>
      run(async () => {
        if (!(await fetchChosen())) return;
        setPickStatus("Opening…");
        const contents = await Promise.all(
          chosen.map(async (e) => ({ name: e.name, bytes: await readStored(entryPath(e.name)) })),
        );
        const tables =
          contents.length === 1
            ? readTables(contents[0].name, contents[0].bytes)
            : [
                mergeSampleFiles(
                  `${picking.name} (${contents.length} samples)`,
                  contents.map((c) => ({ name: c.name, text: decode(c.name, c.bytes) })),
                ),
              ];
        showLoadedTables(title, await withSamples(tables));
      });
    const removeChosen = () =>
      run(async () => {
        if (!(await ask(`Remove ${onPhone.length} files from this phone?`))) return;
        for (const e of onPhone) {
          await removeStored(entryPath(e.name));
          await repo().removeDownload(entryPath(e.name));
        }
        await reload();
      });

    const allTables = entries.filter((e) => readable(e.name));
    return (
      <div className="card">
        <div className="card-title">{picking.name}</div>
        <p className="muted small">
          {entries.length} files, {allTables.length} of them tables. Tick the ones you want: each downloads on its own, so you
          never fetch the whole {formatBytes(picking.size)} archive.
        </p>
        <div className="row">
          <button className="button small" onClick={() => setPicked(new Set(allTables.map((e) => e.name)))}>
            All tables
          </button>
          <button className="button small" onClick={() => setPicked(new Set())}>
            None
          </button>
          <button
            className="button small"
            onClick={() => setPicked(new Set(entries.filter((e) => stored.has(entryKey(e.name))).map((e) => e.name)))}
          >
            On phone
          </button>
        </div>
        <div className="list pick-list">
          {entries.map((e) => {
            const why = readable(e.name) ? null : (describe(e.name) ?? "not a table");
            return (
              <label key={e.name} className={`item pick-item ${why ? "disabled" : ""}`}>
                <input
                  type="checkbox"
                  disabled={!!why || busy !== null}
                  checked={picked.has(e.name)}
                  onChange={() => toggle(e.name)}
                />
                <span className="item-main">
                  <span className="item-title">{e.name}</span>
                  <div className="item-meta">
                    {formatBytes(e.size)}
                    {stored.has(entryKey(e.name)) ? " · on phone" : why ? ` · ${why}` : ""}
                  </div>
                </span>
              </label>
            );
          })}
        </div>
        {pickStatus && <div className="status">{pickStatus}</div>}
        {error && <div className="status error">{error}</div>}
        <div className="row">
          <button className="button primary" disabled={!chosen.length || busy !== null} onClick={view}>
            {chosen.length > 1 ? `Combine ${chosen.length} into one table` : "Open"}
          </button>
          <button className="button" disabled={!missing.length || busy !== null} onClick={keep}>
            Keep on phone{missing.length ? ` (${missing.length}, ${formatBytes(missingBytes)})` : ""}
          </button>
          {onPhone.length > 0 && (
            <button className="button" disabled={busy !== null} onClick={removeChosen}>
              Remove {onPhone.length} from phone
            </button>
          )}
          <button className="button small" disabled={busy !== null} onClick={() => setPicking(null)}>
            Back to files
          </button>
        </div>
      </div>
    );
  }

  if (archive) {
    const tables = archive.entries.filter((e) => isTabular(e.name) && !ARCHIVE.test(e.name));
    const others = archive.entries.length - tables.length;
    const kinds = [...new Set(archive.entries.map((e) => describe(e.name)).filter(Boolean))];
    return (
      <div className="card">
        <div className="card-title">{archive.file.name}</div>
        <p className="muted small">
          {archive.entries.length} files inside. {tables.length ? `${tables.length} are tables` : "None are tables"}
          {others ? `; ${others} are ${kinds.length ? kinds.join(", ") : "other files"}` : ""}.
        </p>
        {tables.length > 0 && (
          <button className="button primary" disabled={busy !== null} onClick={combine}>
            {busy ? "Combining…" : `Combine ${tables.length} per-sample files into one table`}
          </button>
        )}
        {!tables.length && kinds.includes("raw Affymetrix scans") && (
          <p className="muted small">The series matrix holds the processed values for these arrays.</p>
        )}
        {error && <div className="status error">{error}</div>}
        <div className="row">
          <button className="button small" onClick={() => setArchive(null)}>
            Back to files
          </button>
        </div>
      </div>
    );
  }

  const kept = (f: RemoteFile) => [...stored.keys()].filter((k) => k.startsWith(`${f.name}/`)).length;

  return (
    <>
      <div className="list">
        {files.map((f) => {
          const have = stored.get(f.name);
          const p = progress.get(pathOf(f));
          const why = unreadable(f);
          const tables = f.contents?.filter((e) => isTabular(e.name) && !ARCHIVE.test(e.name)).length;
          const action =
            busy === f.name
              ? p === undefined
                ? "Opening…"
                : `Downloading${p === null ? "…" : ` ${Math.round(p * 100)}%`}`
              : f.kind === "matrix"
                ? "Series matrix: processed values with sample annotations"
                : why
                  ? `${why[0].toUpperCase()}${why.slice(1)}: not downloaded, Corpus cannot read it`
                  : ARCHIVE.test(f.name)
                    ? tables && pickable(f)
                      ? `Archive of ${tables} per-sample tables: pick which to download${kept(f) ? ` (${kept(f)} on phone)` : ""}`
                      : tables
                        ? `Archive of ${tables} per-sample tables`
                        : "Archive: per-sample files"
                    : "Table";
          return (
            <div key={f.url} className="item file-item">
              <button className="file-main" disabled={busy !== null || (!!why && !have)} onClick={() => open(f)}>
                <span className="item-title">{f.name}</span>
                <div className="item-meta">{action}</div>
                {busy === f.name && p !== undefined && (
                  <div className="progress">
                    <div style={{ width: `${Math.round((p ?? 0.05) * 100)}%` }} />
                  </div>
                )}
              </button>
              <span className="item-side">
                {formatBytes(have?.size ?? f.size)}
                <br />
                {have ? (
                  <button className="link-button" onClick={() => remove(f)}>
                    On phone · remove
                  </button>
                ) : why ? (
                  <button className="link-button" onClick={() => openExternal(f.url)}>
                    Browser
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {!IN_APP && <p className="muted small">In a browser, downloads last for this session only.</p>}
      {error && <div className="status error">{error}</div>}
    </>
  );
}
