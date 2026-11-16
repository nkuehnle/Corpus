import { invoke } from "@tauri-apps/api/core";
import { makeTable, type Table } from "./table";

/** How a table's values relate to the log scale the statistics need. */
export type Transform = "counts" | "log" | "none";

export const TRANSFORMS: { value: Transform; label: string }[] = [
  { value: "counts", label: "Raw read counts" },
  { value: "log", label: "Normalised, not logged (CPM, TPM, FPKM)" },
  { value: "none", label: "Already on a log scale" },
];

/** Guesses from the numbers: whole numbers are counts; small values with decimals are logged. */
export function guessTransform(table: Table, columns: number[]): Transform {
  let max = 0;
  let whole = true;
  for (const row of table.rows.slice(0, 2000)) {
    for (const c of columns) {
      const v = row[c];
      if (typeof v !== "number") continue;
      if (v > max) max = v;
      if (!Number.isInteger(v)) whole = false;
    }
  }
  if (whole) return "counts";
  return max > 50 ? "log" : "none";
}

/** Base64 of the raw bytes, built in chunks so a large matrix does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface SampleMatrix {
  /** Row-major single-precision values; empty and text cells are NaN. */
  values: Float32Array;
  /** Which table row each matrix row came from. */
  source: number[];
}

/** The chosen columns as a matrix. Rows with nothing above zero are left out: they cannot be
 *  tested, add nothing to a sample's total, and are often half of a count table. */
export function toMatrix(table: Table, columns: number[]): SampleMatrix {
  const source: number[] = [];
  table.rows.forEach((row, r) => {
    if (columns.some((c) => typeof row[c] === "number" && row[c] !== 0)) source.push(r);
  });
  const values = new Float32Array(source.length * columns.length);
  let i = 0;
  for (const r of source) {
    for (const c of columns) {
      const v = table.rows[r][c];
      values[i++] = typeof v === "number" ? v : NaN;
    }
  }
  return { values, source };
}

interface Reply {
  rows: number;
  cols: number;
  values: number[];
  explained: number[];
  genes: number;
}

function analyze(request: object, matrix: SampleMatrix): Promise<Reply> {
  const bytes = new Uint8Array(matrix.values.buffer, matrix.values.byteOffset, matrix.values.byteLength);
  return invoke<Reply>("analyze", { request, data: toBase64(bytes) });
}

/** Names for the result rows: the label column if there is one, otherwise the row number. */
function rowNames(table: Table, labelCol: number): (i: number) => string {
  return (i) => (labelCol >= 0 && table.rows[i][labelCol] != null ? String(table.rows[i][labelCol]) : `row ${i + 1}`);
}

export interface Groups {
  nameA: string;
  nameB: string;
  a: number[];
  b: number[];
}

/** Compares group B with group A for every row: a moderated t-test on log2 values with
 *  Benjamini-Hochberg adjustment. Returns a table the volcano view recognises. */
export async function differentialExpression(
  table: Table,
  groups: Groups,
  transform: Transform,
  labelCol: number,
): Promise<Table> {
  const columns = [...groups.a, ...groups.b];
  const matrix = toMatrix(table, columns);
  const reply = await analyze(
    {
      kind: "de",
      rows: matrix.source.length,
      cols: columns.length,
      transform,
      groupA: groups.a.map((_, i) => i),
      groupB: groups.b.map((_, i) => groups.a.length + i),
    },
    matrix,
  );
  if (!reply.rows) throw new Error("No rows could be tested. Check the groups and how the values are scaled.");
  const name = rowNames(table, labelCol);
  const rows: unknown[][] = [];
  for (let r = 0; r < reply.rows; r++) {
    const [row, meanA, meanB, log2fc, t, p, padj] = reply.values.slice(r * reply.cols, (r + 1) * reply.cols);
    rows.push([name(matrix.source[row]), log2fc, padj, p, t, meanA, meanB]);
  }
  return makeTable(
    `${groups.nameB} vs ${groups.nameA}`,
    ["gene", "log2FC", "padj", "p-value", "t", `mean log2 ${groups.nameA}`, `mean log2 ${groups.nameB}`],
    rows,
  );
}

/** Principal components of the samples, one row per sample, with a group column to colour by. */
export async function samplePca(
  table: Table,
  samples: number[],
  group: (col: number) => string,
  transform: Transform,
): Promise<Table> {
  const matrix = toMatrix(table, samples);
  const reply = await analyze(
    { kind: "pca", rows: matrix.source.length, cols: samples.length, transform, samples: samples.map((_, i) => i), top: 2000 },
    matrix,
  );
  const percent = (i: number) => `PC${i + 1} (${(reply.explained[i] * 100).toFixed(0)}%)`;
  const rows = samples.map((col, s) => [
    table.columns[col],
    group(col),
    ...reply.values.slice(s * reply.cols, (s + 1) * reply.cols),
  ]);
  const result = makeTable(
    `PCA of ${samples.length} samples (${reply.genes.toLocaleString()} genes)`,
    ["sample", "group", ...reply.explained.map((_, i) => percent(i))],
    rows,
  );
  return { ...result, prefer: "scatter" };
}
