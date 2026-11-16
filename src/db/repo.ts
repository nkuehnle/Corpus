import type { DatasetSummary } from "../api/datasets";
import type { PaperSummary } from "../api/pubmed";
import type { Db, Value } from "./db";

export type PaperStatus = "unread" | "reading" | "read";

export interface Paper {
  uid: string;
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
  title: string;
  authors: string;
  journal: string;
  pub_date: string;
  abstract: string | null;
  status: PaperStatus;
  starred: number;
  notes: string;
  added_at: string;
}

export interface Search {
  uid: string;
  name: string;
  query: string;
  notify: number;
  created_at: string;
  last_checked: string | null;
  /** Hits found by alert checks that haven't been looked at yet. */
  unseen: number;
}

export interface Hit {
  search_uid: string;
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  pub_date: string;
  found_at: string;
  seen: number;
}

export interface Dataset {
  uid: string;
  source: string;
  accession: string;
  title: string;
  summary: string;
  organism: string;
  kind: string;
  n_samples: number | null;
  url: string;
  pmid: string | null;
  notes: string;
  added_at: string;
}

export type ResourceKind = "video" | "link" | "textbook" | "pdf";

export interface Resource {
  uid: string;
  kind: ResourceKind;
  title: string;
  url: string | null;
  /** Name of the imported file in app storage, if any. */
  file: string | null;
  author: string;
  description: string;
  /** Where you left off: a page number for PDFs. */
  position: string | null;
  added_at: string;
}

export interface Course {
  uid: string;
  title: string;
  description: string;
  lessons: number;
  done: number;
}

export interface Module {
  uid: string;
  course_uid: string;
  title: string;
  summary: string;
}

export interface Lesson {
  uid: string;
  module_uid: string;
  position: number;
  title: string;
  minutes: number;
  objectives: string;
  body: string;
  questions: string;
  done_at: string | null;
  notes: string;
}

export interface Script {
  uid: string;
  name: string;
  description: string;
  code: string;
  /** The code as it was when you last agreed to run it; null for a script you have never run. */
  approved_code: string | null;
  added_at: string;
}

export type ItemKind = "paper" | "resource" | "dataset" | "search" | "script";

export interface LessonItem {
  uid: string;
  kind: ItemKind;
  ref_uid: string;
  note: string;
  /** Title of the thing pointed at; null when it is missing from this database. */
  title: string | null;
  /** Authors and year, resource kind, accession or query, depending on the kind. */
  detail: string | null;
}

export const now = () => new Date().toISOString();
/** Today's date where PubMed is (US Eastern), as YYYY-MM-DD. PubMed stamps new records with
 *  its own local date, so alert checks have to count days the same way it does. */
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
export const newUid = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
export const paperUid = (pmid: string) => `pmid:${pmid}`;
export const datasetUid = (d: { source: string; accession: string }) => `${d.source.toLowerCase()}:${d.accession}`;

export class Repo {
  constructor(readonly db: Db) {}

  private async one<T>(sql: string, params: Value[] = []): Promise<T | null> {
    return (await this.db.select<T>(sql, params))[0] ?? null;
  }

  // ---- Settings
  async setting(key: string): Promise<string | null> {
    return (await this.one<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [key]))?.value ?? null;
  }
  setSetting(key: string, value: string) {
    return this.db.execute(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  }

  // ---- Papers
  papers(): Promise<Paper[]> {
    return this.db.select<Paper>(`SELECT * FROM papers ORDER BY added_at DESC`);
  }
  paper(uid: string): Promise<Paper | null> {
    return this.one<Paper>(`SELECT * FROM papers WHERE uid = ?`, [uid]);
  }
  async savePaper(p: PaperSummary, abstract: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO papers (uid, pmid, pmcid, doi, title, authors, journal, pub_date, abstract, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (uid) DO NOTHING`,
      [paperUid(p.pmid), p.pmid, p.pmcid, p.doi, p.title, p.authors, p.journal, p.pubDate, abstract, now()],
    );
  }
  updatePaper(uid: string, fields: Partial<Pick<Paper, "status" | "starred" | "notes" | "abstract" | "pmcid">>) {
    return this.update("papers", uid, fields);
  }
  removePaper(uid: string) {
    return this.db.execute(`DELETE FROM papers WHERE uid = ?`, [uid]);
  }

  // ---- Saved searches and alert hits
  searches(): Promise<Search[]> {
    return this.db.select<Search>(
      `SELECT s.*, (SELECT COUNT(*) FROM search_hits h WHERE h.search_uid = s.uid AND h.seen = 0) AS unseen
       FROM searches s ORDER BY s.notify DESC, s.name`,
    );
  }
  search(uid: string): Promise<Search | null> {
    return this.one<Search>(`SELECT s.*, 0 AS unseen FROM searches s WHERE uid = ?`, [uid]);
  }
  async addSearch(name: string, query: string): Promise<string> {
    const uid = newUid("search");
    await this.db.execute(`INSERT INTO searches (uid, name, query, notify, created_at, last_checked) VALUES (?, ?, ?, 1, ?, ?)`, [
      uid,
      name,
      query,
      now(),
      today(),
    ]);
    return uid;
  }
  updateSearch(uid: string, fields: Partial<Pick<Search, "name" | "query" | "notify" | "last_checked">>) {
    return this.update("searches", uid, fields);
  }
  async removeSearch(uid: string): Promise<void> {
    await this.db.execute(`DELETE FROM search_hits WHERE search_uid = ?`, [uid]);
    await this.db.execute(`DELETE FROM lesson_items WHERE kind = 'search' AND ref_uid = ?`, [uid]);
    await this.db.execute(`DELETE FROM searches WHERE uid = ?`, [uid]);
  }
  hits(searchUid: string): Promise<Hit[]> {
    return this.db.select<Hit>(`SELECT * FROM search_hits WHERE search_uid = ? ORDER BY found_at DESC, pmid DESC`, [searchUid]);
  }
  async knownHits(searchUid: string): Promise<Set<string>> {
    const rows = await this.db.select<{ pmid: string }>(`SELECT pmid FROM search_hits WHERE search_uid = ?`, [searchUid]);
    return new Set(rows.map((r) => r.pmid));
  }
  addHit(searchUid: string, p: PaperSummary) {
    return this.db.execute(
      `INSERT OR IGNORE INTO search_hits (search_uid, pmid, title, authors, journal, pub_date, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [searchUid, p.pmid, p.title, p.authors, p.journal, p.pubDate, now()],
    );
  }
  /** Turns alerts on for every saved search that has them off, starting from today. */
  followAllSearches() {
    return this.db.execute(`UPDATE searches SET notify = 1, last_checked = ? WHERE notify = 0`, [today()]);
  }
  markHitsSeen(searchUid: string) {
    return this.db.execute(`UPDATE search_hits SET seen = 1 WHERE search_uid = ?`, [searchUid]);
  }
  async unseenTotal(): Promise<number> {
    return (await this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM search_hits WHERE seen = 0`))!.n;
  }

  // ---- Datasets
  datasets(): Promise<Dataset[]> {
    return this.db.select<Dataset>(`SELECT * FROM datasets ORDER BY added_at DESC`);
  }
  dataset(uid: string): Promise<Dataset | null> {
    return this.one<Dataset>(`SELECT * FROM datasets WHERE uid = ?`, [uid]);
  }
  saveDataset(d: DatasetSummary) {
    return this.db.execute(
      `INSERT INTO datasets (uid, source, accession, title, summary, organism, kind, n_samples, url, pmid, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (uid) DO NOTHING`,
      [datasetUid(d), d.source, d.accession, d.title, d.summary, d.organism, d.kind, d.samples, d.url, d.pmid, now()],
    );
  }
  updateDataset(uid: string, fields: Partial<Pick<Dataset, "notes">>) {
    return this.update("datasets", uid, fields);
  }
  removeDataset(uid: string) {
    return this.db.execute(`DELETE FROM datasets WHERE uid = ?`, [uid]);
  }

  // ---- Resources
  resources(): Promise<Resource[]> {
    return this.db.select<Resource>(`SELECT * FROM resources ORDER BY added_at DESC, title`);
  }
  resource(uid: string): Promise<Resource | null> {
    return this.one<Resource>(`SELECT * FROM resources WHERE uid = ?`, [uid]);
  }
  addResource(r: Omit<Resource, "added_at" | "position">) {
    return this.db.execute(
      `INSERT INTO resources (uid, kind, title, url, file, author, description, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.uid, r.kind, r.title, r.url, r.file, r.author, r.description, now()],
    );
  }
  updateResource(uid: string, fields: Partial<Omit<Resource, "uid" | "added_at">>) {
    return this.update("resources", uid, fields);
  }
  async removeResource(uid: string): Promise<void> {
    await this.db.execute(`DELETE FROM lesson_items WHERE kind = 'resource' AND ref_uid = ?`, [uid]);
    await this.db.execute(`DELETE FROM resources WHERE uid = ?`, [uid]);
  }

  // ---- Analysis scripts
  scripts(): Promise<Script[]> {
    return this.db.select<Script>(`SELECT * FROM scripts ORDER BY name`);
  }
  script(uid: string): Promise<Script | null> {
    return this.one<Script>(`SELECT * FROM scripts WHERE uid = ?`, [uid]);
  }
  /** Saves a script you wrote or edited yourself, which counts as agreeing to run it. */
  async saveScript(script: Pick<Script, "name" | "description" | "code"> & { uid?: string }): Promise<string> {
    const uid = script.uid ?? newUid("script");
    await this.db.execute(
      `INSERT INTO scripts (uid, name, description, code, approved_code, added_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET name = excluded.name, description = excluded.description,
         code = excluded.code, approved_code = excluded.approved_code`,
      [uid, script.name, script.description, script.code, script.code, now()],
    );
    return uid;
  }
  approveScript(uid: string, code: string) {
    return this.db.execute(`UPDATE scripts SET approved_code = ? WHERE uid = ?`, [code, uid]);
  }
  async removeScript(uid: string): Promise<void> {
    await this.db.execute(`DELETE FROM lesson_items WHERE kind = 'script' AND ref_uid = ?`, [uid]);
    await this.db.execute(`DELETE FROM scripts WHERE uid = ?`, [uid]);
  }

  // ---- Study plans
  courses(): Promise<Course[]> {
    return this.db.select<Course>(
      `SELECT c.uid, c.title, c.description, COUNT(l.uid) AS lessons, COUNT(l.done_at) AS done
       FROM courses c
       LEFT JOIN modules m ON m.course_uid = c.uid
       LEFT JOIN lessons l ON l.module_uid = m.uid
       GROUP BY c.uid ORDER BY c.position, c.title`,
    );
  }
  course(uid: string): Promise<Course | null> {
    return this.one<Course>(`SELECT uid, title, description, 0 AS lessons, 0 AS done FROM courses WHERE uid = ?`, [uid]);
  }
  modules(courseUid: string): Promise<Module[]> {
    return this.db.select<Module>(`SELECT * FROM modules WHERE course_uid = ? ORDER BY position`, [courseUid]);
  }
  /** Every lesson of a course in study order. */
  lessons(courseUid: string): Promise<Lesson[]> {
    return this.db.select<Lesson>(
      `SELECT l.* FROM lessons l JOIN modules m ON m.uid = l.module_uid
       WHERE m.course_uid = ? ORDER BY m.position, l.position`,
      [courseUid],
    );
  }
  lesson(uid: string): Promise<Lesson | null> {
    return this.one<Lesson>(`SELECT * FROM lessons WHERE uid = ?`, [uid]);
  }
  async lessonCourse(lessonUid: string): Promise<string | null> {
    const row = await this.one<{ course_uid: string }>(
      `SELECT m.course_uid FROM lessons l JOIN modules m ON m.uid = l.module_uid WHERE l.uid = ?`,
      [lessonUid],
    );
    return row?.course_uid ?? null;
  }
  updateLesson(uid: string, fields: Partial<Pick<Lesson, "done_at" | "notes">>) {
    return this.update("lessons", uid, fields);
  }
  lessonItems(lessonUid: string): Promise<LessonItem[]> {
    return this.db.select<LessonItem>(
      `SELECT i.uid, i.kind, i.ref_uid, i.note,
         COALESCE(p.title, r.title, d.title, s.name, x.name) AS title,
         CASE i.kind
           WHEN 'paper' THEN p.authors || ' · ' || p.journal || ' ' || substr(p.pub_date, 1, 4)
             || CASE WHEN p.pmcid IS NULL THEN '' ELSE ' · free full text' END
           WHEN 'resource' THEN r.kind || CASE WHEN r.author = '' THEN '' ELSE ' · ' || r.author END
           WHEN 'dataset' THEN d.source || ' ' || d.accession
           WHEN 'search' THEN s.query
           WHEN 'script' THEN x.description END AS detail
       FROM lesson_items i
       LEFT JOIN papers p ON i.kind = 'paper' AND p.uid = i.ref_uid
       LEFT JOIN resources r ON i.kind = 'resource' AND r.uid = i.ref_uid
       LEFT JOIN datasets d ON i.kind = 'dataset' AND d.uid = i.ref_uid
       LEFT JOIN searches s ON i.kind = 'search' AND s.uid = i.ref_uid
       LEFT JOIN scripts x ON i.kind = 'script' AND x.uid = i.ref_uid
       WHERE i.lesson_uid = ? ORDER BY i.position`,
      [lessonUid],
    );
  }
  async addLessonItem(lessonUid: string, kind: ItemKind, refUid: string): Promise<void> {
    const next = await this.one<{ n: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM lesson_items WHERE lesson_uid = ?`,
      [lessonUid],
    );
    await this.db.execute(`INSERT INTO lesson_items (uid, lesson_uid, position, kind, ref_uid) VALUES (?, ?, ?, ?, ?)`, [
      newUid("item"),
      lessonUid,
      next!.n,
      kind,
      refUid,
    ]);
  }
  removeLessonItem(uid: string) {
    return this.db.execute(`DELETE FROM lesson_items WHERE uid = ?`, [uid]);
  }
  async removeCourse(uid: string): Promise<void> {
    const inCourse = `SELECT l.uid FROM lessons l JOIN modules m ON m.uid = l.module_uid WHERE m.course_uid = ?`;
    await this.db.execute(`DELETE FROM lesson_items WHERE lesson_uid IN (${inCourse})`, [uid]);
    await this.db.execute(`DELETE FROM lessons WHERE module_uid IN (SELECT uid FROM modules WHERE course_uid = ?)`, [uid]);
    await this.db.execute(`DELETE FROM modules WHERE course_uid = ?`, [uid]);
    await this.db.execute(`DELETE FROM courses WHERE uid = ?`, [uid]);
  }

  private update(table: string, uid: string, fields: Record<string, Value | undefined>) {
    const cols = Object.keys(fields);
    return this.db.execute(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE uid = ?`, [
      ...cols.map((c) => fields[c] ?? null),
      uid,
    ]);
  }
}
