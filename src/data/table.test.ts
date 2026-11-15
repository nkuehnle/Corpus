import { describe, expect, it } from "vitest";
import { gzipSync, strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { detectVolcano, isTabular, parseDelimited, readTables, summarize } from "./table";

describe("parseDelimited", () => {
  it("handles quotes, embedded delimiters and CRLF", () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("picks tab when the header is tab separated", () => {
    expect(parseDelimited("gene\tlog2FC, raw\nMYOD1\t1.5")[1]).toEqual(["MYOD1", "1.5"]);
  });
});

describe("readTables", () => {
  const csv = "gene,log2FoldChange,padj,note\nMSTN,-1.2,0.001,down\nIGF1,2.5,1e-8,up\nACTB,0.01,NA,\n";

  it("types columns and treats NA as missing", () => {
    const [t] = readTables("de.csv", strToU8(csv));
    expect(t.columns).toEqual(["gene", "log2FoldChange", "padj", "note"]);
    expect(t.numeric).toEqual([false, true, true, false]);
    expect(t.rows[2]).toEqual(["ACTB", 0.01, null, null]);
  });

  it("skips comment lines before the header", () => {
    const [t] = readTables("x.txt", strToU8("# made by tool\n\nid\tvalue\na\t1\n"));
    expect(t.columns).toEqual(["id", "value"]);
    expect(t.rows).toEqual([["a", 1]]);
  });

  it("reads gzip, zip and workbooks", () => {
    expect(readTables("de.csv.gz", gzipSync(strToU8(csv)))[0].rows).toHaveLength(3);

    const zipped = readTables("supp.zip", zipSync({ "dir/de.csv": strToU8(csv), "readme.pdf": strToU8("x") }));
    expect(zipped.map((t) => t.name)).toEqual(["de.csv"]);

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["g", "v"],
        ["a", 1],
      ]),
      "One",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["g", "v"],
        ["b", 2],
      ]),
      "Two",
    );
    const sheets = readTables("s.xlsx", new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" })));
    expect(sheets.map((t) => t.name)).toEqual(["s.xlsx · One", "s.xlsx · Two"]);
    expect(sheets[1].rows).toEqual([["b", 2]]);
  });

  it("finds volcano columns, preferring the adjusted p-value", () => {
    const [t] = readTables("de.tsv", strToU8("Symbol\tlogFC\tP.Value\tadj.P.Val\nA\t1\t0.01\t0.04\nB\t-2\t0.2\t0.5\n"));
    expect(detectVolcano(t)).toEqual({ effect: 1, p: 3, label: 0 });
    expect(detectVolcano(readTables("x.csv", strToU8("a,b\n1,2\n"))[0])).toBeNull();
  });
});

it("summarizes numbers", () => {
  expect(summarize([4, 1, 3, 2])).toEqual({ n: 4, min: 1, max: 4, mean: 2.5, median: 2.5 });
  expect(summarize([])).toBeNull();
});

it("recognises openable files", () => {
  expect(isTabular("counts.txt.gz")).toBe(true);
  expect(isTabular("Table S1.XLSX")).toBe(true);
  expect(isTabular("figure.pdf")).toBe(false);
});
