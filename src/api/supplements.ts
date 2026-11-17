import { http } from "../platform";

export interface RemoteFile {
  name: string;
  url: string;
  /** Bytes, when the server reports it. */
  size: number | null;
  /** A GEO series matrix: processed values with the sample annotations. */
  kind?: "matrix";
  /** For an archive, the files inside it, when the repository lists them. */
  contents?: { name: string; size: number }[];
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

export async function download(file: RemoteFile): Promise<Uint8Array> {
  return new Uint8Array(await (await http(file.url)).arrayBuffer());
}
