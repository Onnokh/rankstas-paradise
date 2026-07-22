// Sync service: orchestrates a Search Console refresh — composes SearchConsole
// (fetch), Storage (persist + freshness), Registry (targets), and Sitemap
// (refresh). Site-scoped. FROZEN CONTRACT — stub only.
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Registry } from "../registry/registry.ts"
import { SearchConsole } from "../search-console/search-console.ts"
import { serviceUse } from "../service-use.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { Storage } from "../storage/storage.ts"
import { SyncError } from "./schema.ts"

export interface Interface {
  // Reconcile the recently-finalized window and fetch missing days; returns a
  // human-readable summary of what was saved.
  readonly syncSearchConsole: () => Effect.Effect<string, SyncError>
  // Backfill up to `months` of history; returns a human-readable summary.
  readonly backfillSearchConsole: (
    months?: number,
  ) => Effect.Effect<string, SyncError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Sync") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* SearchConsole.Service
    yield* Storage.Service
    yield* Registry.Service
    yield* Sitemap.Service
    yield* Config.Service
    yield* CurrentSite.Service
    return {
      syncSearchConsole: () =>
        Effect.die("unimplemented: Sync.syncSearchConsole"),
      backfillSearchConsole: () =>
        Effect.die("unimplemented: Sync.backfillSearchConsole"),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SearchConsole.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(Sitemap.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Sync from "./sync"
