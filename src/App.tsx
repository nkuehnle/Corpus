import { useEffect, useState } from "react";
import { checkAlerts, notifyNewPapers } from "./alerts";
import { Icon } from "./components/ui";
import DataPage from "./pages/DataPage";
import { DatasetPage, DatasetsPage } from "./pages/DatasetsPage";
import { CoursePage, LearnPage, LessonPage } from "./pages/LearnPage";
import { LibraryPage, ResourcePage } from "./pages/LibraryPage";
import { AlertPage, PaperPage, PapersPage } from "./pages/PapersPage";
import PdfPage from "./pages/PdfPage";
import SettingsPage from "./pages/SettingsPage";
import { openExternal } from "./platform";
import { initRepo, repo, useRoute } from "./store";

const TABS = [
  { id: "learn", label: "Learn" },
  { id: "papers", label: "Papers" },
  { id: "datasets", label: "Datasets" },
  { id: "library", label: "Library" },
  { id: "data", label: "Data" },
];
// Detail routes and the tab they belong to.
const TAB_OF: Record<string, string> = {
  course: "learn",
  lesson: "learn",
  paper: "papers",
  alert: "papers",
  dataset: "datasets",
  resource: "library",
  pdf: "library",
  settings: "learn",
};

const ALERT_INTERVAL_MS = 3 * 60 * 60 * 1000;

function Page({ route }: { route: string }) {
  const [, head, ...rest] = route.split("/");
  const arg = decodeURIComponent(rest.join("/"));
  switch (head) {
    case "course":
      return <CoursePage uid={arg} />;
    case "lesson":
      return <LessonPage key={arg} uid={arg} />;
    case "papers":
      return <PapersPage tab={arg} />;
    case "paper":
      return <PaperPage key={arg} pmid={arg} />;
    case "alert":
      return <AlertPage uid={arg} />;
    case "datasets":
      return <DatasetsPage tab={arg} />;
    case "dataset":
      return <DatasetPage key={arg} uid={arg} />;
    case "library":
      return <LibraryPage />;
    case "resource":
      return <ResourcePage key={arg} uid={arg} />;
    case "pdf":
      return <PdfPage key={arg} uid={arg} />;
    case "data":
      return <DataPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <LearnPage />;
  }
}

export default function App() {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    initRepo().then(
      () => setReady(true),
      (e) => setFailure(String(e)),
    );
  }, []);

  // Look for new papers at launch and every few hours while the app stays open.
  useEffect(() => {
    if (!ready) return;
    const run = async () => {
      const result = await checkAlerts(repo());
      await notifyNewPapers(result.found);
      setUnseen(await repo().unseenTotal());
    };
    void run();
    const timer = setInterval(run, ALERT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ready]);

  useEffect(() => {
    if (ready) void repo().unseenTotal().then(setUnseen);
  }, [ready, route]);

  // Web links in lesson text and abstracts open in the browser, not inside the app.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !/^https?:/.test(a.getAttribute("href")!)) return;
      e.preventDefault();
      openExternal(a.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  if (failure) return <div className="main status error">Could not open the database: {failure}</div>;
  if (!ready) return <div className="main status">Opening…</div>;

  const head = route.split("/")[1] || "learn";
  const tab = TAB_OF[head] ?? head;
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Corpus</div>
        {TABS.map((t) => (
          <a key={t.id} href={`#/${t.id}`} className={`nav-item ${tab === t.id ? "active" : ""}`}>
            <Icon name={t.id} />
            {t.label}
            {t.id === "papers" && unseen > 0 && <span className="badge">{unseen > 99 ? "99+" : unseen}</span>}
          </a>
        ))}
      </nav>
      <main className="main">
        <Page route={route} />
      </main>
    </div>
  );
}
