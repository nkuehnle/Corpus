import { useEffect, useState } from "react";
import { mostAccessed, searchGeo, type DatasetSummary } from "../api/datasets";
import { seriesFiles, type Series } from "../api/geo";
import { FileList } from "../components/FileList";
import { Await, Back, Icon, Notes, Segmented, ask, errorText } from "../components/ui";
import { datasetUid, type Dataset } from "../db/repo";
import { openExternal } from "../platform";
import { cache, navigate, repo, useLoad } from "../store";

const PAGE = 20;
const last: { query: string; count: number; results: DatasetSummary[] } = { query: "", count: 0, results: [] };

function open(d: DatasetSummary) {
  const uid = datasetUid(d);
  cache.datasets.set(uid, d);
  navigate(`/dataset/${encodeURIComponent(uid)}`);
}

export function DatasetRow({ d, starred }: { d: DatasetSummary; starred?: boolean }) {
  return (
    <button className="item" onClick={() => open(d)}>
      <span className="item-main">
        <span className="item-title">{d.title}</span>
        <div className="item-meta">{[d.source, d.accession, d.organism, d.kind].filter(Boolean).join(" · ")}</div>
      </span>
      <span className="item-side">
        {d.samples != null && `${d.samples} samples`}
        {d.views != null && `${d.views.toLocaleString()} views`}
        {starred && <div>★</div>}
      </span>
    </button>
  );
}

function SearchTab() {
  const [query, setQuery] = useState(last.query);
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (fresh: boolean) => {
    const term = query.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      if (fresh) Object.assign(last, { query: term, count: 0, results: [] });
      const page = await searchGeo(term, last.results.length, PAGE);
      last.count = page.count;
      last.results = [...last.results, ...page.datasets];
      redraw((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void load(true);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GEO, e.g. resistance exercise skeletal muscle"
          enterKeyHint="search"
        />
        <button className="button primary" disabled={busy || !query.trim()} aria-label="Search">
          <Icon name="search" />
        </button>
      </form>
      {error && <div className="status error">{error}</div>}
      {busy && !last.results.length && <div className="status">Searching…</div>}
      {last.results.length > 0 && (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {last.count.toLocaleString()} series in the Gene Expression Omnibus
          </div>
          <div className="list">
            {last.results.map((d) => (
              <DatasetRow key={d.accession} d={d} />
            ))}
          </div>
          {last.results.length < last.count && (
            <button className="button" disabled={busy} onClick={() => load(false)}>
              {busy ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
      {!busy && !error && last.query && !last.results.length && <div className="status">No results.</div>}
    </>
  );
}

let popular: DatasetSummary[] | null = null;

function PopularTab() {
  const data = useLoad(async () => (popular ??= (await mostAccessed(40)).filter((d) => d.source && d.title)), []);
  return (
    <>
      <p className="muted small">The most-viewed datasets across the repositories indexed by OmicsDI, all fields of biology.</p>
      <Await of={data}>
        {(list) => (
          <div className="list">
            {list.map((d) => (
              <DatasetRow key={d.source + d.accession} d={d} />
            ))}
          </div>
        )}
      </Await>
    </>
  );
}

export function toSummary(d: Dataset): DatasetSummary {
  return { ...d, samples: d.n_samples, views: null };
}

function SavedTab() {
  const data = useLoad(() => repo().datasets(), []);
  const [filter, setFilter] = useState<"all" | "starred">("all");
  return (
    <Await of={data}>
      {(list) =>
        list.length === 0 ? (
          <div className="status">Datasets you save show up here.</div>
        ) : (
          <>
            <Segmented
              value={filter}
              options={[
                { value: "all", label: `All ${list.length}` },
                { value: "starred", label: "Starred" },
              ]}
              onChange={setFilter}
            />
            {filter === "starred" && !list.some((d) => d.starred) && <div className="status">Nothing starred yet.</div>}
            <div className="list">
              {list
                .filter((d) => filter === "all" || d.starred)
                .map((d) => (
                  <DatasetRow key={d.uid} d={toSummary(d)} starred={!!d.starred} />
                ))}
            </div>
          </>
        )
      }
    </Await>
  );
}

export function DatasetsPage({ tab }: { tab: string }) {
  const current = tab === "search" || tab === "popular" ? tab : "saved";
  return (
    <div className="page">
      <h1 className="page-title">Datasets</h1>
      <Segmented
        value={current}
        options={[
          { value: "saved", label: "Saved" },
          { value: "search", label: "Search GEO" },
          { value: "popular", label: "Most viewed" },
        ]}
        onChange={(t) => navigate(`/datasets/${t}`)}
      />
      {current === "search" ? <SearchTab /> : current === "popular" ? <PopularTab /> : <SavedTab />}
    </div>
  );
}

export function DatasetPage({ uid }: { uid: string }) {
  const data = useLoad(async () => {
    const saved = await repo().dataset(uid);
    const summary = saved ? toSummary(saved) : cache.datasets.get(uid);
    if (!summary) throw new Error("Open this dataset from a search to see it.");
    return { saved, summary };
  }, [uid]);
  const [series, setSeries] = useState<Series | string | null>(null);

  const accession = data.data?.summary.accession;
  const isGeoSeries = data.data?.summary.source === "GEO" && /^GSE\d+$/.test(accession ?? "");
  useEffect(() => {
    if (!isGeoSeries) return;
    seriesFiles(accession!).then(setSeries, (e: unknown) => setSeries(errorText(e)));
  }, [accession, isGeoSeries]);

  return (
    <div className="page">
      <Back label="Back" />
      <Await of={data}>
        {({ saved, summary: d }) => (
          <>
            <h1 className="page-title" style={{ fontSize: "1.3rem" }}>
              {d.title}
            </h1>
            <dl className="facts">
              <dt>Source</dt>
              <dd>
                {d.source} {d.accession}
              </dd>
              {d.organism && (
                <>
                  <dt>Organism</dt>
                  <dd>{d.organism}</dd>
                </>
              )}
              {d.kind && (
                <>
                  <dt>Type</dt>
                  <dd>{d.kind}</dd>
                </>
              )}
              {d.samples != null && (
                <>
                  <dt>Samples</dt>
                  <dd>{d.samples}</dd>
                </>
              )}
            </dl>
            <div className="row" style={{ marginBottom: 12 }}>
              {saved && (
                <button
                  className={`icon-btn ${saved.starred ? "on" : ""}`}
                  aria-label={saved.starred ? "Remove star" : "Star"}
                  onClick={async () => {
                    await repo().updateDataset(uid, { starred: saved.starred ? 0 : 1 });
                    data.reload();
                  }}
                >
                  <span style={{ fontSize: "1.4rem" }}>{saved.starred ? "★" : "☆"}</span>
                </button>
              )}
              {!saved && (
                <button
                  className="button primary"
                  onClick={async () => {
                    await repo().saveDataset(d);
                    data.reload();
                  }}
                >
                  Save dataset
                </button>
              )}
              {d.url && (
                <button className="button" onClick={() => openExternal(d.url)}>
                  Open at {d.source}
                </button>
              )}
              {d.pmid && (
                <button className="button" onClick={() => navigate(`/paper/${d.pmid}`)}>
                  Paper
                </button>
              )}
            </div>
            {isGeoSeries && (
              <>
                <h2 className="section-title" style={{ marginTop: 20 }}>
                  Files
                </h2>
                {series === null ? (
                  <div className="status">Looking…</div>
                ) : typeof series === "string" ? (
                  <div className="status error">{series}</div>
                ) : series.files.length === 0 ? (
                  <p className="muted">This series has no supplementary files.</p>
                ) : (
                  <FileList
                    files={series.files}
                    owner={uid}
                    title={`${d.accession} · ${d.title}`}
                    geo={{ accession: d.accession, platforms: series.platforms }}
                  />
                )}
              </>
            )}

            {d.summary && (
              <>
                <h2 className="section-title" style={{ marginTop: 20 }}>
                  About
                </h2>
                <p>{d.summary}</p>
              </>
            )}

            {saved && (
              <>
                <h2 className="section-title" style={{ marginTop: 20 }}>
                  Your notes
                </h2>
                <Notes
                  value={saved.notes}
                  placeholder="What it measures, how you might use it"
                  onSave={(notes) => repo().updateDataset(uid, { notes })}
                />
                <div className="row">
                  <button
                    className="button small"
                    onClick={async () => {
                      if (!(await ask("Remove this dataset and your notes on it?"))) return;
                      await repo().removeDataset(uid);
                      cache.datasets.set(uid, d);
                      data.reload();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Await>
    </div>
  );
}
