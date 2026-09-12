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
  type LiveEvent,
  type VisitorHistory,
  type VisitsDays,
  type SiteVisitsHour,
} from "./schema.ts"

// What an adapter must produce: canonical rows for exactly the dates asked. How
// many vendor calls that takes is the adapter's business — Rybbit and Umami
// need one call per day for the per-page breakdown, GA4 answers a whole range
// in one report — so the port takes a list of dates and never a single day.
export interface Provider {
  readonly fetchVisits: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<VisitsDays, AnalyticsError>
  // Distinct visitors active in the last `windowMinutes`, how many were seen
  // in each of those minutes (oldest first, one entry per minute, zeros for
  // quiet ones), and the distinct visitors of the last `onlineMinutes` — the
  // ones on the site right now. Every vendor in scope answers all three —
  // Rybbit's live-user-count and minute-bucketed time-series, Umami's active
  // and minute-unit pageviews, GA4's realtime report by minutesAgo — so this
  // is part of the contract rather than an optional extra.
  readonly liveVisitors: (
    windowMinutes: number,
    onlineMinutes: number,
  ) => Effect.Effect<LiveSample, AnalyticsError>

  // One day's site totals by the hour, in the site's zone: the shape of a
  // "today" view. Rybbit buckets its time-series by hour, Umami has
  // unit=hour, GA4 has the hour dimension. Hours the provider omits are quiet.
  readonly fetchHours: (
    date: string,
  ) => Effect.Effect<ReadonlyArray<SiteVisitsHour>, AnalyticsError>

  // What visitors did in the last `windowMinutes`, newest first, at most
  // `limit` rows: the rows of a live feed. Rybbit lists events since a
  // timestamp, Umami has a per-website events list, GA4's realtime report can
  // be asked by event name and minutesAgo (coarser, but the same shape), so
  // this too is part of the contract. An adapter that cannot say who or where
  // fills those fields with null rather than failing.
  readonly liveEvents: (
    windowMinutes: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<LiveEvent>, AnalyticsError>

  // What the vendor knows about its most recently active visitors, newest
  // first, at most `limit` of them: the histories that say which of the feed's
  // people are returning. OPTIONAL, unlike everything above it — this is the
  // one question the vendors in scope do not all answer. Rybbit aggregates a
  // visitor's sessions and Umami counts a session's visits, but GA4 has only a
  // new-versus-returning dimension and no per-visitor count, so an adapter that
  // cannot answer leaves this out and the port reports no histories rather than
  // a wrong number.
  readonly visitorHistory?: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<VisitorHistory>, AnalyticsError>
}

export interface LiveSample {
  readonly visitors: number
  readonly online: number
  readonly perMinute: ReadonlyArray<number>
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
