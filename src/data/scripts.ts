import { makeTable, type Table } from "./table";

/** What a script starts from when you create one. */
export const TEMPLATE = `// "table" is the open table: { name, columns, rows, numeric }.
// column("name") returns one column as an array.
// Return { columns, rows } to make a new table, or an array of objects.
// console.log(...) prints below the script.

const values = column(table.columns[1]).filter((v) => typeof v === "number");
const mean = values.reduce((a, b) => a + b, 0) / values.length;
console.log("mean of", table.columns[1], "=", mean);

return table.rows.slice(0, 20).map((row) => ({ [table.columns[0]]: row[0], value: row[1] }));
`;

export interface ScriptOutput {
  /** The table the script returned, if it returned one. */
  table: Table | null;
  /** Anything it printed with console.log. */
  log: string;
}

const TIMEOUT_MS = 60_000;

/** The worker's whole program: the user's code is pasted into an async function body, so no
 *  eval is needed. Workers have no access to the page, the database or the Tauri bridge, and
 *  the app's content security policy stops them from making network requests. */
function workerSource(code: string): string {
  return `
const lines = [];
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));
console.log = (...args) => lines.push(args.map(show).join(" "));
self.onmessage = async (event) => {
  const table = event.data;
  const column = (which) => {
    const i = typeof which === "number" ? which : table.columns.indexOf(which);
    if (i < 0 || i >= table.columns.length) throw new Error('There is no column "' + which + '".');
    return table.rows.map((row) => row[i]);
  };
  try {
    const result = await (async function (table, column) {
${code}
    })(table, column);
    self.postMessage({ result, lines });
  } catch (error) {
    self.postMessage({ error: String((error && error.message) || error), lines });
  }
};`;
}

/** Turns whatever a script returned into a table: { columns, rows } or an array of objects. */
export function resultTable(name: string, result: unknown): Table | null {
  if (result == null) return null;
  if (Array.isArray(result)) {
    if (!result.length) throw new Error("The script returned an empty list.");
    if (typeof result[0] !== "object" || result[0] === null || Array.isArray(result[0]))
      throw new Error('To return a list, make each item an object such as { gene: "MSTN", value: 1.2 }.');
    const columns = [...new Set(result.flatMap((row) => Object.keys(row as object)))];
    return makeTable(
      name,
      columns,
      result.map((row) => columns.map((c) => (row as Record<string, unknown>)[c])),
    );
  }
  const { columns, rows, name: given } = result as { columns?: unknown; rows?: unknown; name?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(rows) || rows.some((r) => !Array.isArray(r)))
    throw new Error("Return { columns: [...], rows: [[...], ...] } or an array of objects.");
  return makeTable(typeof given === "string" ? given : name, columns.map(String), rows as unknown[][]);
}

/** Runs a script on a table in a worker and returns what it produced. */
export function runScript(name: string, code: string, table: Table): Promise<ScriptOutput> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerSource(code)], { type: "text/javascript" }));
    const worker = new Worker(url);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("The script ran for a minute without finishing, so it was stopped."));
    }, TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ result?: unknown; error?: string; lines: string[] }>) => {
      finish();
      const log = event.data.lines.join("\n");
      if (event.data.error) return reject(new Error(log ? `${event.data.error}\n\n${log}` : event.data.error));
      try {
        resolve({ table: resultTable(`${name} · ${table.name}`, event.data.result), log });
      } catch (e) {
        reject(e);
      }
    };
    // Syntax errors surface here, before the script starts.
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The script could not be started."));
    };
    worker.postMessage({ name: table.name, columns: table.columns, rows: table.rows, numeric: table.numeric });
  });
}
