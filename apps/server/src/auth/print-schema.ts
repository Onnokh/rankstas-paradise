// Print the DDL Better Auth wants for the current configuration.
//
//   bun run apps/server/src/auth/print-schema.ts
//
// This is how `0002_auth` in the domain's migrations was produced, and how the
// next one must be. Run it after changing a plugin, a field, or a Better Auth
// version; diff the output against what the migrations already hold, and APPEND
// the difference as a new migration. Never edit an applied one, and never run
// `@better-auth/cli migrate` against a real database: the app database has one
// schema owner (ADR 0006), and that owner is migrations.ts.
//
// Note that `@better-auth/cli generate` cannot do this job here. The CLI runs
// under Node, auth.ts imports `bun:sqlite`, and Node cannot resolve it, so the
// config fails to load. `getMigrations` is the same machinery the CLI drives,
// called directly under Bun.
import { getMigrations } from "better-auth/db/migration"

import { makeAuth } from "./auth.ts"

// A throwaway file: the plan is computed from an EMPTY database, so every table
// reads as "to be created" and the output is the whole schema rather than the
// difference from whatever this machine happens to have.
const scratch = `${process.env.TMPDIR ?? "/tmp"}/rp-auth-schema-${crypto.randomUUID()}.sqlite`

const auth = makeAuth(scratch, "http://localhost:8790")
const plan = await getMigrations(
  (auth as unknown as { options: Parameters<typeof getMigrations>[0] }).options,
  { throwOnUnsafe: false },
)

console.log(`-- tables: ${plan.toBeCreated.map((table) => table.table).join(", ")}`)
console.log(await plan.compileMigrations())
