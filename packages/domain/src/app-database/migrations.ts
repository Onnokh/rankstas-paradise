// The app-level database's schema, as an ordered record of migrations run by
// `SqliteMigrator` on AppDatabase acquisition.
//
// This is the ONE place the app-level tables are defined. Catalog, Secrets and
// Clients used to each run their own `create table if not exists` when their
// layer was acquired, which meant the schema could gain a table but no table
// could ever change a column: `create table if not exists` is a no-op over an
// existing table of the wrong shape, and a deployment then fails on a missing
// column at read time rather than at start (see the regression this caused in
// storage.test.ts). A migration record can add a column.
//
// The per-site ledgers are deliberately NOT here. Those tables are a cache of
// Search Console, analytics and commerce data that can be fetched again, so
// dropping and re-syncing is the right repair for them; these five hold the
// only rows in the system that cannot be re-fetched.
//
// Rules for adding one:
//   - Append. Never edit an applied migration — the migrator only runs ids
//     above the highest it has recorded, so a changed `0001` is silently
//     skipped on every database that already has it.
//   - Key the entry `<id>_<name>`, with a four-digit id (`Migrator.fromRecord`
//     parses the key; the id orders the run and the name is only a label).
//   - One migration is one Effect. It is not wrapped in a transaction by the
//     migrator, so keep each one to a change that is safe to retry.
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

// The table the migrator records applied ids in. Named for this app rather
// than taking the library default (`effect_sql_migrations`), so every table in
// the file reads as one schema.
export const migrationTable = "rp_migration"

// One migration from a list of statements, run in order.
const statements = (...ddl: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.forEach(ddl, (statement) => sql.unsafe(statement))
  })

export const migrations = {
  // The schema as it stood before there was a migrator: the statements the
  // three services ran themselves, verbatim. Every one is
  // `create table if not exists`, so a database built by the old code adopts
  // the migrator without a single byte changing — the run records the id and
  // the statements do nothing.
  "0001_initial": statements(
    `create table if not exists site (
      id text primary key,
      position integer not null,
      settings text not null,
      updated_at text not null default current_timestamp
    )`,
    `create table if not exists catalog_meta (
      key text primary key,
      value text not null
    )`,
    `create table if not exists secret (
      scope text not null,
      purpose text not null,
      nonce text not null,
      ciphertext text not null,
      key_version integer not null,
      last4 text not null,
      updated_at text not null,
      primary key (scope, purpose)
    )`,
    `create table if not exists secret_meta (
      key text primary key,
      value text not null
    )`,
    `create table if not exists client_token (
      id text primary key,
      label text not null,
      token_hash text not null unique,
      created_at text not null,
      last_used_at text,
      revoked_at text
    )`,
  ),

  // Better Auth's own tables: identity (`user`, `session`, `account`,
  // `verification`) and the API keys that replaced `client_token`.
  //
  // Generated, not written. Better Auth's `getMigrations(options)
  // .compileMigrations()` produced every statement below verbatim, and the
  // result is checked in here rather than applied by `@better-auth/cli migrate`
  // so the app database keeps the single schema owner it gained in ADR 0006.
  // Regenerate the same way after changing a plugin or a field, and append the
  // difference as a new migration; never edit this one.
  //
  // These are plain `create table`, not `create table if not exists`, because
  // the generator writes them that way and the strictness is worth keeping: if
  // one of these already exists, something outside this file made it, and
  // failing the layer at start is the right answer.
  "0002_auth": statements(
    `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null)`,
    `create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
    `create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
    `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
    `create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text)`,
    `create index "session_userId_idx" on "session" ("userId")`,
    `create index "account_userId_idx" on "account" ("userId")`,
    `create index "verification_identifier_idx" on "verification" ("identifier")`,
    `create index "apikey_configId_idx" on "apikey" ("configId")`,
    `create index "apikey_referenceId_idx" on "apikey" ("referenceId")`,
    `create index "apikey_key_idx" on "apikey" ("key")`,
  ),
}

export * as AppDatabaseMigrations from "./migrations"
