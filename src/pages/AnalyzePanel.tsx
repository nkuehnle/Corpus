import { useEffect, useMemo, useState } from "react";
import { Await, Icon, ask, errorText } from "../components/ui";
import { TRANSFORMS, differentialExpression, guessTransform, samplePca, type Transform } from "../data/analysis";
import { TEMPLATE, runScript } from "../data/scripts";
import type { Table } from "../data/table";
import type { Script } from "../db/repo";
import { IN_APP } from "../platform";
import { repo, useLoad } from "../store";
import { viewer } from "../viewer";

/** Genomic coordinates and lengths are numbers but are not measurements of a sample. */
export const ANNOTATION = /^(chr|chromosome|start|stop|end|pos|strand|length|codinglength|level)/i;

/** The column most likely to name a row: a gene symbol or name if there is one. */
export function labelColumn(table: Table): number {
  const named = table.columns.findIndex((c, i) => !table.numeric[i] && /symbol|gene.?name|^name$|^gene$/i.test(c));
  return named >= 0 ? named : table.numeric.indexOf(false);
}

type Side = "a" | "b";

function Groups({ table, onResult }: { table: Table; onResult: (t: Table) => void }) {
  const samples = useMemo(() => table.columns.flatMap((c, i) => (table.numeric[i] && !ANNOTATION.test(c) ? [i] : [])), [table]);
  const [side, setSide] = useState<Map<number, Side>>(new Map());
  const [patternA, setPatternA] = useState("");
  const [patternB, setPatternB] = useState("");
  const [transform, setTransform] = useState<Transform>(() => guessTransform(table, samples));
  const [label, setLabel] = useState(() => labelColumn(table));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Typing a pattern assigns every matching column; tapping a chip then adjusts one at a time.
  const applyPatterns = (a: string, b: string) => {
    const next = new Map<number, Side>();
    const has = (col: number, pattern: string) =>
      pattern.trim() !== "" && table.columns[col].toLowerCase().includes(pattern.trim().toLowerCase());
    for (const col of samples) {
      if (has(col, a)) next.set(col, "a");
      else if (has(col, b)) next.set(col, "b");
    }
    setSide(next);
  };
  const cycle = (col: number) => {
    const next = new Map(side);
    const now = side.get(col);
    if (!now) next.set(col, "a");
    else if (now === "a") next.set(col, "b");
    else next.delete(col);
    setSide(next);
  };

  const a = samples.filter((c) => side.get(c) === "a");
  const b = samples.filter((c) => side.get(c) === "b");
  const nameA = patternA.trim() || "A";
  const nameB = patternB.trim() || "B";

  const run = async (what: string, job: () => Promise<Table>) => {
    setBusy(what);
    setError(null);
    try {
      onResult(await job());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (samples.length < 4)
    return <p className="muted">Comparing groups needs a table with one numeric column per sample, and at least four of them.</p>;
  if (!IN_APP) return <p className="muted">Built-in analyses run in the installed app.</p>;

  return (
    <>
      <div className="controls">
        <label>
          Group A: columns containing
          <input
            value={patternA}
            placeholder="e.g. Sham"
            autoCapitalize="none"
            onChange={(e) => (setPatternA(e.target.value), applyPatterns(e.target.value, patternB))}
          />
        </label>
        <label>
          Group B: columns containing
          <input
            value={patternB}
            placeholder="e.g. OV"
            autoCapitalize="none"
            onChange={(e) => (setPatternB(e.target.value), applyPatterns(patternA, e.target.value))}
          />
        </label>
      </div>
      <div className="muted small">Tap a sample to move it between no group, A and B.</div>
      <div className="sample-chips">
        {samples.map((col) => (
          <button key={col} type="button" className={`sample-chip ${side.get(col) ?? ""}`} onClick={() => cycle(col)}>
            {side.get(col) && <b>{side.get(col) === "a" ? "A" : "B"}</b>}
            {table.columns[col]}
          </button>
        ))}
      </div>
      <div className="controls">
        <label>
          The values are
          <select value={transform} onChange={(e) => setTransform(e.target.value as Transform)}>
            {TRANSFORMS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name rows by
          <select value={label} onChange={(e) => setLabel(Number(e.target.value))}>
            <option value={-1}>Row number</option>
            {table.columns.map((c, i) =>
              table.numeric[i] ? null : (
                <option key={i} value={i}>
                  {c}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <div className="row">
        <button
          className="button primary"
          disabled={busy !== null || a.length < 2 || b.length < 2}
          onClick={() => run("de", () => differentialExpression(table, { nameA, nameB, a, b }, transform, label))}
        >
          {busy === "de" ? "Comparing…" : `Compare ${nameB} (${b.length}) with ${nameA} (${a.length})`}
        </button>
        <button
          className="button"
          disabled={busy !== null}
          onClick={() => {
            const chosen = a.length + b.length >= 3 ? [...a, ...b] : samples;
            const group = (col: number) => (side.get(col) === "a" ? nameA : side.get(col) === "b" ? nameB : "No group");
            return run("pca", () => samplePca(table, chosen, group, transform));
          }}
        >
          {busy === "pca" ? "Working…" : `PCA of ${a.length + b.length >= 3 ? a.length + b.length : samples.length} samples`}
        </button>
      </div>
      {error && <div className="status error">{error}</div>}
      <p className="muted small">
        The comparison is a moderated t-test on log2 values (log2 counts per million for raw counts): each gene's variance is
        steadied by borrowing from other genes expressed at a similar level, the approach limma takes, which is what makes groups
        of three or four workable. P-values are Benjamini–Hochberg adjusted, and a positive log2FC means higher in {nameB}. It
        does not model paired samples or covariates, so use DESeq2, edgeR or limma for a result you intend to publish.
      </p>
    </>
  );
}

function ScriptEditor({
  script,
  table,
  onResult,
  onChanged,
  onClose,
}: {
  script: Script | null;
  table: Table;
  onResult: (t: Table) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(script?.name ?? "");
  const [description, setDescription] = useState(script?.description ?? "");
  const [code, setCode] = useState(script?.code ?? TEMPLATE);
  const [output, setOutput] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const edited = !script || code !== script.code || name !== script.name || description !== script.description;

  const run = async () => {
    // Code you typed or changed here is yours. Unchanged code from an imported file asks once.
    if (script && code === script.code && script.approved_code !== script.code) {
      const ok = await ask(
        `“${script.name}” came from an imported file and has not been run on this device. A script can read the open table; it cannot reach your library, files or the network. Run it?`,
      );
      if (!ok) return;
      await repo().approveScript(script.uid, script.code);
      onChanged();
    }
    setBusy(true);
    setOutput(null);
    try {
      const out = await runScript(name.trim() || "Script", code, table);
      setOutput({ text: out.log || (out.table ? "" : "The script finished without returning a table.") });
      if (out.table) onResult(out.table);
    } catch (e) {
      setOutput({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await repo().saveScript({ uid: script?.uid, name: name.trim(), description: description.trim(), code });
    onChanged();
    onClose();
  };

  return (
    <div className="card">
      <div className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          What it does
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          JavaScript
          <textarea
            className="code"
            value={code}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      </div>
      <div className="row">
        <button className="button primary" disabled={busy} onClick={run}>
          {busy ? "Running…" : "Run on this table"}
        </button>
        <button className="button" disabled={!edited || !name.trim() || !code.trim()} onClick={save}>
          Save
        </button>
        <button className="button" onClick={onClose}>
          Close
        </button>
        {script && (
          <button
            className="icon-btn"
            aria-label="Delete script"
            onClick={async () => {
              if (!(await ask(`Delete “${script.name}”?`))) return;
              await repo().removeScript(script.uid);
              onChanged();
              onClose();
            }}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
      {output && output.text && <pre className={`log ${output.error ? "error" : ""}`}>{output.text}</pre>}
    </div>
  );
}

function Scripts({ table, onResult }: { table: Table; onResult: (t: Table) => void }) {
  const scripts = useLoad(() => repo().scripts(), []);
  // A lesson can send you here with one of its scripts already open.
  const [open, setOpen] = useState<string | "new" | null>(() => viewer.pendingScript);
  useEffect(() => {
    viewer.pendingScript = null;
  }, []);

  return (
    <Await of={scripts}>
      {(list) => {
        const current = open && open !== "new" ? list.find((s) => s.uid === open) : null;
        if (open === "new" || current)
          return (
            <ScriptEditor
              key={open}
              script={current ?? null}
              table={table}
              onResult={onResult}
              onChanged={scripts.reload}
              onClose={() => setOpen(null)}
            />
          );
        return (
          <>
            {list.length > 0 && (
              <div className="list">
                {list.map((s) => (
                  <button key={s.uid} className="item" onClick={() => setOpen(s.uid)}>
                    <span className="item-main">
                      <span className="item-title">{s.name}</span>
                      <div className="item-meta">{s.description}</div>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button className="button" onClick={() => setOpen("new")}>
              <Icon name="plus" />
              &nbsp;New script
            </button>
          </>
        );
      }}
    </Await>
  );
}

/** Built-in analyses and your own scripts; each result opens as a new table. */
export function AnalyzePanel({ table, onResult }: { table: Table; onResult: (t: Table) => void }) {
  return (
    <>
      <h2 className="section-title">Compare groups of samples</h2>
      <Groups table={table} onResult={onResult} />
      <h2 className="section-title" style={{ marginTop: 20 }}>
        Scripts
      </h2>
      <p className="muted small">
        Short JavaScript programs that turn the open table into a new one. Results open as a table you can sort and plot.
      </p>
      <Scripts table={table} onResult={onResult} />
    </>
  );
}
