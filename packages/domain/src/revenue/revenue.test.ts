// Revenue service tests. No vendor and no network: a fake adapter is handed in
// through the registry seam (`layerWith`), so the port itself is what gets
// exercised — the three shapes a site resolves to (no revenue, configured but
// not ready, ready) and that the dates asked for reach the adapter untouched.
import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { type ProviderFactory } from "./providers.ts"
import { Revenue } from "./revenue.ts"
import { RevenueError, type RevenueDay } from "./schema.ts"

const baseSite = {
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://www.example.com",
  sitemapUrl: "https://www.example.com/sitemap.xml",
  brandTerms: [],
}

const withRevenue = Schema.decodeUnknownSync(Site)({
  ...baseSite,
  revenue: {
    provider: "fake",
    accountId: null,
    keyVariable: "FAKE_API_KEY",
    baseUrl: null,
    timeZone: "Europe/Amsterdam",
  },
})

const withoutRevenue = Schema.decodeUnknownSync(Site)(baseSite)

const httpStub = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("", { status: 500 })),
    ),
  ),
)

const fakeFactory = (seen: { dates?: ReadonlyArray<string> }): ProviderFactory =>
  () =>
    Effect.succeed({
      fetchRevenue: (dates) =>
        Effect.sync((): ReadonlyArray<RevenueDay> => {
          seen.dates = dates
          return dates.map((date) => ({
            date,
            orders: 2,
            revenue: 3998,
            net: 3998,
            currency: "USD",
          }))
        }),
    })

const buildLayer = (site: Site, registry: ReadonlyMap<string, ProviderFactory>) =>
  Revenue.layerWith(registry).pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({ current: () => Effect.succeed(site) }),
    ),
    Layer.provide(httpStub),
  )

test("a site without a revenue source has no status, no rows, no local day", async () => {
  const layer = buildLayer(withoutRevenue, new Map())
  expect(
    await Effect.runPromise(Revenue.use.status().pipe(Effect.provide(layer))),
  ).toBeNull()
  expect(
    await Effect.runPromise(
      Revenue.use.fetchRevenue(["2026-01-01"]).pipe(Effect.provide(layer)),
    ),
  ).toEqual([])
  expect(
    await Effect.runPromise(Revenue.use.localDay().pipe(Effect.provide(layer))),
  ).toBeNull()
})

test("a ready adapter is asked for exactly the dates given", async () => {
  const seen: { dates?: ReadonlyArray<string> } = {}
  const layer = buildLayer(withRevenue, new Map([["fake", fakeFactory(seen)]]))

  const status = await Effect.runPromise(
    Revenue.use.status().pipe(Effect.provide(layer)),
  )
  const days = await Effect.runPromise(
    Revenue.use.fetchRevenue(["2026-01-02", "2026-01-01"]).pipe(Effect.provide(layer)),
  )
  const local = await Effect.runPromise(
    Revenue.use.localDay().pipe(Effect.provide(layer)),
  )

  expect(status).toEqual({ provider: "fake", accountId: null, ready: true, reason: null })
  expect(seen.dates).toEqual(["2026-01-02", "2026-01-01"])
  expect(days.map((day) => day.date)).toEqual(["2026-01-02", "2026-01-01"])
  expect(local?.timeZone).toBe("Europe/Amsterdam")
})

test("a provider with no adapter in this build is configured but not ready", async () => {
  const layer = buildLayer(withRevenue, new Map([["polar", fakeFactory({})]]))
  const status = await Effect.runPromise(
    Revenue.use.status().pipe(Effect.provide(layer)),
  )
  expect(status?.ready).toBe(false)
  expect(status?.reason).toContain('No revenue adapter for provider "fake"')
  expect(status?.reason).toContain("polar")

  const exit = await Effect.runPromiseExit(
    Revenue.use.fetchRevenue(["2026-01-01"]).pipe(Effect.provide(layer)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})

test("an adapter that cannot be built makes the site not ready with its own reason", async () => {
  const failing: ProviderFactory = () =>
    Effect.fail(new RevenueError({ message: "FAKE_API_KEY is not set." }))
  const layer = buildLayer(withRevenue, new Map([["fake", failing]]))
  const status = await Effect.runPromise(
    Revenue.use.status().pipe(Effect.provide(layer)),
  )
  expect(status).toEqual({
    provider: "fake",
    accountId: null,
    ready: false,
    reason: "FAKE_API_KEY is not set.",
  })
  // Not ready still knows what day it is for the site.
  const local = await Effect.runPromise(
    Revenue.use.localDay().pipe(Effect.provide(layer)),
  )
  expect(local?.timeZone).toBe("Europe/Amsterdam")
})
