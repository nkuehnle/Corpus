import { http } from "../platform";

/** Citation counts by PMID, from Europe PMC (PubMed itself doesn't report them). */
export async function citationCounts(pmids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!pmids.length) return counts;
  const query = `(${pmids.map((p) => `EXT_ID:${p}`).join(" OR ")}) AND SRC:MED`;
  const url =
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=lite" +
    `&pageSize=${pmids.length}&query=${encodeURIComponent(query)}`;
  const data = await (await http(url)).json();
  for (const r of data.resultList?.result ?? []) counts.set(r.pmid, r.citedByCount ?? 0);
  return counts;
}
