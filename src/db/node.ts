import { DatabaseSync } from "node:sqlite";
import type { Db, Value } from "./db";

/** node:sqlite behind the app's Db interface (tests, seed builder, dev server). */
export function openNodeDb(path: string): Db & { close(): void } {
  const raw = new DatabaseSync(path);
  return {
    async select<T>(sql: string, params: Value[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async execute(sql: string, params: Value[] = []) {
      raw.prepare(sql).run(...params);
    },
    close: () => raw.close(),
  };
}
