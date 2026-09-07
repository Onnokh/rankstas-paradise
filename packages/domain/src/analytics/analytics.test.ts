// Analytics service tests. No vendor and no network: a fake adapter is handed
// in through the registry seam (`layerWith`), so the port itself is what gets
// exercised — the three shapes a site resolves to (no analytics, configured but
// not ready, ready) and that the dates asked for reach the adapter untouched.
import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { Analytics } from "./analytics.ts"
import { type ProviderFactory } from "./providers.ts"
import { AnalyticsError, type VisitsDays } from "./schema.ts"

const baseSite = {
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://www.example.com",
  sitemapUrl: "https://www.example.com/sitemap.xml",
  brandTerms: [],
}

const withAnalytics = Schema.decodeUnknownSync(Site)({
  ...baseSite,
  analytics: {
    provider: "fake",
    siteId: "42",
    baseUrl: null,
    timeZone: "UTC",
  },
})

const withoutAnalytics = Schema.decodeUnknownSync(Site)(baseSite)

// The adapter never reaches the network here; the client is a stub that would
// answer 500 to anything, so a fetch that slipped through would show.
const httpStub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("", { status: 500 })),
    ),
  ),
)

// A fake adapter that records the dates it is asked for and answers one site
// row per date, and counts how often it is asked for live visitors.
const fakeFactory = (
  seen: { dates?: ReadonlyArray<string>; liveCalls?: number },
): ProviderFactory =>
  () =>
    Effect.succeed({
      fetchHours: () =>
        Effect.succeed([{ hour: 9, pageviews: 3, visits: 2, visitors: 2 }]),
      liveVisitors: () =>
        Effect.sync(() => {
          seen.liveCalls = (seen.liveCalls ?? 0) + 1
          // Three minutes of bars out of thirty: the port pads the rest.
          return { visitors: 7, online: 2, perMinute: [1, 0, 2] }
        }),
      fetchVisits: (dates) =>
        Effect.sync((): VisitsDays => {
          seen.dates = dates
          return {
            site: dates.map((date) => ({
              date,
              pageviews: 10,
              visits: 5,
              visitors: 4,
            })),
            pages: [],
            events: [],
          }
        }),
    })

const buildLayer = (
  site: Site,
  registry: ReadonlyMap<string, ProviderFactory>,
) =>
  Analytics.layerWith(registry).pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({
        current: () => Effect.succeed(site),
      }),
    ),
    Layer.provide(httpStub),
  )

test("a site without analytics has no status and yields empty rows", async () => {
  const layer = buildLayer(withoutAnalytics, new Map())
  const status = await Effect.runPromise(
    Analytics.use.status().pipe(Effect.provide(layer)),
  )
  const visits = await Effect.runPromise(
    Analytics.use.fetchVisits(["2026-01-01"]).pipe(Effect.provide(layer)),
  )

  expect(status).toBeNull()
  expect(visits).toEqual({ site: [], pages: [], events: [] })
})

test("a ready adapter is asked for exactly the dates given", async () => {
  const seen: { dates?: ReadonlyArray<string> } = {}
  const layer = buildLayer(
    withAnalytics,
    new Map([["fake", fakeFactory(seen)]]),
  )

  const status = await Effect.runPromise(
    Analytics.use.status().pipe(Effect.provide(layer)),
  )
  const visits = await Effect.runPromise(
    Analytics.use
      .fetchVisits(["2026-01-02", "2026-01-01"])
      .pipe(Effect.provide(layer)),
  )

  expect(status).toEqual({
    provider: "fake",
    siteId: "42",
    ready: true,
    reason: null,
  })
  expect(seen.dates).toEqual(["2026-01-02", "2026-01-01"])
  expect(visits.site.map((day) => day.date)).toEqual([
    "2026-01-02",
    "2026-01-01",
  ])
})

test("live visitors come from the adapter once per cache window", async () => {
  const seen: { liveCalls?: number } = {}
  const layer = buildLayer(
    withAnalytics,
    new Map([["fake", fakeFactory(seen)]]),
  )

  const first = await Effect.runPromise(
    Analytics.use.liveVisitors().pipe(Effect.provide(layer)),
  )
  const second = await Effect.runPromise(
    Analytics.use.liveVisitors().pipe(Effect.provide(layer)),
  )

  expect(first?.visitors).toBe(7)
  expect(first?.windowMinutes).toBe(30)
  expect(first?.online).toBe(2)
  expect(first?.onlineWindowMinutes).toBe(5)
  expect(first?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  // One bar per minute of the window, oldest first, the adapter's three at the
  // end and zeros before them.
  expect(first?.series).toHaveLength(30)
  expect(first?.series?.slice(-3)).toEqual([1, 0, 2])
  expect(first?.series?.slice(0, 27).every((n) => n === 0)).toBe(true)
  // Two separate layers here, so two lookups; within one layer the second read
  // is served from the 30-second memo — see the next assertion.
  expect(seen.liveCalls).toBe(2)
  expect(second?.visitors).toBe(7)

  const memo: { liveCalls?: number } = {}
  const program = Effect.gen(function* () {
    yield* Analytics.use.liveVisitors()
    yield* Analytics.use.liveVisitors()
    return yield* Analytics.use.liveVisitors()
  }).pipe(Effect.provide(buildLayer(withAnalytics, new Map([["fake", fakeFactory(memo)]]))))
  const third = await Effect.runPromise(program)
  expect(third?.visitors).toBe(7)
  expect(memo.liveCalls).toBe(1)
})

test("today is the provider's day in the site's zone, padded to 24 hours", async () => {
  const seen: { dates?: ReadonlyArray<string> } = {}
  const layer = buildLayer(withAnalytics, new Map([["fake", fakeFactory(seen)]]))
  const today = await Effect.runPromise(
    Analytics.use.today().pipe(Effect.provide(layer)),
  )
  expect(today?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(today?.timeZone).toBe("UTC")
  // The adapter was asked for exactly today.
  expect(seen.dates).toEqual([today!.date])
  expect(today?.site?.date).toBe(today!.date)
  expect(today?.hoursElapsed).toBeGreaterThanOrEqual(1)
  expect(today?.hoursElapsed).toBeLessThanOrEqual(24)
  // One entry per hour, the adapter's 09:00 in place and zeros elsewhere.
  expect(today?.hours).toHaveLength(24)
  expect(today?.hours[9]).toEqual({ hour: 9, pageviews: 3, visits: 2, visitors: 2 })
  expect(today?.hours[8]).toEqual({ hour: 8, pageviews: 0, visits: 0, visitors: 0 })
  expect(today?.pages).toEqual([])
  expect(today?.events).toEqual([])
})

test("a site without analytics has no today", async () => {
  const layer = buildLayer(withoutAnalytics, new Map())
  expect(
    await Effect.runPromise(Analytics.use.today().pipe(Effect.provide(layer))),
  ).toBeNull()
})

test("a site without analytics has no live visitors", async () => {
  const layer = buildLayer(withoutAnalytics, new Map())
  const live = await Effect.runPromise(
    Analytics.use.liveVisitors().pipe(Effect.provide(layer)),
  )
  expect(live).toBeNull()
})

test("an empty date list never reaches the adapter", async () => {
  const seen: { dates?: ReadonlyArray<string> } = {}
  const layer = buildLayer(
    withAnalytics,
    new Map([["fake", fakeFactory(seen)]]),
  )

  const visits = await Effect.runPromise(
    Analytics.use.fetchVisits([]).pipe(Effect.provide(layer)),
  )

  expect(visits).toEqual({ site: [], pages: [], events: [] })
  expect(seen.dates).toBeUndefined()
})

test("a provider with no adapter in the build is configured but not ready", async () => {
  const layer = buildLayer(
    withAnalytics,
    new Map([["other", fakeFactory({})]]),
  )

  const status = await Effect.runPromise(
    Analytics.use.status().pipe(Effect.provide(layer)),
  )
  const exit = await Effect.runPromiseExit(
    Analytics.use.fetchVisits(["2026-01-01"]).pipe(Effect.provide(layer)),
  )

  expect(status?.ready).toBe(false)
  expect(status?.reason).toContain('"fake"')
  expect(status?.reason).toContain("other")
  expect(Exit.isFailure(exit)).toBe(true)
})

test("an adapter that cannot be built makes the site not ready, not broken", async () => {
  const failing: ProviderFactory = () =>
    Effect.fail(new AnalyticsError({ message: "FAKE_API_KEY is not set." }))
  const layer = buildLayer(withAnalytics, new Map([["fake", failing]]))

  // The layer itself builds — a site with a bad key still serves its reports.
  const status = await Effect.runPromise(
    Analytics.use.status().pipe(Effect.provide(layer)),
  )
  const exit = await Effect.runPromiseExit(
    Analytics.use.fetchVisits(["2026-01-01"]).pipe(Effect.provide(layer)),
  )

  expect(status).toEqual({
    provider: "fake",
    siteId: "42",
    ready: false,
    reason: "FAKE_API_KEY is not set.",
  })
  expect(Exit.isFailure(exit)).toBe(true)
})
