# The app database has migrations; the per-site ledgers do not

## Status

accepted. Changes how the app-level schema is built; no report, route, or
vendor boundary changes.

## Context

Every table in the app was created by the service that read it, with a
`create table if not exists` run on layer acquisition — `site` and
`catalog_meta` by Catalog, `secret` and `secret_meta` by Secrets,
`client_token` by Clients, and twenty-two more by Storage. There were no
`alter table` statements anywhere in the repo.

That means the schema could gain a table but no table could change a column.
`create table if not exists` is a no-op over an existing table of the wrong
shape, so the change lands in the code and not in the database, and the
deployment fails later at a read.

It has already happened. The regression is kept as a test in
`storage/storage.test.ts`: a counting column was renamed, the new DDL did
nothing to a database that already had the table, and every registry read
failed on `no such column: keyword_targets` until the table was dropped on
acquisition.

Dropping the table was the right repair *there*. `index_coverage` is derived
from Search Console and re-syncing costs one job. It is not a repair for
`site`, `secret`, or `client_token`, which hold the only rows in the system
that cannot be fetched again — and the next things to land in that file are
identity and API keys, where the same mistake locks everyone out.

## Decision

**Run ordered migrations on the app-level database. Leave the per-site ledgers
as they are.**

`AppDatabase` applies `packages/domain/src/app-database/migrations.ts` with
`SqliteMigrator` on acquisition, recording applied ids in `rp_migration`. It
ships with Effect in `@effect/sql-sqlite-bun`, already a dependency, so this
adds nothing to the dependency list.

- **`fromRecord`, not files.** Migrations are plain effects keyed `<id>_<name>`
  in one module. Nothing is read from disk at boot and nothing extra ships in
  the image.
- **`0001_initial` is the schema as it already was** — the same statements the
  three services ran, verbatim, still `create table if not exists`. A
  deployment's existing database adopts the migrator without a byte changing:
  the run records the id and the statements do nothing.
- **The three services no longer carry DDL.** They are layered over
  `AppDatabase`, so the migrations have run before any of them is built.
- **The 22 per-site tables keep `create table if not exists`.** They are a
  cache of Search Console, analytics, and commerce data. Re-syncing is the
  correct repair for a cache and it costs one job; a migration runner there
  would be ceremony around a table that can be thrown away.

A failure fails the layer, so a half-built schema stops the server at start
rather than at the first read.

## Consequences

- Adding a column to an app-level table is now possible, and is an appended
  entry in the record. An applied migration is never edited — the migrator only
  runs ids above the highest it has recorded, so a changed `0001` is silently
  skipped everywhere it has already run.
- Two databases now answer the question "how does this table exist?"
  differently. The split is deliberate and is the one in the Decision above:
  irreplaceable rows get migrations, caches get dropped.
- `pragma busy_timeout = 5000` is set on both databases. The client already
  puts the file in WAL mode, which permits one writer, and SQLite's default is
  to fail a blocked statement rather than wait for it. One handle is served in
  turn so nothing needs the wait today; a second handle on the same file — a
  library that opens its own connection — would see `SQLITE_BUSY` without it.
