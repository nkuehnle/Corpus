import { useEffect, useState } from "react";
import { checkSearch, ensureNotificationPermission, publishAlertPlan } from "../alerts";
import { citationCounts } from "../api/europepmc";
import { fetchAbstract, searchPubmed, summarize, type PaperSummary, type PubmedSort } from "../api/pubmed";
import { paperSupplements, type RemoteFile } from "../api/supplements";
import { FileList } from "../components/FileList";
import { Await, Back, Icon, Markdown, Modal, Notes, Segmented, ask, errorText } from "../components/ui";
import { paperUid, today, type Paper, type PaperStatus } from "../db/repo";
import { openExternal } from "../platform";
import { cache, navigate, repo, useLoad } from "../store";

const PAGE = 20;

/** The last search, kept so coming back from a paper shows the same results. */
const last: { query: string; sort: PubmedSort; count: number; results: PaperSummary[]; cited: Map<string, number> } = {
  query: "",
  sort: "relevance",
  count: 0,
  results: [],
  cited: new Map(),
};

export function runSearch(query: string) {
  Object.assign(last, { query, count: 0, results: [], cited: new Map() });
  navigate("/papers/search");
}

function PaperRow({ p, cited, unseen }: { p: PaperSummary; cited?: number; unseen?: boolean }) {
  return (
    <button
      className={`item ${unseen ? "unseen" : ""}`}
      onClick={() => {
        cache.papers.set(p.pmid, p);
        navigate(`/paper/${p.pmid}`);
      }}
    >
      <span className="item-main">
        <span className="item-title">{p.title}</span>
        <div className="item-meta">{p.authors}</div>
        <div className="item-meta">
          {p.journal} · {p.pubDate}
          {cited ? ` · cited ${cited}×` : ""}
        </div>
      </span>
    </button>
  );
}

function SearchTab() {
  const [query, setQuery] = useState(last.query);
  const [sort, setSort] = useState(last.sort);
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async (fresh: boolean, withSort = sort) => {
    const term = query.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      if (fresh) Object.assign(last, { query: term, sort: withSort, count: 0, results: [], cited: new Map() });
      const page = await searchPubmed(term, { start: last.results.length, max: PAGE, sort: withSort });
      const papers = await summarize(page.pmids);
      last.count = page.count;
      last.results = [...last.results, ...papers];
      redraw((n) => n + 1);
      // Citation counts are a nicety from a second service; the list is fine without them.
      citationCounts(page.pmids).then(
        (counts) => {
          counts.forEach((v, k) => last.cited.set(k, v));
          redraw((n) => n + 1);
        },
        () => {},
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // A search handed over from a lesson or an alert arrives with a query but no results yet.
  useEffect(() => {
    if (last.query && !last.results.length) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          placeholder="Search PubMed, e.g. mTORC1 AND hypertrophy"
          enterKeyHint="search"
        />
        <button className="button primary" disabled={busy || !query.trim()} aria-label="Search">
          <Icon name="search" />
        </button>
      </form>
      <div className="row" style={{ marginTop: 0, marginBottom: 12 }}>
        <Segmented
          value={sort}
          options={[
            { value: "relevance", label: "Best match" },
            { value: "pub_date", label: "Newest" },
          ]}
          onChange={(s) => {
            setSort(s);
            void load(true, s);
          }}
        />
      </div>
      {error && <div className="status error">{error}</div>}
      {last.results.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: "space-between", margin: "0 0 8px" }}>
            <span className="muted small">{last.count.toLocaleString()} results</span>
            <button className="button small" onClick={() => setSaving(true)}>
              <Icon name="bell" />
              &nbsp;Alert me to new papers
            </button>
          </div>
          <div className="list">
            {last.results.map((p) => (
              <PaperRow key={p.pmid} p={p} cited={last.cited.get(p.pmid)} />
            ))}
          </div>
          {last.results.length < last.count && (
            <button className="button" disabled={busy} onClick={() => load(false)}>
              {busy ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
      {busy && !last.results.length && <div className="status">Searching…</div>}
      {!busy && !error && last.query && last.results.length === 0 && last.count === 0 && (
        <div className="status">No results.</div>
      )}
      {saving && <SaveSearch query={last.query} onClose={() => setSaving(false)} />}
    </>
  );
}

function SaveSearch({ query, onClose }: { query: string; onClose: () => void }) {
  const [name, setName] = useState(query);
  return (
    <Modal title="New alert" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const uid = await repo().addSearch(name.trim(), query);
          await ensureNotificationPermission();
          await publishAlertPlan(repo());
          navigate(`/alert/${encodeURIComponent(uid)}`);
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          Corpus will check PubMed for papers matching <strong>{query}</strong> and tell you when new ones are added.
        </p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <button className="button primary" disabled={!name.trim()}>
          Create alert
        </button>
      </form>
    </Modal>
  );
}

const STATUS_LABEL: Record<PaperStatus, string> = { unread: "To read", reading: "Reading", read: "Read" };

function LibraryTab() {
  const papers = useLoad(() => repo().papers(), []);
  const [filter, setFilter] = useState<"all" | "starred" | PaperStatus>("all");
  return (
    <Await of={papers}>
      {(all) => {
        if (!all.length) return <div className="status">Papers you save show up here.</div>;
        const shown = all.filter((p) => filter === "all" || (filter === "starred" ? p.starred : p.status === filter));
        return (
          <>
            <Segmented
              value={filter}
              options={[
                { value: "all", label: `All ${all.length}` },
                { value: "unread", label: "To read" },
                { value: "reading", label: "Reading" },
                { value: "read", label: "Read" },
                { value: "starred", label: "Starred" },
              ]}
              onChange={setFilter}
            />
            {shown.length === 0 && <div className="status">Nothing here.</div>}
            <div className="list">
              {shown.map((p) => (
                <button key={p.uid} className="item" onClick={() => navigate(`/paper/${p.pmid}`)}>
                  <span className="item-main">
                    <span className="item-title">{p.title}</span>
                    <div className="item-meta">{p.authors}</div>
                    <div className="item-meta">
                      {p.journal} · {p.pub_date} · {STATUS_LABEL[p.status]}
                    </div>
                  </span>
                  {p.starred ? <span className="item-side">★</span> : null}
                </button>
              ))}
            </div>
          </>
        );
      }}
    </Await>
  );
}

function AlertsTab() {
  const searches = useLoad(() => repo().searches(), []);
  return (
    <Await of={searches}>
      {(list) =>
        list.length === 0 ? (
          <div className="status">Run a search, then tap “Alert me to new papers” to follow it.</div>
        ) : (
          <>
            {list.some((s) => !s.notify) && (
              <div className="card">
                <div className="muted small">
                  {list.filter((s) => !s.notify).length} of these are saved searches with alerts off. Turn alerts on to be
                  notified when PubMed adds matching papers.
                </div>
                <div className="row">
                  <button
                    className="button primary"
                    onClick={async () => {
                      await repo().followAllSearches();
                      await ensureNotificationPermission();
                      await publishAlertPlan(repo());
                      searches.reload();
                    }}
                  >
                    Turn on alerts for all
                  </button>
                </div>
              </div>
            )}
            <div className="list">
              {list.map((s) => (
                <button key={s.uid} className="item" onClick={() => navigate(`/alert/${encodeURIComponent(s.uid)}`)}>
                  <span className="item-main">
                    <span className="item-title">{s.name}</span>
                    <div className="item-meta">{s.query}</div>
                    <div className="item-meta">
                      {s.notify ? `Alerts on · checked ${s.last_checked ?? "never"}` : "Alerts off"}
                    </div>
                  </span>
                  {s.unseen > 0 && <span className="badge inline">{s.unseen}</span>}
                </button>
              ))}
            </div>
          </>
        )
      }
    </Await>
  );
}

export function PapersPage({ tab }: { tab: string }) {
  const current = tab === "library" || tab === "alerts" ? tab : "search";
  return (
    <div className="page">
      <h1 className="page-title">Papers</h1>
      <Segmented
        value={current}
        options={[
          { value: "search", label: "Search" },
          { value: "library", label: "Library" },
          { value: "alerts", label: "Alerts" },
        ]}
        onChange={(t) => navigate(`/papers/${t}`)}
      />
      {current === "search" ? <SearchTab /> : current === "library" ? <LibraryTab /> : <AlertsTab />}
    </div>
  );
}

export function AlertPage({ uid }: { uid: string }) {
  const data = useLoad(async () => {
    const search = await repo().search(uid);
    const hits = await repo().hits(uid);
    await repo().markHitsSeen(uid);
    return { search, hits };
  }, [uid]);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="page">
      <Back label="Back" />
      <Await of={data}>
        {({ search, hits }) => {
          if (!search) return <div className="status">This alert is no longer here.</div>;
          const setNotify = async (on: boolean) => {
            // Turning alerts on starts from today rather than flooding you with the back catalogue.
            await repo().updateSearch(uid, on ? { notify: 1, last_checked: today() } : { notify: 0 });
            if (on) await ensureNotificationPermission();
            await publishAlertPlan(repo());
            data.reload();
          };
          const check = async () => {
            setStatus("Checking PubMed…");
            try {
              const n = await checkSearch(repo(), search);
              setStatus(n ? `${n} new` : "Nothing new since the last check.");
              data.reload();
            } catch (e) {
              setStatus(errorText(e));
            }
          };
          return (
            <>
              <h1 className="page-title">{search.name}</h1>
              <p className="muted" style={{ marginTop: -8 }}>
                {search.query}
              </p>
              <div className="card">
                <label className="toggle">
                  <span>
                    Alert me to new papers
                    <div className="muted small">
                      {search.notify ? `Last checked ${search.last_checked ?? "never"}` : "Off: this is only a saved search"}
                    </div>
                  </span>
                  <input type="checkbox" checked={!!search.notify} onChange={(e) => setNotify(e.target.checked)} />
                </label>
                <div className="row">
                  <button className="button primary" onClick={() => runSearch(search.query)}>
                    Search PubMed now
                  </button>
                  {!!search.notify && (
                    <button className="button" onClick={check}>
                      Check for new
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    aria-label="Delete alert"
                    onClick={async () => {
                      if (!(await ask(`Delete “${search.name}”?`))) return;
                      await repo().removeSearch(uid);
                      await publishAlertPlan(repo());
                      navigate("/papers/alerts");
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
                {status && (
                  <div className="muted small" style={{ marginTop: 8 }}>
                    {status}
                  </div>
                )}
              </div>
              {hits.length > 0 ? (
                <>
                  <h2 className="section-title">New since you started following</h2>
                  <div className="list">
                    {hits.map((h) => (
                      <PaperRow
                        key={h.pmid}
                        unseen={!h.seen}
                        p={{
                          pmid: h.pmid,
                          pmcid: null,
                          doi: null,
                          title: h.title,
                          authors: h.authors,
                          journal: h.journal,
                          pubDate: h.pub_date,
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                !!search.notify && <div className="status">No new papers yet. They'll be listed here as PubMed adds them.</div>
              )}
            </>
          );
        }}
      </Await>
    </div>
  );
}

function toSummary(p: Paper): PaperSummary {
  return {
    pmid: p.pmid!,
    pmcid: p.pmcid,
    doi: p.doi,
    title: p.title,
    authors: p.authors,
    journal: p.journal,
    pubDate: p.pub_date,
  };
}

export function PaperPage({ pmid }: { pmid: string }) {
  const uid = paperUid(pmid);
  const data = useLoad(async () => {
    const saved = await repo().paper(uid);
    // Rows from an alert carry no PMC id or DOI, so anything unsaved is looked up in full.
    const cached = cache.papers.get(pmid);
    const summary = saved ? toSummary(saved) : cached?.doi || cached?.pmcid ? cached : (await summarize([pmid]))[0];
    if (!summary) throw new Error(`PubMed has no record ${pmid}.`);
    return { saved, summary };
  }, [pmid]);
  const [abstract, setAbstract] = useState<string | null>(null);
  const [cited, setCited] = useState<number | null>(null);
  const [files, setFiles] = useState<RemoteFile[] | "loading" | string | null>(null);

  const saved = data.data?.saved ?? null;
  useEffect(() => {
    if (!data.data) return;
    if (data.data.saved?.abstract != null) setAbstract(data.data.saved.abstract);
    else
      fetchAbstract(pmid).then(
        (text) => {
          setAbstract(text);
          if (data.data?.saved) void repo().updatePaper(uid, { abstract: text });
        },
        (e) => setAbstract(`*Could not load the abstract: ${errorText(e)}*`),
      );
    citationCounts([pmid]).then(
      (m) => setCited(m.get(pmid) ?? null),
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data?.summary.pmid]);

  return (
    <div className="page">
      <Back label="Back" />
      <Await of={data}>
        {({ summary: p }) => {
          const loadFiles = async () => {
            setFiles("loading");
            try {
              setFiles(await paperSupplements(p.pmcid!));
            } catch (e) {
              setFiles(errorText(e));
            }
          };
          return (
            <>
              <h1 className="page-title" style={{ fontSize: "1.3rem" }}>
                {p.title}
              </h1>
              <p className="muted" style={{ marginTop: -8 }}>
                {p.authors}
                <br />
                {p.journal} · {p.pubDate}
                {cited != null && ` · cited ${cited}×`}
              </p>

              <div className="row" style={{ marginBottom: 12 }}>
                {saved ? (
                  <>
                    <button
                      className={`icon-btn ${saved.starred ? "on" : ""}`}
                      aria-label={saved.starred ? "Remove star" : "Star"}
                      onClick={async () => {
                        await repo().updatePaper(uid, { starred: saved.starred ? 0 : 1 });
                        data.reload();
                      }}
                    >
                      <span style={{ fontSize: "1.4rem" }}>{saved.starred ? "★" : "☆"}</span>
                    </button>
                    <Segmented
                      value={saved.status}
                      options={(Object.keys(STATUS_LABEL) as PaperStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
                      onChange={async (status) => {
                        await repo().updatePaper(uid, { status });
                        data.reload();
                      }}
                    />
                  </>
                ) : (
                  <button
                    className="button primary"
                    onClick={async () => {
                      await repo().savePaper(p, abstract);
                      data.reload();
                    }}
                  >
                    Save to library
                  </button>
                )}
              </div>

              <div className="row" style={{ marginBottom: 12 }}>
                <button className="button small" onClick={() => openExternal(`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`)}>
                  PubMed
                </button>
                {p.pmcid && (
                  <button
                    className="button small"
                    onClick={() => openExternal(`https://pmc.ncbi.nlm.nih.gov/articles/${p.pmcid}/`)}
                  >
                    Free full text
                  </button>
                )}
                {p.doi && (
                  <button className="button small" onClick={() => openExternal(`https://doi.org/${p.doi}`)}>
                    Publisher
                  </button>
                )}
              </div>

              <h2 className="section-title">Abstract</h2>
              {abstract == null ? (
                <div className="status">Loading…</div>
              ) : (
                <Markdown text={abstract || "*PubMed has no abstract for this record.*"} />
              )}

              <h2 className="section-title" style={{ marginTop: 20 }}>
                Supplementary data
              </h2>
              {!p.pmcid ? (
                <p className="muted">
                  Not in PubMed Central, so there are no files Corpus can fetch. Check the publisher's page for supplements.
                </p>
              ) : files === null ? (
                <button className="button" onClick={loadFiles}>
                  Look for supplementary files
                </button>
              ) : files === "loading" ? (
                <div className="status">Looking…</div>
              ) : typeof files === "string" ? (
                <div className="status error">{files}</div>
              ) : files.length === 0 ? (
                <p className="muted">
                  No supplementary files are openly available for this article. Try the free full text page.
                </p>
              ) : (
                <FileList files={files} title={p.title} />
              )}

              {saved && (
                <>
                  <h2 className="section-title" style={{ marginTop: 20 }}>
                    Your notes
                  </h2>
                  <Notes
                    value={saved.notes}
                    placeholder="Key findings, methods worth copying, doubts"
                    onSave={(notes) => repo().updatePaper(uid, { notes })}
                  />
                  <div className="row">
                    <button
                      className="button small"
                      onClick={async () => {
                        if (!(await ask("Remove this paper and your notes on it from the library?"))) return;
                        await repo().removePaper(uid);
                        data.reload();
                      }}
                    >
                      Remove from library
                    </button>
                  </div>
                </>
              )}
            </>
          );
        }}
      </Await>
    </div>
  );
}
