import { useCallback, useEffect, useState } from "react";
import { setNcbiApiKey } from "./api/ncbi";
import { migrate } from "./db/db";
import { Repo } from "./db/repo";
import { openMainDb } from "./platform";

let instance: Repo | null = null;

export async function initRepo(): Promise<Repo> {
  const db = await openMainDb();
  await migrate(db);
  instance = new Repo(db);
  setNcbiApiKey((await instance.setting("ncbi_api_key")) ?? "");
  return instance;
}

export function repo(): Repo {
  if (!instance) throw new Error("database not open");
  return instance;
}

// Routes live in the URL hash so Android's back button and desktop history work.
export function navigate(path: string) {
  window.location.hash = path;
}

export function useRoute(): string {
  const read = () => window.location.hash.replace(/^#/, "") || "/learn";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Runs an async loader when `deps` change. A slow earlier call never overwrites a later one. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => current && setState({ data, error: null, loading: false }),
      (e) => current && setState({ data: undefined, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Things fetched from the network that a detail page needs but that aren't saved yet. */
export const cache = {
  papers: new Map<string, import("./api/pubmed").PaperSummary>(),
  datasets: new Map<string, import("./api/datasets").DatasetSummary>(),
};
