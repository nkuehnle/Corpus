# Corpus

An Android app (Tauri 2 + React + TypeScript) for following and studying the life-science
literature:

- **Papers**: search PubMed, save papers with notes and reading status, and get notified
  when new papers match a saved search.
- **Datasets**: search GEO, see the most-viewed datasets across repositories, save the ones
  you care about, and open their files.
- **Data**: open supplementary tables and dataset files (CSV, TSV, Excel, gzip, zip) as
  sortable tables with histograms, scatter plots and automatic volcano plots. Compare two
  groups of samples (moderated t-test), run a sample PCA, or write short JavaScript scripts
  that turn the open table into a new one.
- **Library**: keep videos, links, textbooks and PDFs, with a built-in PDF reader that
  remembers your page.
- **Learn**: study plans made of lessons that tie all of the above together and track your
  progress.

Everything is stored in one SQLite file on the device. A study plan is distributed as a
Corpus database file that the app merges into its own.

## Study plans

A study plan is a Corpus database file: lessons plus the papers, videos, textbooks, datasets,
saved searches and analysis scripts they refer to. Copy one to the phone, then in the app go
to **Learn › settings (gear) › Import a database file**. Importing again later refreshes
lesson text and keeps your progress, notes and stars.

Plans are personal files and are not part of this repository.

## Building and running

Requirements: Node 24+, pnpm, Rust with the Android targets, Android SDK and NDK, JDK 17+.

```sh
pnpm install
pnpm test          # unit tests
(cd src-tauri/analytics && cargo test)   # the Rust analyses
pnpm dev           # UI in a browser at http://localhost:1420 (see below)
pnpm tauri dev     # desktop window

# Android (debug APK, installable as is)
export JAVA_HOME=~/Android/jdk ANDROID_HOME=~/Android/Sdk NDK_HOME=~/Android/Sdk/ndk/28.2.13676358
pnpm tauri android build --debug --apk --target aarch64     # phone
pnpm tauri android build --debug --apk --target x86_64      # emulator
# -> src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Release builds (`pnpm tauri android build --apk --target aarch64`) are signed when
`src-tauri/gen/android/keystore.properties` exists. That file and the keystore it points to
(`~/Android/corpus-release.jks`) are kept out of git. Keep a backup of both: an update can
only be installed over an existing copy if it is signed with the same key.

To release: bump the version in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` (also raise `bundle.android.versionCode`), build, commit, tag
`v<version>`, push, then run `scripts/publish.sh <version> <notes-file>`.

### Testing on an emulator

`scripts/adb-ui.sh` has helpers for driving the app on a dedicated `corpus` emulator
(taps by screen coordinate for the web UI, by text for native dialogs, and screenshots).
Release builds shrink code and debug builds do not, so run a release build once on the
emulator (`--target x86_64`) before publishing.

### Running the UI in a browser

`pnpm dev` alone serves the UI with a development backend built into `vite.config.ts`: a
SQLite file at `.dev/corpus.db` stands in for the SQL plugin and an HTTP relay stands in for
the HTTP plugin. File features (import, PDFs, opening local files) need the real app.

```sh
node scripts/dev-import.ts my-plan.db    # load a study plan into .dev/corpus.db
node scripts/shot.mjs /tmp/shots /learn /papers/search   # screenshots at phone size
```

## How it is put together

```
src/
  platform.ts      everything that touches Tauri: database, HTTP, files, dialogs
  db/              schema and migrations, merge-on-import, queries (repo.ts)
  api/             PubMed, Europe PMC (citation counts), GEO, OmicsDI, supplementary files
  data/table.ts    reads CSV/TSV/Excel/gzip/zip into typed tables; finds volcano columns
  data/analysis.ts sends a table's sample columns to the Rust analyses
  data/scripts.ts  runs a user script on a table inside a worker
  charts/          histogram (SVG) and scatter/volcano (canvas)
  alerts.ts        checks saved searches for new papers; hands the plan to the Android worker
  pages/           one file per tab
src-tauri/
  src/lib.rs       plugins plus two commands: copy_any (copies to/from Android content
                   URIs) and analyze (the built-in analyses)
  analytics/       corpus-analytics: differential expression and PCA, plain Rust with tests
  gen/android/     the Android project; AlertWorker.kt is the background alert check
scripts/           dev helpers and the release script
```

Design decisions worth knowing:

- **Rows are keyed by stable text ids** (`pmid:123`, `geo:GSE1`, `lesson:course/module/id`)
  and refer to each other by id. Importing another database is then a plain upsert with no
  id remapping. Each table declares which columns are content (overwritten on import) and
  which are yours (kept).
- **Logic is in TypeScript; Rust is thin.** The app uses the Tauri SQL, HTTP, FS, dialog,
  notification and opener plugins. The one custom command exists because Android's file
  picker returns `content://` URIs that only the FS plugin can open.
- **Built-in analyses are Rust; ad hoc ones are JavaScript.** `src-tauri/analytics` holds
  the two-group comparison and the sample PCA. The comparison is a moderated t-test on log2
  values (log2 counts per million for raw counts): each gene's pooled variance is shrunk
  toward the variance typical of genes at its expression level, as limma does, then p-values
  are Benjamini–Hochberg adjusted. It is checked against an independent base-R
  implementation (`scripts/check-moderated-t*.R`; the Rust side is
  `cargo run --example compare`). Android's WebView can only pass JSON to Rust, so the
  matrix travels as base64 of single-precision floats.
- **Scripts run in a sandbox.** A script is the body of a function that receives the open
  table and returns a new one. It runs in a Web Worker, which has no access to the page, the
  database or the Tauri bridge, and the app's content security policy
  (`src-tauri/tauri.conf.json`) allows connections only to the Rust side and stored files,
  so a script cannot make network requests. Scripts that arrive in an imported file ask
  before their first run.
- **Network access is limited** to NCBI, Europe PMC, OmicsDI and the PMC open-data bucket
  (`src-tauri/capabilities/default.json`). Add a host there before fetching from it.
- **Supplementary files** come from the PMC open-access bucket
  (`pmc-oa-opendata.s3.amazonaws.com`), which lists every file deposited with an
  open-access article. Papers outside the PMC open-access set have nothing to fetch.
- **Alerts** ask PubMed for records *entered* since the last check (`datetype=edat`), in
  PubMed's own timezone, and keep the ids already seen. The app checks at launch and every
  three hours while open. On Android, a WorkManager job runs about every 12 hours with the
  app closed: it reads `alerts.json` (written by the app), queries PubMed and posts a
  notification. It only notifies; the app records the papers when it next opens.

## Known limits

- Files are parsed in memory, so downloads over 60 MB are opened in the browser instead.
- The group comparison handles two unpaired groups. It does not model paired samples,
  covariates or batches; use DESeq2, edgeR or limma for anything beyond a first look.
- "Most viewed" datasets is OmicsDI's global list, not specific to a field. OmicsDI's search
  does not return usable view counts, so field-specific ranking is not available.
- The PDF reader shows one page at a time with zoom buttons; no text search or annotations.
- Study plans can be imported and removed but not edited in the app. Lessons list the
  resources shipped with them; you cannot yet attach your own library items to a lesson.
- Notification taps open the app, not the specific alert.

## Next steps

1. Attach your own papers, videos and PDFs to lessons; create and edit study plans in the app.
2. Full-text search across saved papers, notes and lessons.
3. Field-relevant dataset ranking (for example by citations of the linked paper).
4. Open a tapped notification directly on its alert.
5. Spaced-repetition review of each lesson's questions.
