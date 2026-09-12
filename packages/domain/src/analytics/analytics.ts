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
  type LiveEvent,
  type LiveEvents,
  liveEventsLimit,
  type LiveVisitors,
  liveWindowMinutes,
  onlineWindowMinutes,
  type SiteVisitsHour,
  type VisitorHistory,
  visitorHistoryLimit,
  type VisitsDays,
} from "./schema.ts"

// How long one live answer is served before the provider is asked again. A
// client polling every few seconds costs the vendor one call per half minute.
const liveCacheTtl = Duration.seconds(30)
// The feed moves faster than the count: a new row should show within a few
// seconds, so its memo is short. Still one vendor call per five seconds however
// many windows poll.
const liveEventsCacheTtl = Duration.seconds(5)
// A visitor's history is an all-time aggregate: it moves when they start a new
// visit, not between two polls. Its own memo, a minute long, keeps the feed's
// five-second poll from asking the vendor for it twelve times over.
const visitorHistoryCacheTtl = Duration.minutes(1)

// The provider's calendar day right now: its date, how far into it the site's
// zone is, and the zone itself. What "today" means for a site.
export interface LocalDay {
  readonly date: string
  readonly hour: number
  readonly timeZone: string
}

// The calendar day and hour right now in a zone, as the provider counts them.
// An unknown zone falls back to UTC rather than failing the read.
export const localDayIn = (timeZone: string): LocalDay => {
  const parts = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date())
  let fields: Intl.DateTimeFormatPart[]
  try {
    fields = parts(timeZone)
  } catch {
    fields = parts("UTC")
  }
  const get = (type: string) => fields.find((part) => part.type === type)?.value ?? "00"
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    timeZone,
  }
}

// Exactly 24 hours, 0 first, zeros where the ledger had no row.
export const normaliseHours = (
  hours: ReadonlyArray<SiteVisitsHour>,
): ReadonlyArray<SiteVisitsHour> => {
  const byHour = new Map(hours.map((row) => [row.hour, row]))
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour)
    return {
      hour,
      pageviews: row?.pageviews ?? 0,
      visits: row?.visits ?? 0,
      visitors: row?.visitors ?? 0,
    }
  })
}

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
  // What visitors did in the last 30 minutes, newest first, fetched from the
  // provider and cached for a few seconds. Null for a site with no analytics.
  // With `since` (an ISO instant) only the rows newer than it are returned,
  // filtered from the same memo, so a polling client pays for one vendor call
  // per memo however often it asks. Reaches the network like liveVisitors.
  // The answer carries `visitors`: what the provider knows about the people
  // behind the rows, over their whole history rather than the window, which is
  // what says a visitor is returning. Empty when the provider cannot say —
  // never a reason for the feed itself to fail.
  readonly liveEvents: (
    since?: string,
  ) => Effect.Effect<LiveEvents | null, AnalyticsError>
  // What day it is for the site right now, in its provider's zone. Null for a
  // site with no analytics. Never reaches the network.
  readonly localDay: () => Effect.Effect<LocalDay | null>
  // One day's site totals by the hour, for Sync to write into the ledger.
  // Empty for a site with no analytics; fails like fetchVisits otherwise.
  readonly fetchHours: (
    date: string,
  ) => Effect.Effect<ReadonlyArray<SiteVisitsHour>, AnalyticsError>
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
  liveEvents: () => Effect.succeed(null),
  localDay: () => Effect.succeed(null),
  fetchHours: () => Effect.succeed([]),
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
  liveEvents: () => Effect.fail(new AnalyticsError({ message: reason })),
  localDay: () => Effect.sync(() => localDayIn(source.timeZone)),
  fetchHours: () => Effect.fail(new AnalyticsError({ message: reason })),
})

// The rows newer than `since`, or all of them without one. A cut-off that is
// not an instant is ignored rather than failing the read: the client gets the
// whole window and its next poll carries a good one.
const newerThan = (
  events: ReadonlyArray<LiveEvent>,
  since: string | undefined,
): ReadonlyArray<LiveEvent> => {
  if (since === undefined) return events
  const cutoff = new Date(since).getTime()
  if (Number.isNaN(cutoff)) return events
  return events.filter((event) => new Date(event.at).getTime() > cutoff)
}

const ready = (source: AnalyticsSource, provider: Provider) =>
  Effect.gen(function* () {
    // One entry, one key: the cache is only a 30-second memo of the last live
    // answer, so several clients polling at once cost the vendor one call.
    const live = yield* Cache.make<"live", LiveVisitors, AnalyticsError>({
      capacity: 1,
      timeToLive: liveCacheTtl,
      lookup: () =>
        provider.liveVisitors(liveWindowMinutes, onlineWindowMinutes).pipe(
          Effect.map((sample) => ({
            visitors: sample.visitors,
            windowMinutes: liveWindowMinutes,
            online: sample.online,
            onlineWindowMinutes,
            series: normaliseSeries(sample.perMinute, liveWindowMinutes),
            fetchedAt: new Date().toISOString(),
          })),
        ),
    })
    // The feed's memo, the same way: one key, a few seconds.
    const feed = yield* Cache.make<
      "events",
      { events: ReadonlyArray<LiveEvent>; fetchedAt: string },
      AnalyticsError
    >({
      capacity: 1,
      timeToLive: liveEventsCacheTtl,
      lookup: () =>
        provider.liveEvents(liveWindowMinutes, liveEventsLimit).pipe(
          Effect.map((events) => ({ events, fetchedAt: new Date().toISOString() })),
        ),
    })
    // The histories, on their own slower memo. A vendor that cannot answer them
    // has no method to call, and one that fails answering them costs the feed
    // its badges and nothing else: the rows matter, the labels on them do not
    // matter enough to lose the rows over. So this lookup never fails.
    const histories = yield* Cache.make<"visitors", ReadonlyArray<VisitorHistory>>({
      capacity: 1,
      timeToLive: visitorHistoryCacheTtl,
      lookup: () =>
        provider.visitorHistory === undefined
          ? Effect.succeed<ReadonlyArray<VisitorHistory>>([])
          : provider.visitorHistory(visitorHistoryLimit).pipe(
              Effect.catchTag("AnalyticsError", (error) =>
                Effect.logWarning(
                  `Visitor histories could not be read for ${source.provider} site ` +
                    `"${source.siteId}", so the feed shows no visit counts: ${error.message}`,
                ).pipe(Effect.as<ReadonlyArray<VisitorHistory>>([])),
              ),
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
      liveEvents: Effect.fn("Analytics.liveEvents")(function* (since) {
        const sample = yield* Cache.get(feed, "events")
        // Every history the memo holds, not only those of the rows that
        // survived `since`: a polling client keeps the earlier rows on screen
        // and has to be able to label them too.
        const visitors = yield* Cache.get(histories, "visitors")
        return {
          windowMinutes: liveWindowMinutes,
          since: since ?? null,
          events: newerThan(sample.events, since),
          visitors,
          fetchedAt: sample.fetchedAt,
        }
      }),
      localDay: () => Effect.sync(() => localDayIn(source.timeZone)),
      fetchHours: Effect.fn("Analytics.fetchHours")(function* (date) {
        return yield* provider.fetchHours(date)
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
