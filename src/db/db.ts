import { MIGRATIONS, SCHEMA_VERSION, TABLES } from "./schema.ts";

export type Value = string | number | null;

/** The few database operations the app needs; backed by the Tauri SQL plugin in the app,
 *  node:sqlite in tests and the seed builder, and the Vite dev server in a plain browser. */
export interface Db {
  select<T = Record<string, Value>>(sql: string, params?: Value[]): Promise<T[]>;
  execute(sql: string, params?: Value[]): Promise<void>;
}

async function version(db: Db): Promise<number> {
  const has = await db.select(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'`);
  if (!has.length) return 0;
  const rows = await db.select<{ value: string }>(`SELECT value FROM settings WHERE key = 'schema_version'`);
  return rows.length ? Number(rows[0].value) : 0;
}

export async function migrate(db: Db): Promise<void> {
  const from = await version(db);
  if (from > SCHEMA_VERSION) throw new Error("This database was made by a newer version of Corpus.");
  for (let v = from; v < MIGRATIONS.length; v++) {
    for (const sql of MIGRATIONS[v]) await db.execute(sql);
    await db.execute(`INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)`, [String(v + 1)]);
  }
}

export interface ImportSummary {
  /** Rows added and rows updated, per table. */
  tables: { name: string; added: number; updated: number }[];
}

/** Merges another Corpus database into this one. Lesson text, paper details and the like
 *  are refreshed from the file; progress, notes and stars already here are kept. */
export async function mergeFrom(source: Db, target: Db): Promise<ImportSummary> {
  const sourceVersion = await version(source);
  if (sourceVersion === 0) throw new Error("That file is not a Corpus database.");
  if (sourceVersion > SCHEMA_VERSION) throw new Error("That file was made by a newer version of Corpus.");

  const summary: ImportSummary = { tables: [] };
  const present = new Set(
    (await source.select<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name),
  );
  for (const t of TABLES) {
    // A file from an older version simply lacks the tables added since.
    if (!present.has(t.name)) continue;
    const rows = await source.select(`SELECT * FROM ${t.name}`);
    const existing = new Set((await target.select<{ uid: string }>(`SELECT uid FROM ${t.name}`)).map((r) => r.uid));
    // Columns added since the file was made are left to their defaults.
    const has = new Set((await source.select<{ name: string }>(`PRAGMA table_info(${t.name})`)).map((r) => r.name));
    const cols = [...t.key, ...t.content, ...t.state].filter((c) => has.has(c));
    const update = t.content
      .filter((c) => has.has(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    const sql =
      `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT (uid) DO UPDATE SET ${update}`;
    let added = 0;
    for (const row of rows) {
      await target.execute(
        sql,
        cols.map((c) => row[c] ?? null),
      );
      if (!existing.has(row.uid as string)) added++;
    }
    summary.tables.push({ name: t.name, added, updated: rows.length - added });
  }
  if (present.has("courses")) await dropWhatThePlanDropped(source, target);
  return summary;
}

/** Makes each study plan in the file match the file: lessons, modules and lesson links that a
 *  newer version of the plan no longer has are removed, so an updated plan replaces the old
 *  one instead of piling up on it. A dropped lesson is kept if you wrote notes on it, and
 *  papers, library items and datasets are never removed: those are your library. */
async function dropWhatThePlanDropped(source: Db, target: Db): Promise<void> {
  const uids = async (db: Db, sql: string, params: Value[]) =>
    new Set((await db.select<{ uid: string }>(sql, params)).map((r) => r.uid));
  const inCourse = {
    modules: `SELECT uid FROM modules WHERE course_uid = ?`,
    lessons: `SELECT l.uid FROM lessons l JOIN modules m ON m.uid = l.module_uid WHERE m.course_uid = ?`,
    // Links made by a plan are named after their lesson; ones you add yourself are not.
    lesson_items: `SELECT i.uid FROM lesson_items i JOIN lessons l ON l.uid = i.lesson_uid JOIN modules m ON m.uid = l.module_uid
                   WHERE m.course_uid = ? AND i.uid LIKE 'item:lesson:%'`,
  };
  for (const course of await source.select<{ uid: string }>(`SELECT uid FROM courses`)) {
    // Children first, so a lesson's links are judged while the lesson can still be found.
    for (const table of ["lesson_items", "lessons", "modules"] as const) {
      const keep = await uids(source, inCourse[table], [course.uid]);
      for (const uid of await uids(target, inCourse[table], [course.uid])) {
        if (keep.has(uid)) continue;
        if (table === "lessons") {
          const [lesson] = await target.select<{ notes: string }>(`SELECT notes FROM lessons WHERE uid = ?`, [uid]);
          if (lesson.notes.trim()) continue;
          await target.execute(`DELETE FROM lesson_items WHERE lesson_uid = ?`, [uid]);
        }
        if (table === "modules") {
          const [left] = await target.select<{ n: number }>(`SELECT COUNT(*) AS n FROM lessons WHERE module_uid = ?`, [uid]);
          if (left.n) continue;
        }
        await target.execute(`DELETE FROM ${table} WHERE uid = ?`, [uid]);
      }
    }
  }
}
