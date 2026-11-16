import { expect, it } from "vitest";
import { mergeFrom, migrate } from "./db";
import { MIGRATIONS } from "./schema";
import { openNodeDb } from "./node";
import { SCHEMA_VERSION } from "./schema";

async function fresh() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

it("migrates once and is repeatable", async () => {
  const db = await fresh();
  await migrate(db);
  expect(await db.select(`SELECT value FROM settings WHERE key = 'schema_version'`)).toEqual([{ value: String(SCHEMA_VERSION) }]);
});

it("merging refreshes content but keeps progress and notes", async () => {
  const mine = await fresh();
  const theirs = await fresh();
  await mine.execute(
    `INSERT INTO lessons (uid, module_uid, title, body, done_at, notes) VALUES ('l1', 'm1', 'Old title', 'old', '2026-01-01', 'my note')`,
  );
  await theirs.execute(`INSERT INTO lessons (uid, module_uid, title, body) VALUES ('l1', 'm1', 'New title', 'new')`);
  await theirs.execute(`INSERT INTO lessons (uid, module_uid, title, body) VALUES ('l2', 'm1', 'Second', 'b')`);
  await theirs.execute(`INSERT INTO papers (uid, pmid, title, added_at) VALUES ('pmid:1', '1', 'Paper', '2026-01-01')`);

  const summary = await mergeFrom(theirs, mine);
  expect(summary.tables.find((t) => t.name === "lessons")).toEqual({ name: "lessons", added: 1, updated: 1 });
  expect(summary.tables.find((t) => t.name === "papers")).toEqual({ name: "papers", added: 1, updated: 0 });

  const [l1] = await mine.select(`SELECT title, body, done_at, notes FROM lessons WHERE uid = 'l1'`);
  expect(l1).toEqual({ title: "New title", body: "new", done_at: "2026-01-01", notes: "my note" });
});

it("rejects files that are not Corpus databases", async () => {
  await expect(mergeFrom(openNodeDb(":memory:"), await fresh())).rejects.toThrow("not a Corpus database");
});

it("merges a file from an older version that lacks newer tables", async () => {
  const old = openNodeDb(":memory:");
  await migrate(old);
  await old.execute(`DROP TABLE scripts`);
  await old.execute(`UPDATE settings SET value = '1' WHERE key = 'schema_version'`);
  await old.execute(`INSERT INTO courses (uid, title) VALUES ('c1', 'Course')`);
  const summary = await mergeFrom(old, await fresh());
  expect(summary.tables.find((t) => t.name === "courses")).toEqual({ name: "courses", added: 1, updated: 0 });
  expect(summary.tables.some((t) => t.name === "scripts")).toBe(false);
});

it("importing a script never marks it as approved to run", async () => {
  const mine = await fresh();
  const theirs = await fresh();
  await theirs.execute(
    `INSERT INTO scripts (uid, name, code, approved_code, added_at) VALUES ('s1', 'S', 'return 1', 'return 1', 'x')`,
  );
  await mergeFrom(theirs, mine);
  expect(await mine.select(`SELECT code, approved_code FROM scripts`)).toEqual([{ code: "return 1", approved_code: null }]);
});

async function plan(lessons: string[], items: Record<string, string[]> = {}) {
  const db = await fresh();
  await db.execute(`INSERT INTO courses (uid, title) VALUES ('c1', 'Course')`);
  await db.execute(`INSERT INTO modules (uid, course_uid, title) VALUES ('m1', 'c1', 'Module')`);
  for (const uid of lessons) await db.execute(`INSERT INTO lessons (uid, module_uid, title) VALUES (?, 'm1', ?)`, [uid, uid]);
  for (const [lesson, papers] of Object.entries(items)) {
    for (const paper of papers) {
      await db.execute(`INSERT OR IGNORE INTO papers (uid, title, added_at) VALUES (?, ?, 'x')`, [paper, paper]);
      await db.execute(`INSERT INTO lesson_items (uid, lesson_uid, kind, ref_uid) VALUES (?, ?, 'paper', ?)`, [
        `item:lesson:${lesson}/paper/${paper}`,
        lesson,
        paper,
      ]);
    }
  }
  return db;
}

const count = async (db: Awaited<ReturnType<typeof fresh>>, table: string) =>
  (await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

it("importing the same file twice changes nothing", async () => {
  const mine = await fresh();
  const file = await plan(["l1", "l2"], { l1: ["p1", "p2"] });
  await mergeFrom(file, mine);
  const before = await Promise.all(["courses", "modules", "lessons", "lesson_items", "papers"].map((t) => count(mine, t)));
  const second = await mergeFrom(file, mine);
  expect(await Promise.all(["courses", "modules", "lessons", "lesson_items", "papers"].map((t) => count(mine, t)))).toEqual(
    before,
  );
  expect(second.tables.every((t) => t.added === 0)).toBe(true);
});

it("a newer version of a plan replaces the old one and keeps what is yours", async () => {
  const mine = await fresh();
  await mergeFrom(await plan(["l1", "l2", "l3"], { l1: ["p1", "p2"] }), mine);
  await mine.execute(`UPDATE lessons SET done_at = '2026-01-01' WHERE uid = 'l1'`);
  await mine.execute(`UPDATE lessons SET notes = 'keep me' WHERE uid = 'l3'`);
  await mine.execute(`UPDATE papers SET starred = 1 WHERE uid = 'p2'`);
  await mine.execute(`INSERT INTO lesson_items (uid, lesson_uid, kind, ref_uid) VALUES ('item:mine', 'l1', 'paper', 'p2')`);

  // The new version drops lesson l2 and l3 and the link from l1 to p2, and adds l4.
  await mergeFrom(await plan(["l1", "l4"], { l1: ["p1"] }), mine);

  expect((await mine.select(`SELECT uid FROM lessons ORDER BY uid`)).map((r) => r.uid)).toEqual(["l1", "l3", "l4"]);
  expect(await mine.select(`SELECT done_at FROM lessons WHERE uid = 'l1'`)).toEqual([{ done_at: "2026-01-01" }]);
  expect((await mine.select(`SELECT uid FROM lesson_items ORDER BY uid`)).map((r) => r.uid)).toEqual([
    "item:lesson:l1/paper/p1",
    "item:mine",
  ]);
  // The paper the plan no longer links to stays in the library, star and all.
  expect(await mine.select(`SELECT starred FROM papers WHERE uid = 'p2'`)).toEqual([{ starred: 1 }]);
});

it("importing one plan leaves other plans alone", async () => {
  const mine = await fresh();
  await mine.execute(`INSERT INTO courses (uid, title) VALUES ('other', 'Other')`);
  await mine.execute(`INSERT INTO modules (uid, course_uid, title) VALUES ('om', 'other', 'M')`);
  await mine.execute(`INSERT INTO lessons (uid, module_uid, title) VALUES ('ol', 'om', 'L')`);
  await mergeFrom(await plan(["l1"]), mine);
  expect(await count(mine, "lessons")).toBe(2);
});

it("updating the app keeps the data of an older version", async () => {
  // A database as version 1 of the app left it.
  const db = openNodeDb(":memory:");
  for (const sql of MIGRATIONS[0]) await db.execute(sql);
  await db.execute(`INSERT INTO settings (key, value) VALUES ('schema_version', '1')`);
  await db.execute(`INSERT INTO lessons (uid, module_uid, title, done_at, notes) VALUES ('l1', 'm1', 'L', '2026-01-01', 'note')`);
  await db.execute(`INSERT INTO papers (uid, title, starred, added_at) VALUES ('p1', 'P', 1, 'x')`);

  await migrate(db);

  expect(await db.select(`SELECT done_at, notes FROM lessons`)).toEqual([{ done_at: "2026-01-01", notes: "note" }]);
  expect(await db.select(`SELECT starred FROM papers`)).toEqual([{ starred: 1 }]);
  expect(await count(db, "scripts")).toBe(0);
  expect(await db.select(`SELECT value FROM settings WHERE key = 'schema_version'`)).toEqual([{ value: String(SCHEMA_VERSION) }]);
});
