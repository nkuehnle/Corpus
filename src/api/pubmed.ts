import { eutils, eutilsJson } from "./ncbi";

export interface PaperSummary {
  pmid: string;
  pmcid: string | null;
  doi: string | null;
  title: string;
  authors: string;
  journal: string;
  /** As PubMed prints it, e.g. "2024 Mar 12". */
  pubDate: string;
}

export type PubmedSort = "relevance" | "pub_date";

export interface SearchPage {
  count: number;
  pmids: string[];
}

interface ESearch {
  esearchresult: { count: string; idlist: string[]; ERROR?: string };
}

export async function searchPubmed(
  term: string,
  opts: { start?: number; max?: number; sort?: PubmedSort; enteredSince?: string } = {},
): Promise<SearchPage> {
  const params: Record<string, string | number> = {
    db: "pubmed",
    term,
    retstart: opts.start ?? 0,
    retmax: opts.max ?? 20,
    sort: opts.sort ?? "relevance",
  };
  if (opts.enteredSince) {
    // Entrez date: when the record was added to PubMed, which is what "new" means for an alert.
    params.datetype = "edat";
    params.mindate = opts.enteredSince.replace(/-/g, "/");
    params.maxdate = "3000";
  }
  const { esearchresult: r } = await eutilsJson<ESearch>("esearch", params);
  if (r.ERROR) throw new Error(r.ERROR);
  return { count: Number(r.count), pmids: r.idlist ?? [] };
}

interface ESummaryDoc {
  uid: string;
  title?: string;
  authors?: { name: string }[];
  source?: string;
  fulljournalname?: string;
  pubdate?: string;
  articleids?: { idtype: string; value: string }[];
  error?: string;
}

export function authorLine(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names[0]}, ${names[1]} … ${names[names.length - 1]}`;
}

/** Summaries in the same order as `pmids`; ids PubMed doesn't know are dropped. */
export async function summarize(pmids: string[]): Promise<PaperSummary[]> {
  if (!pmids.length) return [];
  const { result } = await eutilsJson<{ result: Record<string, ESummaryDoc> }>("esummary", {
    db: "pubmed",
    id: pmids.join(","),
  });
  const out: PaperSummary[] = [];
  for (const pmid of pmids) {
    const d = result?.[pmid];
    if (!d || d.error || !d.title) continue;
    const id = (type: string) => d.articleids?.find((a) => a.idtype === type)?.value ?? null;
    out.push({
      pmid,
      pmcid: id("pmc"),
      doi: id("doi"),
      title: decodeEntities(d.title),
      authors: authorLine((d.authors ?? []).map((a) => a.name)),
      journal: d.source || d.fulljournalname || "",
      pubDate: d.pubdate ?? "",
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;\/?[a-z]+&gt;/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

/** Pulls the abstract out of an efetch XML record; labelled sections become paragraphs. */
export function parseAbstract(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const parts = [...doc.querySelectorAll("Abstract > AbstractText")].map((el) => {
    const label = el.getAttribute("Label");
    const text = (el.textContent ?? "").trim();
    return label ? `**${label}.** ${text}` : text;
  });
  return parts.join("\n\n");
}

export async function fetchAbstract(pmid: string): Promise<string> {
  const res = await eutils("efetch", { db: "pubmed", id: pmid, rettype: "abstract", retmode: "xml" });
  return parseAbstract(await res.text());
}
