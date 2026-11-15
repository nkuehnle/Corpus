// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ http: vi.fn() }));

import { authorLine, parseAbstract } from "./pubmed";
import { parseBucketListing, parseGeoListing } from "./supplements";

describe("pubmed", () => {
  it("joins labelled abstract sections", () => {
    const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><Article><Abstract>
      <AbstractText Label="BACKGROUND">Muscle <i>grows</i>.</AbstractText>
      <AbstractText Label="RESULTS">It did.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect(parseAbstract(xml)).toBe("**BACKGROUND.** Muscle grows.\n\n**RESULTS.** It did.");
    expect(parseAbstract("<PubmedArticleSet/>")).toBe("");
  });
  it("shortens long author lists", () => {
    expect(authorLine(["A", "B", "C"])).toBe("A, B, C");
    expect(authorLine(["A", "B", "C", "D", "E"])).toBe("A, B … E");
  });
});

describe("supplement listings", () => {
  it("reads an S3 listing", () => {
    const xml =
      "<ListBucketResult><Contents><Key>PMC1.1/a&amp;b S1.xlsx</Key><ETag>x</ETag><Size>2048</Size></Contents>" +
      "<Contents><Key>PMC1.1/PMC1.1.xml</Key><Size>10</Size></Contents></ListBucketResult>";
    expect(parseBucketListing(xml)).toEqual([
      { name: "a&b S1.xlsx", url: "https://pmc-oa-opendata.s3.amazonaws.com/PMC1.1/a&b%20S1.xlsx", size: 2048 },
      { name: "PMC1.1.xml", url: "https://pmc-oa-opendata.s3.amazonaws.com/PMC1.1/PMC1.1.xml", size: 10 },
    ]);
  });
  it("reads a GEO directory listing", () => {
    const html = `<pre>Name  Last modified  Size  <hr><a href="/geo/series/GSE47nnn/GSE47881/">Parent Directory</a>   -
<a href="GSE47881_RAW.tar">GSE47881_RAW.tar</a>               2013-06-12 14:08  398M
<a href="filelist.txt">filelist.txt</a>                   2013-06-12 14:08  5.8K
<hr></pre><a href="https://www.hhs.gov/x.html">HHS</a>`;
    expect(parseGeoListing(html, "https://h/suppl/")).toEqual([
      { name: "GSE47881_RAW.tar", url: "https://h/suppl/GSE47881_RAW.tar", size: 398 * 1024 ** 2 },
      { name: "filelist.txt", url: "https://h/suppl/filelist.txt", size: Math.round(5.8 * 1024) },
    ]);
  });
});
