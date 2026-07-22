// SearchConsole service: the Google Search Console + URL Inspection boundary,
// with OAuth token refresh. Backed downstream by Effect HttpClient with typed
// errors and a token-refresh Schedule. Reads client credentials from Config and
// the active property from CurrentSite. FROZEN CONTRACT — stub only.
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexInspection,
  type SearchConsoleError,
} from "./schema.ts"

export interface Interface {
  // Whether a usable (valid or refreshable) Google connection is stored. Never
  // fails — an unreadable token reads as "not connected".
  readonly hasGoogleConnection: () => Effect.Effect<boolean>
  // Run the interactive OAuth authorization flow and persist the token.
  readonly connectGoogle: () => Effect.Effect<string, SearchConsoleError>
  // Query-grouped snapshots (query/page/device/country) for the given dates.
  readonly fetchSearchConsoleSnapshots: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DailySnapshot>, SearchConsoleError>
  // Query-less site and per-page daily totals (the true numbers) for the dates.
  readonly fetchDailyTotals: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<DailyTotals, SearchConsoleError>
  // URL-inspection index statuses for the given fully-qualified target URLs.
  readonly fetchPageIndexStatuses: (
    targetUrls: ReadonlyArray<string>,
  ) => Effect.Effect<PageIndexInspection, SearchConsoleError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/SearchConsole",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Config.Service
    yield* CurrentSite.Service
    return {
      hasGoogleConnection: () =>
        Effect.die("unimplemented: SearchConsole.hasGoogleConnection"),
      connectGoogle: () =>
        Effect.die("unimplemented: SearchConsole.connectGoogle"),
      fetchSearchConsoleSnapshots: () =>
        Effect.die("unimplemented: SearchConsole.fetchSearchConsoleSnapshots"),
      fetchDailyTotals: () =>
        Effect.die("unimplemented: SearchConsole.fetchDailyTotals"),
      fetchPageIndexStatuses: () =>
        Effect.die("unimplemented: SearchConsole.fetchPageIndexStatuses"),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as SearchConsole from "./search-console"
