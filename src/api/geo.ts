import { gunzipSync } from "fflate";
import { parseFileList, parsePlatformAnnotation, parseSamplesSoft, parseSeriesSoft, type SampleInfo } from "../data/geo";
import { IN_APP, downloadToStore, http, readStored } from "../platform";
import type { RemoteFile } from "./supplements";

/** GEO's directory for an accession: GSE28422 → GSE28nnn, GPL570 → GPLnnn. */
export function geoStub(accession: string): string {
  const [, letters, digits] = accession.match(/^([A-Z]+)(\d+)$/)!;
  return `${letters}${digits.length > 3 ? digits.slice(0, -3) : ""}nnn`;
}

const SOFT = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi";

/** File size from a HEAD request; null when the server does not say. */
async function size(url: string): Promise<number | null> {
  try {
    const res = await http(url, "HEAD");
    const length = res.headers.get(IN_APP ? "content-length" : "x-upstream-length");
    return length ? Number(length) : null;
  } catch {
    return null;
  }
}

export interface Series {
  files: RemoteFile[];
  platforms: string[];
}

/** A series' downloadable files: its supplementary files and its series matrix (one per
 *  platform). GEO no longer serves folder listings, so the names come from the series record. */
export async function seriesFiles(accession: string): Promise<Series> {
  const soft = await (await http(`${SOFT}?acc=${accession}&targ=self&form=text&view=brief`)).text();
  const { supplementary, platforms } = parseSeriesSoft(soft);
  const base = `https://ftp.ncbi.nlm.nih.gov/geo/series/${geoStub(accession)}/${accession}`;
  const matrices = (platforms.length > 1 ? platforms.map((p) => `${accession}-${p}`) : [accession]).map((stem) => ({
    name: `${stem}_series_matrix.txt.gz`,
    url: `${base}/matrix/${stem}_series_matrix.txt.gz`,
    kind: "matrix" as const,
  }));
  const files = [...matrices, ...supplementary.map((url) => ({ name: decodeURIComponent(url.split("/").pop()!), url }))];
  const [sizes, archives] = await Promise.all([Promise.all(files.map((f) => size(f.url))), archiveContents(base, files)]);
  return {
    platforms,
    files: files
      .map((f, i) => ({ ...f, size: sizes[i], contents: archives.get(f.name) }))
      .filter((f) => !("kind" in f) || f.size !== null),
  };
}

/** What each archive holds, from GEO's filelist.txt, so it can be judged before downloading. */
async function archiveContents(base: string, files: { name: string }[]) {
  if (!files.some((f) => /\.(tar|tgz|tar\.gz)$/i.test(f.name))) return new Map<string, { name: string; size: number }[]>();
  try {
    const res = await http(`${base}/suppl/filelist.txt`);
    return res.ok ? parseFileList(await res.text()) : new Map();
  } catch {
    return new Map();
  }
}

const samplesCache = new Map<string, SampleInfo[]>();

/** Titles and characteristics of every sample in a series. */
export async function seriesSamples(accession: string): Promise<SampleInfo[]> {
  const cached = samplesCache.get(accession);
  if (cached) return cached;
  const text = await (await http(`${SOFT}?acc=${accession}&targ=gsm&form=text&view=quick`)).text();
  const samples = parseSamplesSoft(text);
  samplesCache.set(accession, samples);
  return samples;
}

const symbolsCache = new Map<string, Map<string, string>>();

/** Probe-to-symbol map for a platform, from GEO's annotation file, kept in app storage after
 *  the first download. Empty when GEO has no annotation for the platform. */
export async function platformSymbols(platform: string): Promise<Map<string, string>> {
  const cached = symbolsCache.get(platform);
  if (cached) return cached;
  const name = `geo/platforms/${platform}.annot.gz`;
  let bytes: Uint8Array;
  try {
    bytes = await readStored(name);
  } catch {
    try {
      await downloadToStore(
        `https://ftp.ncbi.nlm.nih.gov/geo/platforms/${geoStub(platform)}/${platform}/annot/${platform}.annot.gz`,
        name,
        name,
      );
      bytes = await readStored(name);
    } catch {
      symbolsCache.set(platform, new Map());
      return new Map();
    }
  }
  const symbols = parsePlatformAnnotation(new TextDecoder().decode(gunzipSync(bytes)));
  symbolsCache.set(platform, symbols);
  return symbols;
}
