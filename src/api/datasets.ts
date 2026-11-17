import { http } from "../platform";
import { eutilsJson } from "./ncbi";

export interface DatasetSummary {
  source: string;
  accession: string;
  title: string;
  summary: string;
  organism: string;
  kind: string;
  samples: number | null;
  url: string;
  pmid: string | null;
  /** Page views recorded by OmicsDI, when it came from there. */
  views: number | null;
}

interface GdsDoc {
  accession: string;
  title: string;
  summary: string;
  taxon: string;
  gdstype: string;
  n_samples: number;
  entrytype?: string;
  pubmedids?: string[];
}

const fromGds = (d: GdsDoc): DatasetSummary => ({
  source: "GEO",
  accession: d.accession,
  title: d.title,
  summary: d.summary,
  organism: d.taxon,
  kind: d.gdstype,
  samples: d.n_samples ?? null,
  url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${d.accession}`,
  pmid: d.pubmedids?.[0] ?? null,
  views: null,
});

const linked = new Map<string, DatasetSummary[]>();

/** GEO series linked to each paper, from NCBI's PubMed-to-GEO links. Papers without a series
 *  map to an empty list. Results are kept for the session. */
export async function linkedDatasets(pmids: string[]): Promise<Map<string, DatasetSummary[]>> {
  const todo = [...new Set(pmids)].filter((p) => !linked.has(p));
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200);
    // Asking per paper is slow (about 0.1 s each), so ask for the union of links, then map each
    // series back to its papers through the PubMed ids in its summary.
    const res = await eutilsJson<{ linksets: { linksetdbs?: { links: string[] }[] }[] }>("elink", {
      dbfrom: "pubmed",
      db: "gds",
      linkname: "pubmed_gds",
      id: batch.join(","),
    });
    const ids = res.linksets[0]?.linksetdbs?.[0]?.links ?? [];
    const found = new Map<string, DatasetSummary[]>(batch.map((p) => [p, []]));
    for (let j = 0; j < ids.length; j += 200) {
      const { result } = await eutilsJson<{ result: Record<string, GdsDoc> }>("esummary", {
        db: "gds",
        id: ids.slice(j, j + 200).join(","),
      });
      // Links also reach curated GDS records and platforms; only series have files.
      for (const id of ids.slice(j, j + 200)) {
        const doc = result[id];
        if (!doc?.accession?.startsWith("GSE")) continue;
        for (const p of doc.pubmedids ?? []) found.get(String(p))?.push(fromGds(doc));
      }
    }
    found.forEach((d, p) => linked.set(p, d));
  }
  return new Map(pmids.map((p) => [p, linked.get(p) ?? []]));
}

export interface DatasetPage {
  count: number;
  datasets: DatasetSummary[];
}

/** GEO series matching a query, largest studies first when `bySize` is set. */
export async function searchGeo(term: string, start = 0, max = 20): Promise<DatasetPage> {
  const search = await eutilsJson<{ esearchresult: { count: string; idlist: string[] } }>("esearch", {
    db: "gds",
    term: `(${term}) AND gse[ETYP]`,
    retstart: start,
    retmax: max,
  });
  const ids = search.esearchresult.idlist ?? [];
  if (!ids.length) return { count: 0, datasets: [] };
  const { result } = await eutilsJson<{ result: Record<string, GdsDoc> }>("esummary", { db: "gds", id: ids.join(",") });
  const datasets = ids
    .map((id) => result[id])
    .filter((d) => d?.accession)
    .map(fromGds);
  return { count: Number(search.esearchresult.count), datasets };
}

interface OmicsDiDataset {
  id: string;
  source: string;
  title: string;
  description: string | null;
  omicsType: string[] | null;
  viewsCount: number;
}

/** The datasets people open most across the repositories OmicsDI indexes. */
export async function mostAccessed(size = 30): Promise<DatasetSummary[]> {
  const data = await (await http(`https://www.omicsdi.org/ws/dataset/mostAccessed?size=${size}`)).json();
  return (data.datasets as OmicsDiDataset[]).map((d) => ({
    source: d.source,
    accession: d.id,
    title: d.title,
    summary: d.description ?? "",
    organism: "",
    kind: d.omicsType?.join(", ") ?? "",
    samples: null,
    url: `https://www.omicsdi.org/dataset/${d.source}/${d.id}`,
    pmid: null,
    views: d.viewsCount,
  }));
}
