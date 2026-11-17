import { describe, expect, it } from "vitest";
import {
  addSymbols,
  annotate,
  groupingFields,
  mergeSampleFiles,
  parsePlatformAnnotation,
  parseSamplesSoft,
  parseSeriesMatrix,
  parseSeriesSoft,
  parseFileList,
} from "./geo";
import { makeTable } from "./table";

const matrix = [
  '!Series_title\t"x"',
  '!Sample_title\t"Pre (A1)"\t"Post (A1)"\t"Pre (A2)"',
  '!Sample_geo_accession\t"GSM1"\t"GSM2"\t"GSM3"',
  '!Sample_source_name_ch1\t"Vastus lateralis"\t"Vastus lateralis"\t"Vastus lateralis"',
  '!Sample_characteristics_ch1\t"time point: Basal"\t"time point: Post"\t"time point: Basal"',
  '!Sample_characteristics_ch1\t"gender: Male"\t"gender: Male"\t"gender: Female"',
  "!series_matrix_table_begin",
  '"ID_REF"\t"GSM1"\t"GSM2"\t"GSM3"',
  '"1007_s_at"\t10.5\t12\t11',
  '"1053_at"\t200\t180\t210',
  "!series_matrix_table_end",
].join("\n");

describe("GEO records", () => {
  it("reads a series record", () => {
    const soft =
      "^SERIES = GSE1\n!Series_platform_id = GPL570\n!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE1/suppl/GSE1_RAW.tar\n!Series_supplementary_file = NONE\n";
    expect(parseSeriesSoft(soft)).toEqual({
      supplementary: ["https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE1/suppl/GSE1_RAW.tar"],
      platforms: ["GPL570"],
    });
  });

  it("reads sample records", () => {
    const soft = [
      "^SAMPLE = GSM10",
      "!Sample_title = Dox Control [CON_ONE_PLANT]",
      "!Sample_source_name_ch1 = Plantaris",
      "!Sample_characteristics_ch1 = treatment: Doxycycline",
      "!Sample_characteristics_ch1 = Male",
      "!Sample_description = Library name: CON_1",
      "!Sample_description = TA muscle RNA from a female mouse.",
      "^SAMPLE = GSM11",
      "!Sample_title = Myc [MYC_ONE_PLANT]",
    ].join("\n");
    expect(parseSamplesSoft(soft)).toEqual([
      {
        gsm: "GSM10",
        title: "Dox Control [CON_ONE_PLANT]",
        fields: { source: "Plantaris", treatment: "Doxycycline", characteristic: "Male" },
        aliases: ["CON_1", "CON_1"],
      },
      { gsm: "GSM11", title: "Myc [MYC_ONE_PLANT]", fields: {} },
    ]);
  });

  it("reads a series matrix with its annotations", () => {
    const { table, samples } = parseSeriesMatrix("m", matrix);
    expect(table.columns).toEqual(["ID_REF", "GSM1", "GSM2", "GSM3"]);
    expect(table.rows[0]).toEqual(["1007_s_at", 10.5, 12, 11]);
    expect(samples[2]).toEqual({
      gsm: "GSM3",
      title: "Pre (A2)",
      fields: { source: "Vastus lateralis", "time point": "Basal", gender: "Female" },
    });
  });

  it("explains a matrix without values", () => {
    expect(() =>
      parseSeriesMatrix(
        "m",
        '!Sample_geo_accession\t"GSM1"\n!series_matrix_table_begin\n"ID_REF"\t"GSM1"\n!series_matrix_table_end',
      ),
    ).toThrow("supplementary files");
  });

  it("maps probes to symbols", () => {
    const annot =
      "#ID = x\n!platform_table_begin\nID\tGene title\tGene symbol\n1007_s_at\tt\tDDR1\n1053_at\tt\t\n!platform_table_end\n";
    const symbols = parsePlatformAnnotation(annot);
    expect([...symbols]).toEqual([["1007_s_at", "DDR1"]]);
    const { table, samples } = parseSeriesMatrix("m", matrix);
    const withSymbols = addSymbols(annotate(table, samples), symbols);
    expect(withSymbols.columns.slice(0, 3)).toEqual(["ID_REF", "Gene symbol", "GSM1"]);
    expect(withSymbols.rows.map((r) => r[1])).toEqual(["DDR1", null]);
    expect(withSymbols.samples?.[2]?.gsm).toBe("GSM1");
  });
});

describe("matching columns to samples", () => {
  const samples = parseSamplesSoft(
    [
      "^SAMPLE = GSM1",
      "!Sample_title = Dox Control [CON_ONE_PLANT]",
      "!Sample_characteristics_ch1 = treatment: Doxycycline",
      "^SAMPLE = GSM2",
      "!Sample_title = Myc [MYC_ONE_PLANT]",
      "!Sample_characteristics_ch1 = treatment: Doxycycline",
      "^SAMPLE = GSM3",
      "!Sample_title = Sham6",
      "!Sample_characteristics_ch1 = treatment: sham",
      "^SAMPLE = GSM4",
      "!Sample_title = OV3",
      "!Sample_characteristics_ch1 = treatment: overload",
    ].join("\n"),
  );

  it("matches by bracketed name, title and accession, and leaves the rest alone", () => {
    const t = makeTable("t", ["gene", "CON_ONE_PLANT", "Sham6", "GSM4_counts", "unknown"], [["a", 1, 2, 3, 4]]);
    expect(annotate(t, samples).samples?.map((s) => s?.gsm ?? null)).toEqual([null, "GSM1", "GSM3", "GSM4", null]);
  });

  it("matches by library name and by a sample code in the title, but not by a shared description", () => {
    const more = parseSamplesSoft(
      [
        "^SAMPLE = GSM20",
        "!Sample_title = 10B Young Combined PreTraining",
        "!Sample_description = GeneCount_raw.tsv",
        "^SAMPLE = GSM21",
        "!Sample_title = 10C Young Combined PostTraining",
        "!Sample_description = GeneCount_raw.tsv",
        "^SAMPLE = GSM22",
        "!Sample_title = Tibialis anterior, Female, C26, 26",
        "!Sample_description = Library name: EARLY_FEMALE_Mouse_Number_26",
        "^SAMPLE = GSM23",
        "!Sample_title = Tibialis anterior, Female, C26, 27",
        "!Sample_description = Library name: EARLY_FEMALE_Mouse_Number-27",
      ].join("\n"),
    );
    const t = makeTable(
      "t",
      ["gene", "s_10B-180_GeneCount", "s_10C-180_GeneCount", "EARLY_FEMALE_Mouse_Number_26", "EARLY_FEMALE_Mouse_Number-27"],
      [["a", 1, 2, 3, 4]],
    );
    expect(annotate(t, more).samples?.map((s) => s?.gsm ?? null)).toEqual([null, "GSM20", "GSM21", "GSM22", "GSM23"]);
  });

  it("reads which files each archive holds", () => {
    const list = parseFileList(
      [
        "#Archive/File\tName\tTime\tSize\tType",
        "Archive\tGSE1_RAW.tar\t01/17/2013 15:15:22\t605655040\tTAR",
        "File\tGSM1.CEL.gz\t04/06/2011 11:33:41\t5316661\tCEL",
        "File\tGSM1.CHP.gz\t04/06/2011 11:33:41\t299727\tCHP",
      ].join("\n"),
    );
    expect(list.get("GSE1_RAW.tar")).toEqual([
      { name: "GSM1.CEL.gz", size: 5316661 },
      { name: "GSM1.CHP.gz", size: 299727 },
    ]);
  });

  it("lists only fields that split the samples", () => {
    const t = annotate(makeTable("t", ["gene", "CON_ONE_PLANT", "MYC_ONE_PLANT", "Sham6", "OV3"], [["a", 1, 2, 3, 4]]), samples);
    expect(groupingFields(t)).toEqual([
      {
        key: "treatment",
        values: [
          ["Doxycycline", 2],
          ["sham", 1],
          ["overload", 1],
        ],
      },
    ]);
  });
});

describe("merging per-sample count files", () => {
  it("joins files on gene, skipping headers, comments and HTSeq summary rows", () => {
    const htseq = "Myod1\t10\nMstn\t5\n__no_feature\t99\n";
    const featureCounts = "# program\nGeneid\tChr\tLength\tsample.bam\nMstn\tchr1\t100\t7\nActa1\tchr2\t200\t900\n";
    const t = mergeSampleFiles("raw", [
      { name: "GSM101_sham.txt.gz", text: htseq },
      { name: "GSM102_ov.txt", text: featureCounts },
    ]);
    expect(t.columns).toEqual(["gene", "GSM101", "GSM102"]);
    expect(t.rows).toEqual([
      ["Myod1", 10, null],
      ["Mstn", 5, 7],
      ["Acta1", null, 900],
    ]);
  });
});
