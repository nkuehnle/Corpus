import { useState } from "react";
import { checkAlerts, ensureNotificationPermission, notifyNewPapers, publishAlertPlan } from "../alerts";
import { setNcbiApiKey } from "../api/ncbi";
import { Back, errorText } from "../components/ui";
import { mergeFrom, type ImportSummary } from "../db/db";
import { IN_APP, exportMainDb, pickFile, withPickedDb } from "../platform";
import { repo, useLoad } from "../store";

/** Singular and plural names for what an import can bring in. */
const LABEL: Record<string, [string, string]> = {
  courses: ["study plan", "study plans"],
  lessons: ["lesson", "lessons"],
  papers: ["paper", "papers"],
  resources: ["library item", "library items"],
  datasets: ["dataset", "datasets"],
  searches: ["saved search", "saved searches"],
  scripts: ["analysis script", "analysis scripts"],
};

function describe(summary: ImportSummary): string {
  const shown = summary.tables.filter((t) => LABEL[t.name]);
  if (!shown.some((t) => t.added + t.updated)) return "That file had nothing to import.";
  const added = shown.filter((t) => t.added).map((t) => `${t.added} ${LABEL[t.name][t.added === 1 ? 0 : 1]}`);
  if (!added.length)
    return "Everything in that file was already here. Lesson text and details were refreshed; your progress and notes are unchanged.";
  return `Imported ${added.join(", ")}.`;
}

export default function SettingsPage() {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useLoad(() => repo().setting("ncbi_api_key"), []);
  const [draftKey, setDraftKey] = useState<string | null>(null);

  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await run();
      if (text) setMessage({ text });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const importDb = () =>
    act(async () => {
      const picked = await pickFile(["db", "sqlite", "sqlite3"]);
      if (!picked) return null;
      const summary = await withPickedDb(picked, (source) => mergeFrom(source, repo().db));
      await publishAlertPlan(repo());
      return describe(summary);
    });

  const exportDb = () => act(async () => ((await exportMainDb()) ? "Backup saved." : null));

  const checkNow = () =>
    act(async () => {
      if (!(await ensureNotificationPermission())) return "Notifications are turned off for Corpus in system settings.";
      const result = await checkAlerts(repo());
      await notifyNewPapers(result.found);
      if (result.errors.length) throw new Error(result.errors.join("\n"));
      const total = result.found.reduce((n, f) => n + f.count, 0);
      return total ? `${total} new papers. See Papers › Alerts.` : "No new papers since the last check.";
    });

  return (
    <div className="page">
      <Back label="Back" />
      <h1 className="page-title">Settings</h1>
      {message && <div className={`status ${message.error ? "error" : ""}`}>{message.text}</div>}

      <div className="card">
        <div className="card-title">Import and back up</div>
        <p className="muted small">
          Import a Corpus database file to add its study plans, papers, library items and datasets. Importing a newer version of
          a plan updates it in place: nothing is duplicated, lessons it no longer has are removed, and your progress, notes
          and stars are kept.
        </p>
        {IN_APP ? (
          <div className="row">
            <button className="button primary" disabled={busy} onClick={importDb}>
              Import a database file
            </button>
            <button className="button" disabled={busy} onClick={exportDb}>
              Save a backup
            </button>
          </div>
        ) : (
          <p className="muted small">Importing needs the installed app.</p>
        )}
      </div>

      <div className="card">
        <div className="card-title">New paper alerts</div>
        <p className="muted small">
          Corpus checks your alerts when it opens and every few hours while it is running, and on Android about twice a day in the
          background.
        </p>
        <button className="button" disabled={busy || !IN_APP} onClick={checkNow}>
          Check now
        </button>
      </div>

      <div className="card">
        <div className="card-title">NCBI API key</div>
        <p className="muted small">
          Optional. A free key from your NCBI account settings lets Corpus search faster (10 requests a second, up from 3).
        </p>
        <form
          className="search-bar"
          style={{ marginBottom: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const value = (draftKey ?? "").trim();
              await repo().setSetting("ncbi_api_key", value);
              setNcbiApiKey(value);
              await publishAlertPlan(repo());
              return value ? "API key saved." : "API key removed.";
            });
          }}
        >
          <input
            value={draftKey ?? key.data ?? ""}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder="No key set"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button className="button" disabled={busy || draftKey === null}>
            Save
          </button>
        </form>
      </div>
    </div>
  );
}
