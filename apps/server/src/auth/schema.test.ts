// The checked-in `0002_auth` migration must be exactly what Better Auth wants.
//
// Better Auth's tables are generated (see print-schema.ts) and then pasted into
// the domain's migrations, because the app database has one schema owner. That
// arrangement has a gap: nothing stops the pasted copy and the library drifting
// apart when Better Auth is upgraded, and the drift would not show up at start
// — our migrator would happily record `0002` as applied, and the first request
// that touched a missing column would fail instead.
//
// So this compares the two directly: the schema our migrations actually build,
// against the schema the installed Better Auth asks for. If it fails after a
// dependency bump, that is the signal to run print-schema.ts and APPEND the
// difference as a new migration. Do not edit `0002` to make it pass.
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, ManagedRuntime } from "effect"
import { getMigrations } from "better-auth/db/migration"

import { AppDatabase } from "@rp/domain/app-database/app-database"
import { Config } from "@rp/domain/config/config"

import { makeAuth } from "./auth.ts"

const fakeConfig = (dataDirectory: string) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      load: () => Effect.succeed({ siteUrl: "sc-domain:example.com" }),
      dataDirectory: () => Effect.succeed(dataDirectory),
      serviceAccountPath: () =>
        Effect.succeed(`${dataDirectory}/google-service-account.json`),
      debugMode: () => Effect.succeed(false),
      ensureDataDirectory: () => Effect.void,
    }),
  )

// Every table and index a file holds, as SQLite itself reports it, with the
// whitespace and quoting differences that carry no meaning taken out.
const schemaOf = (path: string): ReadonlyArray<string> => {
  const db = new Database(path)
  const rows = db
    .query(
      `select sql from sqlite_master
       where sql is not null and name not like 'sqlite_%'
       order by name`,
    )
    .all() as Array<{ sql: string }>
  db.close()
  return rows
    .map((row) => row.sql.replace(/["`]/g, "").replace(/\s+/g, " ").trim().toLowerCase())
    .sort()
}

// Only Better Auth's own tables: our migrations build the app's tables too, and
// those are none of the library's business.
const authTables = ["user", "session", "account", "verification", "apikey"]
const authPart = (schema: ReadonlyArray<string>) =>
  schema.filter((statement) =>
    authTables.some(
      (table) =>
        statement.startsWith(`create table ${table} (`) ||
        statement.includes(` on ${table} (`),
    ),
  )

test("the checked-in auth migration is what Better Auth asks for", async () => {
  const ours = mkdtempSync(join(tmpdir(), "rp-schema-ours-"))
  const theirs = mkdtempSync(join(tmpdir(), "rp-schema-theirs-"))
  try {
    // Ours: the real migrator, the real record of migrations.
    const runtime = ManagedRuntime.make(
      AppDatabase.layer.pipe(Layer.provide(fakeConfig(ours))),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* AppDatabase.Service
      }),
    )
    await runtime.dispose()

    // Theirs: the installed library, against an empty file.
    const theirPath = `${theirs}/auth.sqlite`
    const auth = makeAuth(theirPath, "http://localhost:8790")
    const plan = await getMigrations(
      (auth as unknown as { options: Parameters<typeof getMigrations>[0] }).options,
      { throwOnUnsafe: false },
    )
    await plan.runMigrations()

    expect(authPart(schemaOf(`${ours}/rankstas-paradise.sqlite`))).toEqual(
      authPart(schemaOf(theirPath)),
    )
  } finally {
    rmSync(ours, { recursive: true, force: true })
    rmSync(theirs, { recursive: true, force: true })
  }
})
