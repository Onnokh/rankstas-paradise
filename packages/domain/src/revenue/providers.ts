// The registry of revenue provider adapters, keyed by the `provider` string a
// site's config names. This is the ONE place in the domain that knows which
// commerce vendors exist. Adding a vendor is one adapter module next to this
// file plus one entry in the map below; nothing in Storage, Sync, or Reports
// changes. The twin of ../analytics/providers.ts.
import { type Effect } from "effect"
import { type HttpClient } from "effect/unstable/http"

import { Polar } from "./polar.ts"
import {
  type RevenueDay,
  type RevenueError,
  type RevenueSource,
} from "./schema.ts"

// What an adapter must produce: canonical rows for the dates asked, in the
// site's zone; a date the vendor has nothing for is a quiet day and may be
// omitted (Storage records it as zeros). How many vendor calls that takes is
// the adapter's business — Polar answers a whole span in one metrics call —
// so the port takes a list of dates and never a single day.
export interface Provider {
  readonly fetchRevenue: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<RevenueDay>, RevenueError>
}

// Builds the adapter for one site's source. Runs once per site runtime, so
// this is where a vendor reads its key (`Config.redacted(source.keyVariable)`)
// and fails early when it cannot work. A failure here does not fail the site:
// Revenue catches it and reports the site as not ready, with this error's
// message as the reason.
export type ProviderFactory = (
  source: RevenueSource,
) => Effect.Effect<Provider, RevenueError, HttpClient.HttpClient>

export const providers: ReadonlyMap<string, ProviderFactory> = new Map<
  string,
  ProviderFactory
>([[Polar.providerName, Polar.make]])
