import { expect, it } from "vitest";
import { mergeFrom, migrate } from "./db";
import { openNodeDb } from "./node";

async function fresh() {
  const db = openNodeDb(":memory:");
  await migrate(db);
  return db;
}

it("migrates once and is repeatable", async () => {
  const db = await fresh();
  await migrate(db);
  expect(await db.select(`SELECT value FROM settings WHERE key = 'schema_version'`)).toEqual([{ value: "1" }]);
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
