import { makeTable, parseDelimited, type Table } from "./table";

/** What GEO records about one sample: its accession, title, and the "key: value"
 *  characteristics submitters attach (tissue, treatment, time point, sex, ...). */
/** GEO's suppl/filelist.txt: which files each archive holds. Keyed by archive name. */
export function parseFileList(text: string): Map<string, { name: string; size: number }[]> {
  const archives = new Map<string, { name: string; size: number }[]>();
  let current: { name: string; size: number }[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const [kind, name, , size] = line.split("\t");
    if (kind === "Archive") archives.set(name, (current = []));
    else if (kind === "File" && current) current.push({ name, size: Number(size) || 0 });
  }
  return archives;
}

export interface SampleInfo {
  gsm: string;
  title: string;
  fields: Record<string, string>;
  /** Other names the sample goes by: library names and file names from its description,
   *  which is often what count tables use as column headers. */
  aliases?: string[];
}

/** A GEO series as described by its SOFT record. */
export interface SeriesInfo {
  supplementary: string[];
  platforms: string[];
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

/** Adds a "key: value" characteristic, or the whole text under "characteristic" when it has no key. */
function addCharacteristic(fields: Record<string, string>, text: string) {
  const m = text.match(/^([^:]{1,60}):\s*(.*)$/);
  if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
  else if (text.trim()) fields.characteristic = text.trim();
}

/** The series record from acc.cgi?targ=self&form=text. */
export function parseSeriesSoft(text: string): SeriesInfo {
  const values = (key: string) =>
    [...text.matchAll(new RegExp(`^!Series_${key} = (.*)$`, "gm"))].map((m) => m[1].trim()).filter((v) => v && v !== "NONE");
  return {
    // GEO still writes ftp:// links; the same paths are served over https.
    supplementary: values("supplementary_file").map((u) => u.replace(/^ftp:\/\//, "https://")),
    platforms: values("platform_id"),
  };
}

/** The sample records from acc.cgi?targ=gsm&form=text. */
export function parseSamplesSoft(text: string): SampleInfo[] {
  const samples: SampleInfo[] = [];
  let current: SampleInfo | null = null;
  for (const line of text.split(/\r?\n/)) {
    const sample = line.match(/^\^SAMPLE = (\S+)/);
    if (sample) {
      current = { gsm: sample[1], title: "", fields: {} };
      samples.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^!Sample_(\w+) = (.*)$/);
    if (!m) continue;
    if (m[1] === "title") current.title = m[2].trim();
    else if (m[1] === "description") {
      const text = m[2].replace(/^library name:\s*/i, "").trim();
      // Only short, single-token descriptions are names; sentences are not.
      if (text && !/\s/.test(text))
        (current.aliases ??= []).push(text, text.replace(/\.(fastq|fq|bam|txt|tsv|csv)(\.gz)?$/i, ""));
    } else if (m[1] === "source_name_ch1") current.fields.source = m[2].trim();
    else if (m[1] === "characteristics_ch1") addCharacteristic(current.fields, m[2]);
  }
  return samples;
}

/** A series matrix file: sample annotations in the header, then probes by samples. */
export function parseSeriesMatrix(name: string, text: string): { table: Table; samples: SampleInfo[] } {
  const lines = text.split(/\r?\n/);
  const header = (key: string) =>
    lines.filter((l) => l.startsWith(`!Sample_${key}\t`)).map((l) => l.split("\t").slice(1).map(unquote));
  const gsms = header("geo_accession")[0] ?? [];
  const titles = header("title")[0] ?? [];
  const sources = header("source_name_ch1")[0] ?? [];
  const samples: SampleInfo[] = gsms.map((gsm, i) => {
    const fields: Record<string, string> = {};
    if (sources[i]) fields.source = sources[i];
    return { gsm, title: titles[i] ?? "", fields };
  });
  for (const row of header("characteristics_ch1")) row.forEach((v, i) => samples[i] && addCharacteristic(samples[i].fields, v));

  const begin = lines.findIndex((l) => l.startsWith("!series_matrix_table_begin"));
  const end = lines.findIndex((l) => l.startsWith("!series_matrix_table_end"));
  if (begin < 0) throw new Error("This series matrix has no data table.");
  const body = lines.slice(begin + 1, end < 0 ? undefined : end).filter((l) => l.trim());
  if (body.length < 2)
    throw new Error("This series has no processed values in its matrix (typical of RNA-seq); use its supplementary files.");
  const rows = body.map((l) => l.split("\t").map(unquote));
  const table = makeTable(name, rows[0], rows.slice(1));
  return { table, samples };
}

/** Probe ID to gene symbol, from a GEO platform annotation file (GPLxxx.annot). */
export function parsePlatformAnnotation(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.startsWith("!platform_table_begin"));
  const header = lines[begin + 1]?.split("\t") ?? [];
  const id = header.indexOf("ID");
  const symbol = header.findIndex((h) => /^gene symbol$/i.test(h));
  const symbols = new Map<string, string>();
  if (begin < 0 || id < 0 || symbol < 0) return symbols;
  for (const line of lines.slice(begin + 2)) {
    if (line.startsWith("!platform_table_end")) break;
    const cells = line.split("\t");
    if (cells[symbol]) symbols.set(cells[id], cells[symbol]);
  }
  return symbols;
}

/** Puts a gene symbol column after the probe ID column. */
export function addSymbols(table: Table, symbols: Map<string, string>): Table {
  if (!symbols.size) return table;
  const rows = table.rows.map((r) => [r[0], symbols.get(String(r[0])) ?? null, ...r.slice(1)]);
  return {
    ...table,
    columns: [table.columns[0], "Gene symbol", ...table.columns.slice(1)],
    numeric: [table.numeric[0], false, ...table.numeric.slice(1)],
    rows,
    samples: table.samples && [null, null, ...table.samples.slice(1)],
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds which GEO sample each column holds. A column matches a sample by accession, by
 *  title, by a bracketed name in the title (GEO titles often end in "[lab name]"), or by
 *  containment either way when exactly one sample fits. */
export function matchSamples(table: Table, samples: SampleInfo[]): (SampleInfo | null)[] {
  const byGsm = new Map(samples.map((s) => [s.gsm.toLowerCase(), s]));
  // A name shared by several samples (a description like "GeneCount_raw.tsv") identifies none.
  const counts = new Map<string, number>();
  const named = samples.map((s) => {
    const names = [
      ...new Set([s.title, ...[...s.title.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]), ...(s.aliases ?? [])].map(norm)),
    ].filter((n) => n.length >= 2);
    names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
    return { s, names };
  });
  const keys = named.map(({ s, names }) => ({ s, names: names.filter((n) => counts.get(n) === 1) }));
  // Fallback: a word that occurs in exactly one title (often a sample code such as "10B").
  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  const wordCounts = new Map<string, number>();
  for (const s of samples) for (const w of new Set(words(s.title))) wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
  const distinctive = samples.map((s) => ({
    s,
    words: [...new Set(words(s.title))].filter((w) => wordCounts.get(w) === 1 && /\d/.test(w)),
  }));
  return table.columns.map((column, i) => {
    if (!table.numeric[i]) return null;
    const gsm = column.match(/GSM\d+/i)?.[0].toLowerCase();
    if (gsm && byGsm.has(gsm)) return byGsm.get(gsm)!;
    const c = norm(column);
    if (!c) return null;
    const exact = keys.filter((k) => k.names.includes(c));
    if (exact.length === 1) return exact[0].s;
    const partial = keys.filter((k) => k.names.some((n) => n.includes(c) || c.includes(n)));
    if (partial.length === 1) return partial[0].s;
    const columnWords = new Set(words(column));
    const byWord = distinctive.filter((d) => d.words.some((w) => columnWords.has(w)));
    return byWord.length === 1 ? byWord[0].s : null;
  });
}

/** Attaches sample annotations to the columns they describe. */
export function annotate(table: Table, samples: SampleInfo[]): Table {
  const matched = matchSamples(table, samples);
  return matched.some(Boolean) ? { ...table, samples: matched } : table;
}

/** Characteristics that split the annotated samples into at least two groups, with how many
 *  samples have each value. Values shared by every sample (tissue, organism) are left out. */
export function groupingFields(table: Table): { key: string; values: [string, number][] }[] {
  const annotated = (table.samples ?? []).filter((s): s is SampleInfo => !!s);
  const keys = new Set(annotated.flatMap((s) => Object.keys(s.fields)));
  const out: { key: string; values: [string, number][] }[] = [];
  for (const key of keys) {
    const counts = new Map<string, number>();
    for (const s of annotated) {
      const v = s.fields[key];
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size >= 2 && counts.size < annotated.length)
      out.push({ key, values: [...counts.entries()].sort((a, b) => b[1] - a[1]) });
  }
  return out;
}

/** Per-sample count files (as in many GEO RAW.tar archives) joined into one table: genes by
 *  samples. Each file contributes its last numeric column, keyed by its first column; a
 *  header is recognised when its last field is not a number; HTSeq summary rows (__*) and
 *  comment lines are skipped. Columns are named by the sample accession in the file name. */
export function mergeSampleFiles(name: string, files: { name: string; text: string }[]): Table {
  const genes = new Map<string, number>();
  const order: string[] = [];
  const columns: string[] = [];
  const values: Map<number, number>[] = [];
  for (const file of files) {
    const rows = parseDelimited(file.text).filter(
      (r) => r.length >= 2 && r[0] && !r[0].startsWith("#") && !r[0].startsWith("__"),
    );
    if (!rows.length) continue;
    const start = Number.isFinite(Number(rows[0][rows[0].length - 1])) ? 0 : 1;
    const column = new Map<number, number>();
    for (const r of rows.slice(start)) {
      const v = Number(r[r.length - 1]);
      if (!Number.isFinite(v)) continue;
      let g = genes.get(r[0]);
      if (g === undefined) {
        g = order.length;
        genes.set(r[0], g);
        order.push(r[0]);
      }
      column.set(g, v);
    }
    columns.push(file.name.match(/GSM\d+/i)?.[0] ?? file.name.replace(/\.(txt|tsv|csv|tab)(\.gz)?$/i, ""));
    values.push(column);
  }
  if (!columns.length) throw new Error("None of these files held a table of counts.");
  const rows = order.map((gene, g) => [gene, ...values.map((c) => c.get(g) ?? null)]);
  return makeTable(name, ["gene", ...columns], rows);
}
