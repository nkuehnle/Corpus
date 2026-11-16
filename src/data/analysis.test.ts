import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { guessTransform, toBase64, toMatrix } from "./analysis";
import { resultTable } from "./scripts";
import { makeTable } from "./table";

const table = makeTable(
  "t",
  ["gene", "s1", "s2"],
  [
    ["A", 1, 2],
    ["B", null, 4],
  ],
);

describe("analysis requests", () => {
  it("encodes bytes as base64, including across chunk boundaries", () => {
    expect(toBase64(new Uint8Array([72, 105]))).toBe("SGk=");
    const big = new Uint8Array(70_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(70_000);
  });
  it("builds a row-major matrix, with NaN for empty cells and all-zero rows left out", () => {
    const counts = makeTable(
      "t",
      ["gene", "s1", "s2"],
      [
        ["A", 1, 2],
        ["Z", 0, 0],
        ["B", null, 4],
      ],
    );
    const m = toMatrix(counts, [1, 2]);
    expect(Array.from(m.values)).toEqual([1, 2, NaN, 4]);
    expect(m.source).toEqual([0, 2]);
  });
  it("guesses the scale of the values", () => {
    expect(guessTransform(table, [1, 2])).toBe("counts");
    expect(guessTransform(makeTable("t", ["g", "a"], [["x", 120.5]]), [1])).toBe("log");
    expect(guessTransform(makeTable("t", ["g", "a"], [["x", 7.25]]), [1])).toBe("none");
  });
});

describe("script results", () => {
  it("accepts columns and rows", () => {
    const t = resultTable("fallback", { name: "mine", columns: ["g", "v"], rows: [["A", 1]] })!;
    expect([t.name, t.columns, t.rows, t.numeric]).toEqual(["mine", ["g", "v"], [["A", 1]], [false, true]]);
  });
  it("accepts a list of objects with differing keys", () => {
    const t = resultTable("r", [
      { g: "A", v: 1 },
      { g: "B", w: 2 },
    ])!;
    expect(t.columns).toEqual(["g", "v", "w"]);
    expect(t.rows).toEqual([
      ["A", 1, null],
      ["B", null, 2],
    ]);
  });
  it("treats no return value as no table and explains bad shapes", () => {
    expect(resultTable("r", undefined)).toBeNull();
    expect(() => resultTable("r", [1, 2])).toThrow("make each item an object");
    expect(() => resultTable("r", { rows: [] })).toThrow("Return { columns");
  });
});
