// Analytics service: the site's web-analytics provider behind one port.
// Site-scoped — it reads the active site's `analytics` source from CurrentSite
// and builds the matching adapter from the provider registry once, at layer
// acquisition. Sync calls `fetchVisits`; Reports call `status`. Neither ever
// sees a vendor.
//
// The service is optional by design, in the same way Domain Rating is. A site
// with no `analytics` block yields empty rows and a null status, and nothing
// downstream treats that as an error. A site whose provider cannot be used
// still gets a working runtime: `status` says why it is not ready, and only
// `fetchVisits` fails — which Sync forks and swallows, so a bad key can never
// cost a site its Search Console refresh.
import { Cache, Context, Duration, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type Provider,
  type ProviderFactory,
  providers as defaultProviders,
} from "./providers.ts"
import {
  AnalyticsError,
  type AnalyticsSource,
  type AnalyticsStatus,
  emptyVisitsDays,
  type LiveVisitors,
  liveWindowMinutes,
  type VisitsDays,
} from "./schema.ts"

// How long one live answer is served before the provider is asked again. A
// client polling every few seconds costs the vendor one call per half minute.
const liveCacheTtl = Duration.seconds(30)

// Exactly `length` minutes, oldest first: an adapter's series is trimmed to its
// newest `length` entries or padded with leading zeros, so a client can draw
// one bar per minute without counting. Negative or non-finite counts read as 0.
const normaliseSeries = (
  perMinute: ReadonlyArray<number>,
  length: number,
): ReadonlyArray<number> => {
  const clean = perMinute.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  )
  const newest = clean.slice(-length)
  return [...Array<number>(length - newest.length).fill(0), ...newest]
}

export interface Interface {
  // The site's configured analytics, or null when it has none. Never fails and
  // never reaches the network: this is what report reads call.
  readonly status: () => Effect.Effect<AnalyticsStatus | null>
  // Canonical visit counts for the given dates. Empty for a site with no
  // analytics; fails with the not-ready reason for a site whose provider could
  // not be set up, or with the adapter's error when the vendor call fails.
  readonly fetchVisits: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<VisitsDays, AnalyticsError>
  // The visitors active right now, fetched from the provider and cached for 30
  // seconds. Null for a site with no analytics. This DOES reach the network on
  // a read, unlike every other read in the domain, so it has its own report
  // and its own endpoint and is never part of the dashboard snapshot.
  readonly liveVisitors: () => Effect.Effect<LiveVisitors | null, AnalyticsError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Analytics",
) {}

export const use = serviceUse(Service)

// --- the three shapes a site can resolve to ---

const none: Interface = {
  status: () => Effect.succeed(null),
  fetchVisits: () => Effect.succeed(emptyVisitsDays),
  liveVisitors: () => Effect.succeed(null),
}

const notReady = (source: AnalyticsSource, reason: string): Interface => ({
  status: () =>
    Effect.succeed({
      provider: source.provider,
      siteId: source.siteId,
      ready: false,
      reason,
    }),
  fetchVisits: () => Effect.fail(new AnalyticsError({ message: reason })),
  liveVisitors: () => Effect.fail(new AnalyticsError({ message: reason })),
})

const ready = (source: AnalyticsSource, provider: Provider) =>
  Effect.gen(function* () {
    // One entry, one key: the cache is only a 30-second memo of the last live
    // answer, so several clients polling at once cost the vendor one call.
    const live = yield* Cache.make<"live", LiveVisitors, AnalyticsError>({
      capacity: 1,
      timeToLive: liveCacheTtl,
      lookup: () =>
        provider.liveVisitors(liveWindowMinutes).pipe(
          Effect.map((sample) => ({
            visitors: sample.visitors,
            windowMinutes: liveWindowMinutes,
            series: normaliseSeries(sample.perMinute, liveWindowMinutes),
            fetchedAt: new Date().toISOString(),
          })),
        ),
    })
    const impl: Interface = {
      status: () =>
        Effect.succeed({
          provider: source.provider,
          siteId: source.siteId,
          ready: true,
          reason: null,
        }),
      fetchVisits: Effect.fn("Analytics.fetchVisits")(function* (dates) {
        if (dates.length === 0) return emptyVisitsDays
        return yield* provider.fetchVisits(dates)
      }),
      liveVisitors: Effect.fn("Analytics.liveVisitors")(function* () {
        return yield* Cache.get(live, "live")
      }),
    }
    return impl
  })

// The layer over an explicit registry. Production uses `layer` (the real
// registry); tests hand in a fake adapter to exercise the port without a vendor.
export const layerWith = (registry: ReadonlyMap<string, ProviderFactory>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const currentSite = yield* CurrentSite.Service
      const httpClient = yield* HttpClient.HttpClient
      const site = yield* currentSite.current()
      const source = site.analytics
      if (!source) return none

      const factory = registry.get(source.provider)
      if (!factory) {
        const known = [...registry.keys()]
        return notReady(
          source,
          `No analytics adapter for provider "${source.provider}" in this build` +
            (known.length > 0 ? ` (known: ${known.join(", ")}).` : "."),
        )
      }

      // A factory that cannot build (no key, bad base URL) must not fail the
      // whole site runtime; it makes the site not-ready with its own message.
      return yield* factory(source).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.flatMap((provider) => ready(source, provider)),
        Effect.catchTag("AnalyticsError", (error) =>
          Effect.succeed(notReady(source, error.message)),
        ),
      )
    }),
  )

export const layer = layerWith(defaultProviders)

export const defaultLayer = layer.pipe(
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as Analytics from "./analytics"
