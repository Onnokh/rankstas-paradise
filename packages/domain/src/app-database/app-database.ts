// AppDatabase service: the one connection to the app-level SQLite database,
// `<app home>/rankstas-paradise.sqlite` (`.debug.sqlite` in debug mode, like the
// per-site ledgers, so a debug run never touches the real one). Process-global
// and not site-scoped: it holds what is the same for every site — the Catalog
// of sites and the Secrets vault. Each of those services owns its own tables
// and runs its own `create table if not exists` on acquisition; this service
// only opens the file.
import { mkdirSync } from "node:fs"

import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { SqliteClient } from "@effect/sql-sqlite-bun"

import { Config } from "../config/config.ts"
import { serviceUse } from "../service-use.ts"
import { AppDatabaseError } from "./schema.ts"

export interface Interface {
  // The open SQL client. Shared, so callers never open the file themselves.
  readonly client: SqliteClient.SqliteClient
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/AppDatabase",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const dataDirectory = yield* Config.use.dataDirectory()
    const debug = yield* Config.use.debugMode()
    const databasePath = `${dataDirectory}/rankstas-paradise${debug ? ".debug" : ""}.sqlite`

    yield* Effect.try({
      try: () => mkdirSync(dataDirectory, { recursive: true }),
      catch: (cause) =>
        new AppDatabaseError({ message: `Could not create ${dataDirectory}`, cause }),
    })

    const client = yield* SqliteClient.make({ filename: databasePath }).pipe(
      Effect.provide(Reactivity.layer),
    )
    return { client }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as AppDatabase from "./app-database"
