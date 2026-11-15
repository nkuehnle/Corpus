import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { searchPubmed, summarize } from "./api/pubmed";
import { today, type Repo, type Search } from "./db/repo";
import { IN_APP, writeStoredText } from "./platform";

/** Looks for papers added to PubMed since a search was last checked and records the ones
 *  not seen before. Returns how many were new. */
export async function checkSearch(repo: Repo, search: Search): Promise<number> {
  // Papers entered earlier on the day of the last check come back too; `known` filters them out.
  const page = await searchPubmed(search.query, { enteredSince: search.last_checked ?? today(), max: 100, sort: "pub_date" });
  const known = await repo.knownHits(search.uid);
  const fresh = page.pmids.filter((p) => !known.has(p));
  for (const paper of await summarize(fresh)) await repo.addHit(search.uid, paper);
  await repo.updateSearch(search.uid, { last_checked: today() });
  return fresh.length;
}

export interface CheckResult {
  found: { name: string; count: number }[];
  errors: string[];
}

/** Checks every search that has alerts turned on. */
export async function checkAlerts(repo: Repo): Promise<CheckResult> {
  const result: CheckResult = { found: [], errors: [] };
  for (const search of await repo.searches()) {
    if (!search.notify) continue;
    try {
      const count = await checkSearch(repo, search);
      if (count) result.found.push({ name: search.name, count });
    } catch (e) {
      result.errors.push(`${search.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  await publishAlertPlan(repo);
  return result;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!IN_APP) return false;
  return (await isPermissionGranted()) || (await requestPermission()) === "granted";
}

export async function notifyNewPapers(found: CheckResult["found"]): Promise<void> {
  if (!found.length || !(await ensureNotificationPermission())) return;
  const total = found.reduce((n, f) => n + f.count, 0);
  sendNotification({
    title: total === 1 ? "1 new paper" : `${total} new papers`,
    body: found.map((f) => `${f.name}: ${f.count}`).join("\n"),
  });
}

/** Writes the list of alert searches where the Android background worker reads it. */
export async function publishAlertPlan(repo: Repo): Promise<void> {
  if (!IN_APP) return;
  const searches = [];
  for (const s of await repo.searches()) {
    if (!s.notify) continue;
    // `known` stops the worker from announcing papers that are already listed in the app.
    const known = [...(await repo.knownHits(s.uid))];
    searches.push({ uid: s.uid, name: s.name, query: s.query, since: s.last_checked ?? today(), known });
  }
  const apiKey = (await repo.setting("ncbi_api_key")) ?? "";
  await writeStoredText("alerts.json", JSON.stringify({ apiKey, searches }));
}
