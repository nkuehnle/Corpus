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
  pubmedids?: string[];
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
    .map((d) => ({
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
    }));
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
