import { http } from "../platform";

export interface RemoteFile {
  name: string;
  url: string;
  /** Bytes, when the server reports it. */
  size: number | null;
}

const BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com";

const unescapeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function parseBucketListing(xml: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const m of xml.matchAll(/<Contents>.*?<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs)) {
    const key = unescapeXml(m[1]);
    files.push({ name: key.split("/").pop()!, url: `${BUCKET}/${encodeURI(key)}`, size: Number(m[2]) });
  }
  return files;
}

const FIGURE = /\.(webp|jpe?g|png|gif|tiff?)$/i;

/** Files deposited with an open-access PMC article, minus the article itself and its figures.
 *  Empty when the article is not in the PMC open-access set. */
export async function paperSupplements(pmcid: string): Promise<RemoteFile[]> {
  const res = await http(`${BUCKET}/?list-type=2&max-keys=500&prefix=${pmcid}.`);
  const files = parseBucketListing(await res.text());
  // The article ships as <PMCID>.<version>.{xml,txt,pdf,json}; everything else is supplementary.
  return files.filter((f) => !f.name.startsWith(`${pmcid}.`) && !FIGURE.test(f.name));
}

function parseSize(text: string): number | null {
  const m = text.match(/^([\d.]+)([KMG]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as "" | "K" | "M" | "G"]);
}

export function parseGeoListing(html: string, base: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  for (const m of html.matchAll(/<a href="([^"/?][^"]*)">[^<]*<\/a>\s+\S+ \S+\s+(\S+)/g)) {
    if (m[1].endsWith("/")) continue;
    files.push({ name: decodeURIComponent(m[1]), url: base + m[1], size: parseSize(m[2]) });
  }
  return files;
}

/** Supplementary files of a GEO series (processed count tables usually live here). */
export async function geoSupplements(accession: string): Promise<RemoteFile[]> {
  const stub = accession.length > 6 ? `${accession.slice(0, -3)}nnn` : "GSEnnn";
  const base = `https://ftp.ncbi.nlm.nih.gov/geo/series/${stub}/${accession}/suppl/`;
  return parseGeoListing(await (await http(base)).text(), base);
}

export async function download(file: RemoteFile): Promise<Uint8Array> {
  return new Uint8Array(await (await http(file.url)).arrayBuffer());
}
