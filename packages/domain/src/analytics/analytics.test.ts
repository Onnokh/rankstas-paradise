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
// row per date.
const fakeFactory = (seen: { dates?: ReadonlyArray<string> }): ProviderFactory =>
  () =>
    Effect.succeed({
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
