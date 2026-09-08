// Revenue service: the site's commerce provider behind one port. Site-scoped —
// it reads the active site's `revenue` source from CurrentSite and builds the
// matching adapter from the provider registry once, at layer acquisition.
// Sync calls `fetchRevenue`; Reports call `status`. Neither ever sees a vendor.
//
// Optional by design, like Analytics: a site with no `revenue` block yields
// empty rows and a null status, and nothing downstream treats that as an
// error. A site whose provider cannot be used still gets a working runtime:
// `status` says why it is not ready, and only `fetchRevenue` fails — which
// Sync forks and swallows, so a bad key can never cost a site its Search
// Console refresh.
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { type LocalDay, localDayIn } from "../analytics/analytics.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type Provider,
  type ProviderFactory,
  providers as defaultProviders,
} from "./providers.ts"
import {
  type RevenueDay,
  RevenueError,
  type RevenueSource,
  type RevenueStatus,
} from "./schema.ts"

export interface Interface {
  // The site's configured revenue source, or null when it has none. Never
  // fails and never reaches the network: this is what report reads call.
  readonly status: () => Effect.Effect<RevenueStatus | null>
  // Canonical rows for the given dates. Empty for a site with no revenue
  // source; fails with the not-ready reason for a site whose provider could
  // not be set up, or with the adapter's error when the vendor call fails.
  readonly fetchRevenue: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<RevenueDay>, RevenueError>
  // What day it is for the site right now, in its provider's zone. Null for a
  // site with no revenue source. Never reaches the network.
  readonly localDay: () => Effect.Effect<LocalDay | null>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Revenue",
) {}

export const use = serviceUse(Service)

// --- the three shapes a site can resolve to ---

const none: Interface = {
  status: () => Effect.succeed(null),
  fetchRevenue: () => Effect.succeed([]),
  localDay: () => Effect.succeed(null),
}

const notReady = (source: RevenueSource, reason: string): Interface => ({
  status: () =>
    Effect.succeed({
      provider: source.provider,
      accountId: source.accountId,
      ready: false,
      reason,
    }),
  fetchRevenue: () => Effect.fail(new RevenueError({ message: reason })),
  localDay: () => Effect.sync(() => localDayIn(source.timeZone)),
})

const ready = (source: RevenueSource, provider: Provider): Interface => ({
  status: () =>
    Effect.succeed({
      provider: source.provider,
      accountId: source.accountId,
      ready: true,
      reason: null,
    }),
  fetchRevenue: Effect.fn("Revenue.fetchRevenue")(function* (dates) {
    if (dates.length === 0) return []
    return yield* provider.fetchRevenue(dates)
  }),
  localDay: () => Effect.sync(() => localDayIn(source.timeZone)),
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
      const source = site.revenue
      if (!source) return none

      const factory = registry.get(source.provider)
      if (!factory) {
        const known = [...registry.keys()]
        return notReady(
          source,
          `No revenue adapter for provider "${source.provider}" in this build` +
            (known.length > 0 ? ` (known: ${known.join(", ")}).` : "."),
        )
      }

      // A factory that cannot build (no key, bad base URL) must not fail the
      // whole site runtime; it makes the site not-ready with its own message.
      return yield* factory(source).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.map((provider) => ready(source, provider)),
        Effect.catchTag("RevenueError", (error) =>
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

export * as Revenue from "./revenue"
