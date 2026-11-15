import { expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ IN_APP: false, writeStoredText: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({}));
vi.mock("./api/pubmed", () => ({
  searchPubmed: vi.fn(),
  summarize: vi.fn(async (pmids: string[]) =>
    pmids.map((pmid) => ({ pmid, pmcid: null, doi: null, title: `Paper ${pmid}`, authors: "A", journal: "J", pubDate: "2026" })),
  ),
}));

import { checkAlerts } from "./alerts";
import { searchPubmed } from "./api/pubmed";
import { migrate } from "./db/db";
import { openNodeDb } from "./db/node";
import { Repo, today } from "./db/repo";

it("records each new paper once and only checks searches with alerts on", async () => {
  const db = openNodeDb(":memory:");
  await migrate(db);
  const repo = new Repo(db);
  const followed = await repo.addSearch("Followed", "mtor");
  const saved = await repo.addSearch("Only saved", "ampk");
  await repo.updateSearch(saved, { notify: 0 });

  const search = vi.mocked(searchPubmed);
  search.mockResolvedValue({ count: 2, pmids: ["1", "2"] });
  expect((await checkAlerts(repo)).found).toEqual([{ name: "Followed", count: 2 }]);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search.mock.calls[0]).toEqual(["mtor", { enteredSince: today(), max: 100, sort: "pub_date" }]);

  // The same papers plus one more: only the newcomer counts.
  search.mockResolvedValue({ count: 3, pmids: ["3", "1", "2"] });
  expect((await checkAlerts(repo)).found).toEqual([{ name: "Followed", count: 1 }]);
  expect(await repo.unseenTotal()).toBe(3);

  await repo.markHitsSeen(followed);
  expect(await repo.unseenTotal()).toBe(0);
  expect((await repo.hits(followed)).map((h) => h.pmid).sort()).toEqual(["1", "2", "3"]);
});

it("reports a failing search without stopping the others", async () => {
  const db = openNodeDb(":memory:");
  await migrate(db);
  const repo = new Repo(db);
  await repo.addSearch("Broken", "bad");
  await repo.addSearch("Fine", "good");
  vi.mocked(searchPubmed).mockImplementation(async (term) => {
    if (term === "bad") throw new Error("PubMed answered 500");
    return { count: 1, pmids: ["9"] };
  });
  const result = await checkAlerts(repo);
  expect(result.found).toEqual([{ name: "Fine", count: 1 }]);
  expect(result.errors).toEqual(["Broken: PubMed answered 500"]);
});
