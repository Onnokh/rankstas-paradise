// The registry of analytics provider adapters, keyed by the `provider` string a
// site's config names. This is the ONE place in the domain that knows which
// vendors exist. Adding a vendor is one adapter module next to this file plus
// one entry in the map below; nothing in Storage, Sync, or Reports changes.
//
// A site that names a provider with no entry here is reported as
// configured-but-not-ready (see Analytics.status) rather than failing the
// site's runtime.
import { type Effect } from "effect"
import { type HttpClient } from "effect/unstable/http"

import { Rybbit } from "./rybbit.ts"
import {
  type AnalyticsError,
  type AnalyticsSource,
  type VisitsDays,
} from "./schema.ts"

// What an adapter must produce: canonical rows for exactly the dates asked. How
// many vendor calls that takes is the adapter's business — Rybbit and Umami
// need one call per day for the per-page breakdown, GA4 answers a whole range
// in one report — so the port takes a list of dates and never a single day.
export interface Provider {
  readonly fetchVisits: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<VisitsDays, AnalyticsError>
  // Distinct visitors active in the last `windowMinutes`. Every vendor in scope
  // answers this in one call (Rybbit live-user-count, Umami active, GA4
  // realtime), so it is part of the contract rather than an optional extra.
  readonly liveVisitors: (
    windowMinutes: number,
  ) => Effect.Effect<number, AnalyticsError>
}

// Builds the adapter for one site's source. Runs once per site runtime, so this
// is where a vendor reads its API key (`Config.redacted("<PROVIDER>_API_KEY")`,
// following AHREFS_API_KEY) and fails early when it cannot work. A failure here
// does not fail the site: Analytics catches it and reports the site as not
// ready, with this error's message as the reason.
export type ProviderFactory = (
  source: AnalyticsSource,
) => Effect.Effect<Provider, AnalyticsError, HttpClient.HttpClient>

export const providers: ReadonlyMap<string, ProviderFactory> = new Map<
  string,
  ProviderFactory
>([[Rybbit.providerName, Rybbit.make]])
