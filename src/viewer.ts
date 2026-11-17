import { readTables, type Table } from "./data/table";
import { navigate } from "./store";

/** What the Data tab is showing. Lives outside React so any screen can hand it a file. */
export const viewer: { title: string; tables: Table[]; pendingScript: string | null } = {
  title: "",
  tables: [],
  /** A script a lesson asked to open; the Data tab shows it once a table is open. */
  pendingScript: null,
};

/** Larger files are not parsed: the whole table has to fit in memory. They can still be
 *  downloaded (archives are read entry by entry). */
export const MAX_TABLE_BYTES = 100 * 1024 * 1024;

export function showLoadedTables(title: string, tables: Table[]) {
  if (!tables.length) throw new Error("No tables found in that file.");
  viewer.title = title;
  viewer.tables = tables;
  navigate("/data");
}

export function showTables(title: string, name: string, bytes: Uint8Array) {
  showLoadedTables(title, readTables(name, bytes));
}
