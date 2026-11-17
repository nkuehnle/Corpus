import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appConfigDir, appDataDir, join } from "@tauri-apps/api/path";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { exists, mkdir, readFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Database from "@tauri-apps/plugin-sql";
import type { Db, Value } from "./db/db";

/** True inside the app; false when the UI runs in a plain browser against the Vite dev server. */
export const IN_APP = "__TAURI_INTERNALS__" in window;
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// ---- HTTP: the app fetches through Rust (no CORS); the browser goes through the dev proxy.
export async function http(url: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  const res = IN_APP
    ? await tauriFetch(url, { method })
    : await fetch(`/__fetch?method=${method}&url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res;
}

// ---- Database
function tauriDb(handle: Database): Db {
  return {
    select: <T>(sql: string, params: Value[] = []) => handle.select<T[]>(sql, params),
    execute: async (sql, params = []) => void (await handle.execute(sql, params)),
  };
}

function devDb(name: string): Db {
  const call = async (kind: string, sql: string, params: Value[]) => {
    const res = await fetch("/__db", { method: "POST", body: JSON.stringify({ name, kind, sql, params }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };
  return {
    select: (sql, params = []) => call("select", sql, params),
    execute: async (sql, params = []) => void (await call("execute", sql, params)),
  };
}

export async function openMainDb(): Promise<Db> {
  return IN_APP ? tauriDb(await Database.load("sqlite:corpus.db")) : devDb("corpus.db");
}

// ---- Files. Imported files live under the app data directory, addressed by relative name.
async function dataPath(name: string): Promise<string> {
  const dir = await appDataDir();
  const full = await join(dir, name);
  const parent = await join(full, "..");
  if (!(await exists(parent))) await mkdir(parent, { recursive: true });
  return full;
}

export interface Picked {
  /** Path on desktop, content:// URI on Android. */
  location: string;
  name: string;
}

export async function pickFile(extensions?: string[]): Promise<Picked | null> {
  // Android's picker filters by MIME type and hides files it can't classify, so no filter there.
  const filters = extensions && !IS_ANDROID ? [{ name: "Files", extensions }] : undefined;
  const location = await open({ multiple: false, filters });
  if (!location) return null;
  const tail =
    decodeURIComponent(location)
      .split(/[/\\:]/)
      .pop() || "file";
  return { location, name: tail };
}

/** Copies a picked file into app storage and returns its relative name. */
export async function importFile(picked: Picked, name: string): Promise<string> {
  await invoke("copy_any", { src: picked.location, dest: await dataPath(name) });
  return name;
}

// In a plain browser there is no app storage; downloads are kept in memory for the session.
const devStore = new Map<string, Uint8Array>();

export async function readStored(name: string): Promise<Uint8Array> {
  if (!IN_APP) {
    const bytes = devStore.get(name);
    if (!bytes) throw new Error(`${name} is not stored`);
    return bytes;
  }
  return readFile(await dataPath(name));
}

/** Removes a stored file, or a directory of them. */
export async function removeStored(name: string): Promise<void> {
  if (!IN_APP) {
    for (const key of devStore.keys()) if (key === name || key.startsWith(`${name}/`)) devStore.delete(key);
    return;
  }
  await invoke("remove_stored", { name });
}

/** Downloads a file into app storage (streamed to disk, so size is not limited by memory)
 *  and returns its size. Progress arrives through onDownloadProgress, tagged with `id`. */
export async function downloadToStore(url: string, name: string, id: string): Promise<number> {
  if (IN_APP) return invoke<number>("download_file", { url, name, id });
  const bytes = new Uint8Array(await (await http(url)).arrayBuffer());
  devStore.set(name, bytes);
  return bytes.length;
}

export interface DownloadProgress {
  id: string;
  received: number;
  total: number | null;
}

export function onDownloadProgress(handler: (p: DownloadProgress) => void): () => void {
  if (!IN_APP) return () => {};
  const stop = listen<DownloadProgress>("download-progress", (e) => handler(e.payload));
  return () => void stop.then((unlisten) => unlisten());
}

/** The files in a stored tar archive. Needs the app: archives can be gigabytes. */
export async function tarList(name: string): Promise<{ name: string; size: number }[]> {
  if (!IN_APP) throw new Error("Archives can be opened in the installed app.");
  return invoke("tar_list", { name });
}

/** Extracts entries of a stored archive into directory `into`; returns their stored names. */
export function tarExtract(name: string, entries: string[], into: string): Promise<string[]> {
  return invoke("tar_extract", { name, entries, into });
}

/** URL the WebView can load a stored file from (supports range requests, so big PDFs stream). */
export async function storedUrl(name: string): Promise<string> {
  return convertFileSrc(await dataPath(name));
}

export async function writeStoredText(name: string, text: string): Promise<void> {
  await writeTextFile(await dataPath(name), text);
}

/** Opens a picked database file next to the main one so it can be merged, then cleans up. */
export async function withPickedDb<T>(picked: Picked, use: (db: Db) => Promise<T>): Promise<T> {
  const name = "import-tmp.db";
  const dest = await join(await appConfigDir(), name);
  await invoke("copy_any", { src: picked.location, dest });
  const handle = await Database.load(`sqlite:${name}`);
  try {
    return await use(tauriDb(handle));
  } finally {
    // close() with no argument would close every database, the main one included.
    await handle.close(handle.path);
    await remove(dest);
  }
}

/** Saves a copy of the main database where the user chooses. Returns false if cancelled. */
export async function exportMainDb(): Promise<boolean> {
  const dest = await save({ defaultPath: "corpus-backup.db" });
  if (!dest) return false;
  await invoke("copy_any", { src: await join(await appConfigDir(), "corpus.db"), dest });
  return true;
}

export function openExternal(url: string): void {
  if (IN_APP) void openUrl(url);
  else window.open(url, "_blank");
}
