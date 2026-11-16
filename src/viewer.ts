import { download, type RemoteFile } from "./api/supplements";
import { readTables, type Table } from "./data/table";
import { navigate } from "./store";

/** What the Data tab is showing. Lives outside React so any screen can hand it a file. */
export const viewer: { title: string; tables: Table[]; pendingScript: string | null } = {
  title: "",
  tables: [],
  /** A script a lesson asked to open; the Data tab shows it once a table is open. */
  pendingScript: null,
};

/** Larger downloads than this are refused: the whole file has to fit in memory to be parsed. */
export const MAX_DOWNLOAD = 60 * 1024 * 1024;

export function showTables(title: string, name: string, bytes: Uint8Array) {
  const tables = readTables(name, bytes);
  if (!tables.length) throw new Error("No tables found in that file.");
  viewer.title = title;
  viewer.tables = tables;
  navigate("/data");
}

export async function openRemote(file: RemoteFile, title: string) {
  showTables(title, file.name, await download(file));
}
