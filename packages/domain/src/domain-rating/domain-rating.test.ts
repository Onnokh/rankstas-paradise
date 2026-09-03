// DomainRating service tests. No network and no database: a fake HttpClient
// returns canned Ahrefs payloads and a tiny in-memory Storage stands in for the
// ledger, so the write-then-read round trip is still exercised. The API key is
// injected through a fake ConfigProvider, so the key-absent path runs without
// touching the developer's environment.
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { Storage } from "../storage/storage.ts"
import { DomainRating } from "./domain-rating.ts"

const site = Schema.decodeUnknownSync(Site)({
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://www.example.com",
  sitemapUrl: "https://www.example.com/sitemap.xml",
  brandTerms: [],
})

// The exact shape Ahrefs returns, repeated key and all.
const payload = JSON.stringify({
  domain_rating: {
    domain_rating: 4.7,
    license: "http://ahrefs.com/legal/domain-rating-license",
  },
})

const fakeHttp = (status: number, body: string, seen?: { url?: string; auth?: string }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (seen) {
        seen.url = request.url
        seen.auth = request.headers["authorization"]
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status })),
      )
    }),
  )

// A one-row stand-in for the ledger, shared across the layers a test builds so
// a reading written by `refresh` is visible to a later `cached`.
type Stored = { rating: number; fetchedAt: string; license: string } | null

const storageStub = (cell: { value: Stored }) =>
  Layer.mock(Storage.Service)({
    saveDomainRating: (rating, fetchedAt, license) =>
      Effect.sync(() => {
        cell.value = { rating, fetchedAt, license }
      }),
    latestDomainRating: () => Effect.sync(() => cell.value),
  })

const buildLayer = (
  cell: { value: Stored },
  http: Layer.Layer<HttpClient.HttpClient>,
  env: Record<string, string> = { AHREFS_API_KEY: "test-key" },
) =>
  DomainRating.layer.pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({
        current: () => Effect.succeed(site),
      }),
    ),
    Layer.provide(storageStub(cell)),
    Layer.provide(http),
    Layer.provide(
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  )

// Each test gets its own empty ledger.
const withTemp = async <A>(fn: (cell: { value: Stored }) => Promise<A>): Promise<A> =>
  fn({ value: null })

test("refresh reads the rating, asks about the bare host, and caches it", () =>
  withTemp(async (cell) => {
    const seen: { url?: string; auth?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(cell, fakeHttp(200, payload, seen)))),
    )

    expect(reading?.rating).toBe(4.7)
    // The site's origin is a URL; Ahrefs is asked about the host alone.
    expect(seen.url).toContain("target=www.example.com")
    expect(seen.auth).toBe("Bearer test-key")

    // The reading is in the ledger, so a restart costs no quota — and the
    // series it belongs to cannot be re-fetched if it is ever lost.
    const cached = await Effect.runPromise(
      DomainRating.use
        .cached()
        .pipe(Effect.provide(buildLayer(cell, fakeHttp(500, "")))),
    )
    expect(cached?.rating).toBe(4.7)
    expect(cached?.target).toBe("www.example.com")
  }))

test("no API key yields no rating and never calls Ahrefs", () =>
  withTemp(async (cell) => {
    const seen: { url?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(cell, fakeHttp(200, payload, seen), {}))),
    )

    expect(reading).toBeNull()
    expect(seen.url).toBeUndefined()
  }))

test("a blank key counts as absent rather than becoming a 401", () =>
  withTemp(async (cell) => {
    const seen: { url?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(
          Effect.provide(
            buildLayer(cell, fakeHttp(200, payload, seen), { AHREFS_API_KEY: "  " }),
          ),
        ),
    )

    expect(reading).toBeNull()
    expect(seen.url).toBeUndefined()
  }))

test("a rejected key fails loudly rather than reading as no data", () =>
  withTemp(async (cell) => {
    const exit = await Effect.runPromiseExit(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(cell, fakeHttp(401, "nope")))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  }))

test("cached returns null when the site has no reading", () =>
  withTemp(async (cell) => {
    const cached = await Effect.runPromise(
      DomainRating.use
        .cached()
        .pipe(Effect.provide(buildLayer(cell, fakeHttp(200, payload)))),
    )
    expect(cached).toBeNull()
  }))

test("the series is keyed by day, so two syncs in one day leave one reading", () =>
  withTemp(async (cell) => {
    const layer = buildLayer(cell, fakeHttp(200, payload))
    await Effect.runPromise(DomainRating.use.refresh().pipe(Effect.provide(layer)))
    await Effect.runPromise(DomainRating.use.refresh().pipe(Effect.provide(layer)))

    // The stub holds one cell; the real table's primary key on `date` is what
    // enforces this, and `saveDomainRating` upserts rather than appending.
    expect(cell.value?.rating).toBe(4.7)
  }))
