import { useMemo, useState } from "react";
import { Histogram } from "../charts/Histogram";
import { Scatter, type Point } from "../charts/Scatter";
import { formatNumber, useChartTheme } from "../charts/theme";
import { Segmented, errorText } from "../components/ui";
import { detectVolcano, numericColumn, summarize, type Cell, type Table } from "../data/table";
import { IN_APP, importFile, pickFile, readStored, removeStored } from "../platform";
import { showTables, viewer } from "../viewer";
import { ANNOTATION, AnalyzePanel, labelColumn } from "./AnalyzePanel";

const ROWS = 50;

function TableView({ table }: { table: Table }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let out = needle
      ? table.rows.filter((r) => r.some((c) => c != null && String(c).toLowerCase().includes(needle)))
      : table.rows;
    if (sort) {
      const { col, desc } = sort;
      const cmp = (a: Cell, b: Cell) =>
        typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      // Empty cells sort last in both directions.
      out = [...out].sort((a, b) =>
        a[col] == null ? (b[col] == null ? 0 : 1) : b[col] == null ? -1 : desc ? cmp(b[col], a[col]) : cmp(a[col], b[col]),
      );
    }
    return out;
  }, [table, sort, filter]);

  const pages = Math.max(1, Math.ceil(rows.length / ROWS));
  const at = Math.min(page, pages - 1);
  return (
    <>
      <div className="search-bar">
        <input
          value={filter}
          placeholder="Filter rows, e.g. a gene symbol"
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {table.columns.map((c, i) => (
                <th
                  key={i}
                  className={table.numeric[i] ? "num" : ""}
                  onClick={() =>
                    setSort((s) => (s?.col === i ? (s.desc ? null : { col: i, desc: true }) : { col: i, desc: false }))
                  }
                >
                  {c}
                  {sort?.col === i ? (sort.desc ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(at * ROWS, (at + 1) * ROWS).map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} className={table.numeric[ci] ? "num" : ""}>
                    {typeof c === "number" && !Number.isInteger(c) ? formatNumber(c) : c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button className="button small" disabled={at === 0} onClick={() => setPage(at - 1)}>
          ‹ Prev
        </button>
        <span>
          {rows.length.toLocaleString()} rows · page {at + 1} of {pages}
        </span>
        <button className="button small" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
          Next ›
        </button>
      </div>
    </>
  );
}

function ColumnSelect({
  table,
  label,
  value,
  onChange,
  numeric,
  optional,
}: {
  table: Table;
  label: string;
  value: number;
  onChange: (v: number) => void;
  numeric: boolean;
  optional?: boolean;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {optional && <option value={-1}>None</option>}
        {table.columns.map((c, i) =>
          table.numeric[i] === numeric ? (
            <option key={i} value={i}>
              {c}
            </option>
          ) : null,
        )}
      </select>
    </label>
  );
}

function Distribution({ table }: { table: Table }) {
  const [col, setCol] = useState(table.numeric.indexOf(true));
  const values = useMemo(() => numericColumn(table, col), [table, col]);
  const s = summarize(values);
  return (
    <>
      <div className="controls">
        <ColumnSelect table={table} label="Column" value={col} onChange={setCol} numeric />
      </div>
      {s && s.min < s.max ? (
        <Histogram values={values} label={table.columns[col]} />
      ) : (
        <div className="status">Every value in this column is the same.</div>
      )}
      {s && (
        <dl className="facts">
          <dt>Values</dt>
          <dd>{s.n.toLocaleString()}</dd>
          <dt>Range</dt>
          <dd>
            {formatNumber(s.min)} to {formatNumber(s.max)}
          </dd>
          <dt>Median</dt>
          <dd>{formatNumber(s.median)}</dd>
          <dt>Mean</dt>
          <dd>{formatNumber(s.mean)}</dd>
        </dl>
      )}
    </>
  );
}

function ScatterView({ table }: { table: Table }) {
  const theme = useChartTheme();
  const all = table.numeric.flatMap((n, i) => (n ? [i] : []));
  const measured = all.filter((i) => !ANNOTATION.test(table.columns[i]));
  const numeric = measured.length >= 2 ? measured : all;
  const [xCol, setX] = useState(numeric[0]);
  const [yCol, setY] = useState(numeric[1] ?? numeric[0]);
  const [labelCol, setLabel] = useState(labelColumn(table));
  const [log, setLog] = useState(false);
  const [colourCol, setColour] = useState(() => table.columns.findIndex((c, i) => !table.numeric[i] && /^group$/i.test(c)));
  // The three most common values get a colour each (a scatter plot cannot carry more);
  // anything else, including rows with no value, is drawn first in grey as "Other".
  const groups = useMemo(() => {
    if (colourCol < 0) return [{ name: "Rows", color: theme.mark }];
    const counts = new Map<string, number>();
    let unnamed = false;
    for (const r of table.rows) {
      if (r[colourCol] == null) unnamed = true;
      else counts.set(String(r[colourCol]), (counts.get(String(r[colourCol])) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
    const named = top.map(([name], i) => ({ name, color: theme.categorical[i] }));
    return unnamed || counts.size > 3 ? [{ name: "Other", color: theme.neutral }, ...named] : named;
  }, [table, colourCol, theme]);
  const points = useMemo(() => {
    const out: (Point & { rawX: number; rawY: number })[] = [];
    const groupOf = new Map(groups.map((g, i) => [g.name, i]));
    // log10(value + 1) keeps zero counts on the plot.
    const scale = (v: number) => (log ? Math.log10(v + 1) : v);
    for (const r of table.rows) {
      const x = r[xCol];
      const y = r[yCol];
      if (typeof x !== "number" || typeof y !== "number" || (log && (x < 0 || y < 0))) continue;
      out.push({
        x: scale(x),
        y: scale(y),
        rawX: x,
        rawY: y,
        label: labelCol >= 0 && r[labelCol] != null ? String(r[labelCol]) : null,
        group: colourCol < 0 ? 0 : (groupOf.get(String(r[colourCol])) ?? 0),
      });
    }
    return out;
  }, [table, xCol, yCol, labelCol, log, colourCol, groups]);
  const axis = (col: number) => (log ? `log10(${table.columns[col]} + 1)` : table.columns[col]);
  return (
    <>
      <div className="controls">
        <ColumnSelect table={table} label="Across" value={xCol} onChange={setX} numeric />
        <ColumnSelect table={table} label="Up" value={yCol} onChange={setY} numeric />
        <ColumnSelect table={table} label="Name points by" value={labelCol} onChange={setLabel} numeric={false} optional />
        <ColumnSelect table={table} label="Colour by" value={colourCol} onChange={setColour} numeric={false} optional />
      </div>
      <label className="toggle">
        <span>
          Log scale
          <div className="muted small">For counts and other values that span orders of magnitude</div>
        </span>
        <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
      </label>
      <Scatter
        points={points}
        groups={groups}
        xLabel={axis(xCol)}
        yLabel={axis(yCol)}
        describe={(p) => {
          const raw = p as Point & { rawX: number; rawY: number };
          return `${table.columns[xCol]}: ${formatNumber(raw.rawX)} · ${table.columns[yCol]}: ${formatNumber(raw.rawY)}`;
        }}
      />
      <div className="muted small">{points.length.toLocaleString()} rows with both values</div>
    </>
  );
}

function Volcano({ table }: { table: Table }) {
  const theme = useChartTheme();
  const found = detectVolcano(table)!;
  const [effect, setEffect] = useState(found.effect);
  const [pCol, setP] = useState(found.p);
  const [labelCol, setLabel] = useState(found.label ?? labelColumn(table));
  const [alpha, setAlpha] = useState(0.05);
  const [minEffect, setMinEffect] = useState(1);

  const points = useMemo(() => {
    const out: (Point & { p: number })[] = [];
    // p = 0 has no logarithm; draw those at the smallest non-zero p in the table.
    let floor = Infinity;
    for (const r of table.rows)
      if (typeof r[pCol] === "number" && (r[pCol] as number) > 0) floor = Math.min(floor, r[pCol] as number);
    for (const r of table.rows) {
      const x = r[effect];
      const p = r[pCol];
      if (typeof x !== "number" || typeof p !== "number" || p < 0 || p > 1) continue;
      const significant = p <= alpha && Math.abs(x) >= minEffect;
      out.push({
        x,
        y: -Math.log10(Math.max(p, floor)),
        p,
        label: labelCol >= 0 && r[labelCol] != null ? String(r[labelCol]) : null,
        group: !significant ? 0 : x < 0 ? 1 : 2,
      });
    }
    return out;
  }, [table, effect, pCol, labelCol, alpha, minEffect]);

  const pName = table.columns[pCol];
  return (
    <>
      <div className="controls">
        <ColumnSelect table={table} label="Effect size" value={effect} onChange={setEffect} numeric />
        <ColumnSelect table={table} label="P-value" value={pCol} onChange={setP} numeric />
        <ColumnSelect table={table} label="Name points by" value={labelCol} onChange={setLabel} numeric={false} optional />
      </div>
      <div className="controls">
        <label>
          Significant at or below
          <select value={alpha} onChange={(e) => setAlpha(Number(e.target.value))}>
            {[0.1, 0.05, 0.01, 0.001].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Smallest effect that counts
          <select value={minEffect} onChange={(e) => setMinEffect(Number(e.target.value))}>
            {[0, 0.5, 1, 2].map((a) => (
              <option key={a} value={a}>
                {a === 0 ? "Any" : `±${a}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Scatter
        points={points}
        groups={[
          { name: "Not significant", color: theme.neutral },
          { name: "Down", color: theme.down },
          { name: "Up", color: theme.up },
        ]}
        xLabel={table.columns[effect]}
        yLabel={`−log10 ${pName}`}
        xLines={minEffect ? [-minEffect, minEffect] : []}
        yLines={[-Math.log10(alpha)]}
        describe={(p) =>
          `${table.columns[effect]}: ${formatNumber(p.x)} · ${pName}: ${formatNumber((p as Point & { p: number }).p)}`
        }
      />
    </>
  );
}

type View = "table" | "distribution" | "scatter" | "volcano" | "analyze";

function TablePanel({ table, onResult }: { table: Table; onResult: (t: Table) => void }) {
  const numericCount = table.numeric.filter(Boolean).length;
  const volcano = detectVolcano(table) !== null;
  const [view, setView] = useState<View>(viewer.pendingScript ? "analyze" : volcano ? "volcano" : (table.prefer ?? "table"));
  const options: { value: View; label: string }[] = [{ value: "table", label: "Table" }];
  if (volcano) options.push({ value: "volcano", label: "Volcano" });
  if (numericCount >= 1) options.push({ value: "distribution", label: "Distribution" });
  if (numericCount >= 2) options.push({ value: "scatter", label: "Scatter" });
  options.push({ value: "analyze", label: "Analyze" });
  return (
    <>
      <div className="muted small" style={{ marginBottom: 8 }}>
        {table.rows.length.toLocaleString()} rows · {table.columns.length} columns
      </div>
      <Segmented value={view} options={options} onChange={setView} />
      {view === "table" && <TableView table={table} />}
      {view === "volcano" && <Volcano table={table} />}
      {view === "distribution" && <Distribution table={table} />}
      {view === "scatter" && <ScatterView table={table} />}
      {view === "analyze" && <AnalyzePanel table={table} onResult={onResult} />}
    </>
  );
}

export default function DataPage() {
  const [, redraw] = useState(0);
  const [which, setWhich] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const openLocal = async () => {
    setError(null);
    try {
      const picked = await pickFile(["csv", "tsv", "txt", "tab", "xlsx", "xls", "ods", "gz", "zip"]);
      if (!picked) return;
      // Copied into app storage first: on Android the picker returns a URI only the backend can read.
      const name = `tmp/${picked.name.replace(/[^\w.-]/g, "_")}`;
      await importFile(picked, name);
      const bytes = await readStored(name);
      await removeStored(name);
      showTables(picked.name, picked.name, bytes);
      setWhich(0);
      redraw((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const table = viewer.tables[Math.min(which, viewer.tables.length - 1)];
  return (
    <div className="page wide">
      <div className="page-head">
        <h1 className="page-title">Data</h1>
        {IN_APP && (
          <button className="button" onClick={openLocal}>
            Open a file
          </button>
        )}
      </div>
      {error && <div className="status error">{error}</div>}
      {!table ? (
        <div className="card">
          <div className="card-title">Nothing open</div>
          {viewer.pendingScript && <p>Open a table first; the script from your lesson will be waiting under Analyze.</p>}
          <p className="muted" style={{ marginBottom: 0 }}>
            Open a paper's supplementary files or a dataset's files and pick a table, or open a CSV, TSV or Excel file from this
            device. Tables with fold-change and p-value columns get a volcano plot.
          </p>
        </div>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {viewer.title}
          </div>
          {viewer.tables.length > 1 ? (
            <div className="controls">
              <label>
                Table
                <select value={which} onChange={(e) => setWhich(Number(e.target.value))}>
                  {viewer.tables.map((t, i) => (
                    <option key={i} value={i}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <h2 className="section-title">{table.name}</h2>
          )}
          <TablePanel
            key={`${viewer.title}/${which}`}
            table={table}
            onResult={(result) => {
              viewer.tables.push(result);
              setWhich(viewer.tables.length - 1);
            }}
          />
        </>
      )}
    </div>
  );
}
