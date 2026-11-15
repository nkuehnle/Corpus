// Dev helper: merges a Corpus database into the dev server's database (.dev/corpus.db),
// the same merge the app runs on import.   node scripts/dev-import.ts my-plan.db
import { mergeFrom, migrate } from "../src/db/db.ts";
import { openNodeDb } from "../src/db/node.ts";

const target = openNodeDb(".dev/corpus.db");
await migrate(target);
console.log(JSON.stringify((await mergeFrom(openNodeDb(process.argv[2]), target)).tables));
