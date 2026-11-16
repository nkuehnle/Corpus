import { gunzipSync, unzipSync } from "fflate";
import * as XLSX from "xlsx";

export type Cell = string | number | null;

export interface Table {
  name: string;
  columns: string[];
  rows: Cell[][];
  /** Which columns hold numbers (at least 90% of their filled cells parse as numbers). */
  numeric: boolean[];
  /** The view a derived table is best seen in first (a PCA result opens as a scatter plot). */
  prefer?: "scatter";
}

const TABULAR = /\.(csv|tsv|tab|txt|xlsx|xlsm|xls|ods)(\.gz)?$/i;
const ARCHIVE = /\.zip$/i;

/** Whether the viewer can open a file with this name. */
export function isTabular(name: string): boolean {
  return TABULAR.test(name) || ARCHIVE.test(name);
}

function toCell(raw: unknown): Cell {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (s === "" || /^(na|nan|null|n\/a)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

/** A table from column names and rows of raw values (a script's or an analysis's result). */
export function makeTable(name: string, columns: string[], rows: unknown[][]): Table {
  const table = build(name, [columns, ...rows]);
  if (!table) throw new Error("The result has no columns.");
  return table;
}

function build(name: string, grid: unknown[][]): Table | null {
  // Skip leading comment/blank lines (GEO tables often start with them).
  const first = grid.findIndex((r) => r.some((c) => c != null && String(c).trim() !== "") && !String(r[0] ?? "").startsWith("#"));
  if (first < 0) return null;
  const width = Math.max(...grid.slice(first, first + 50).map((r) => r.length));
  const header = grid[first];
  const columns = Array.from({ length: width }, (_, i) => {
    const h = header[i] == null ? "" : String(header[i]).trim();
    return h || `column ${i + 1}`;
  });
  const rows = grid
    .slice(first + 1)
    .filter((r) => r.some((c) => c != null && c !== ""))
    .map((r) => Array.from({ length: width }, (_, i) => toCell(r[i])));
  const numeric = columns.map((_, i) => {
    let filled = 0;
    let numbers = 0;
    for (const r of rows) {
      if (r[i] == null) continue;
      filled++;
      if (typeof r[i] === "number") numbers++;
    }
    return filled > 0 && numbers / filled >= 0.9;
  });
  return { name, columns, rows, numeric };
}

/** Splits delimited text, honouring quoted fields. The delimiter is whichever of tab,
 *  comma or semicolon is most common in the first line. */
export function parseDelimited(text: string): string[][] {
  const head = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  const count = (d: string) => head.split(d).length;
  const delim = ["\t", ",", ";"].reduce((a, b) => (count(b) > count(a) ? b : a));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delim) (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows;
}

/** Every table found in a file: one per sheet of a workbook, one per tabular file in a zip. */
export function readTables(name: string, bytes: Uint8Array): Table[] {
  if (ARCHIVE.test(name)) {
    return Object.entries(unzipSync(bytes, { filter: (f) => TABULAR.test(f.name) && !f.name.startsWith("__MACOSX") })).flatMap(
      ([entry, data]) => readTables(entry.split("/").pop()!, data),
    );
  }
  if (/\.gz$/i.test(name)) return readTables(name.replace(/\.gz$/i, ""), gunzipSync(bytes));
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(name)) {
    const book = XLSX.read(bytes, { type: "array" });
    return book.SheetNames.flatMap((sheet) => {
      const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet], { header: 1, raw: true, defval: null });
      const table = build(book.SheetNames.length > 1 ? `${name} · ${sheet}` : name, grid);
      return table ? [table] : [];
    });
  }
  const table = build(name, parseDelimited(new TextDecoder().decode(bytes)));
  return table ? [table] : [];
}

export function numericColumn(table: Table, col: number): number[] {
  const out: number[] = [];
  for (const r of table.rows) if (typeof r[col] === "number") out.push(r[col] as number);
  return out;
}

export interface VolcanoColumns {
  effect: number;
  p: number;
  label: number | null;
}

const EFFECT = /log\s*_?2?\s*_?(fc|fold)|^l(og)?fc$|fold.?change|^lfc/i;
const ADJUSTED = /adj|fdr|q.?val|padj|bh/i;
const PVALUE = /p.?val|^p$|pvalue|^p\./i;
const LABEL = /symbol|gene|protein|name|^id$/i;

/** Finds effect-size and p-value columns so a differential-expression table gets a volcano
 *  plot without any setup. Prefers an adjusted p-value when there is one. */
export function detectVolcano(table: Table): VolcanoColumns | null {
  const find = (re: RegExp, numeric: boolean) => table.columns.findIndex((c, i) => table.numeric[i] === numeric && re.test(c));
  const effect = find(EFFECT, true);
  let p = find(ADJUSTED, true);
  if (p < 0) p = find(PVALUE, true);
  if (effect < 0 || p < 0 || p === effect) return null;
  const label = find(LABEL, false);
  return { effect, p, label: label < 0 ? null : label };
}

export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

export function summarize(values: number[]): Summary | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  };
}
