/** Every row is keyed by a stable text `uid`, and rows point at each other by uid.
 *  That makes merging another Corpus database a plain upsert with no id remapping. */
export const SCHEMA_VERSION = 4;

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE papers (
      uid TEXT PRIMARY KEY,
      pmid TEXT, pmcid TEXT, doi TEXT,
      title TEXT NOT NULL,
      authors TEXT NOT NULL DEFAULT '',
      journal TEXT NOT NULL DEFAULT '',
      pub_date TEXT NOT NULL DEFAULT '',
      abstract TEXT,
      status TEXT NOT NULL DEFAULT 'unread',
      starred INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL)`,
    `CREATE TABLE searches (
      uid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      notify INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_checked TEXT)`,
    `CREATE TABLE search_hits (
      search_uid TEXT NOT NULL,
      pmid TEXT NOT NULL,
      title TEXT NOT NULL,
      authors TEXT NOT NULL DEFAULT '',
      journal TEXT NOT NULL DEFAULT '',
      pub_date TEXT NOT NULL DEFAULT '',
      found_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (search_uid, pmid))`,
    `CREATE TABLE datasets (
      uid TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      accession TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      organism TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      n_samples INTEGER,
      url TEXT NOT NULL DEFAULT '',
      pmid TEXT,
      notes TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL)`,
    `CREATE TABLE resources (
      uid TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      file TEXT,
      author TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      position TEXT,
      added_at TEXT NOT NULL)`,
    `CREATE TABLE courses (
      uid TEXT PRIMARY KEY,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE modules (
      uid TEXT PRIMARY KEY,
      course_uid TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE lessons (
      uid TEXT PRIMARY KEY,
      module_uid TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      objectives TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      questions TEXT NOT NULL DEFAULT '',
      done_at TEXT,
      notes TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE lesson_items (
      uid TEXT PRIMARY KEY,
      lesson_uid TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL,
      ref_uid TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '')`,
    `CREATE INDEX lesson_items_lesson ON lesson_items (lesson_uid, position)`,
    `CREATE INDEX lessons_module ON lessons (module_uid, position)`,
  ],
  [
    // Analysis scripts for the data viewer. `approved_code` is the version of the code the
    // user has agreed to run; a script whose code differs asks before it runs.
    `CREATE TABLE scripts (
      uid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL,
      approved_code TEXT,
      added_at TEXT NOT NULL)`,
  ],
  [
    // Files downloaded into app storage, per dataset or paper. Local to this device, so
    // never part of an import.
    `CREATE TABLE downloads (
      path TEXT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      size INTEGER NOT NULL,
      added_at TEXT NOT NULL)`,
    `CREATE INDEX downloads_owner ON downloads (owner_uid)`,
  ],
  [`ALTER TABLE datasets ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`],
];

/** How each table merges on import. `content` columns are overwritten by the incoming
 *  file; `state` columns (your progress, notes, stars) are only set for rows that are new. */
export const TABLES: { name: string; key: string[]; content: string[]; state: string[] }[] = [
  {
    name: "papers",
    key: ["uid"],
    content: ["pmid", "pmcid", "doi", "title", "authors", "journal", "pub_date", "abstract"],
    state: ["status", "starred", "notes", "added_at"],
  },
  { name: "searches", key: ["uid"], content: ["name", "query"], state: ["notify", "created_at", "last_checked"] },
  {
    name: "datasets",
    key: ["uid"],
    content: ["source", "accession", "title", "summary", "organism", "kind", "n_samples", "url", "pmid"],
    state: ["notes", "starred", "added_at"],
  },
  {
    name: "resources",
    key: ["uid"],
    content: ["kind", "title", "url", "author", "description"],
    state: ["file", "position", "added_at"],
  },
  { name: "scripts", key: ["uid"], content: ["name", "description", "code"], state: ["added_at"] },
  { name: "courses", key: ["uid"], content: ["position", "title", "description"], state: [] },
  { name: "modules", key: ["uid"], content: ["course_uid", "position", "title", "summary"], state: [] },
  {
    name: "lessons",
    key: ["uid"],
    content: ["module_uid", "position", "title", "minutes", "objectives", "body", "questions"],
    state: ["done_at", "notes"],
  },
  { name: "lesson_items", key: ["uid"], content: ["lesson_uid", "position", "kind", "ref_uid", "note"], state: [] },
];
