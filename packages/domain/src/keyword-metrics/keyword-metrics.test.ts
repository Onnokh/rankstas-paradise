// KeywordMetrics service tests. No network and no database: a fake HttpClient
// returns canned DataForSEO payloads and an in-memory Map stands in for the
// store, so the write-then-read round trip is still exercised. The API key is
// injected through a fake ConfigProvider, so the key-absent path runs without
// touching the developer's environment.
//
// The tests that matter most here are the ones about *not* calling: every
// keyword sent costs money, and a rejected request costs the same as an
// accepted one.
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { Storage } from "../storage/storage.ts"
import { KeywordMetrics } from "./keyword-metrics.ts"
import { type KeywordMetric } from "./schema.ts"

const siteIn = (locationCode: number, languageCode: string, provider: string) =>
  Schema.decodeUnknownSync(Site)({
    id: "test",
    name: "Test Site",
    property: "sc-domain:example.com",
    origin: "https://www.example.com",
    sitemapUrl: "https://www.example.com/sitemap.xml",
    brandTerms: ["example", "exampleco"],
    market: { locationCode, languageCode, label: "Test Market", provider },
  })

const unitedStates = siteIn(2840, "en", "labs")
const andorra = siteIn(2020, "ca", "google-ads")
// The Netherlands is served in Dutch only, so this pair is one DataForSEO
// would reject — and charge for.
const unserved = siteIn(2528, "de", "labs")

// One Labs item, with the nesting DataForSEO actually uses.
const labsItem = (keyword: string, volume: number, difficulty: number) => ({
  keyword,
  keyword_info: {
    search_volume: volume,
    cpc: 1.25,
    competition: 0.42,
    monthly_searches: [
      { year: 2026, month: 8, search_volume: volume },
      { year: 2026, month: 7, search_volume: volume - 10 },
    ],
  },
  keyword_properties: { keyword_difficulty: difficulty },
  search_intent_info: { main_intent: "informational" },
})

const labsBody = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({
    status_code: 20000,
    tasks: [{ status_code: 20000, result: [{ items }] }],
  })

// Google Ads puts its items straight in `result`, one level shallower than
// Labs, and reports competition as a 0-100 index.
const adsBody = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({
    status_code: 20000,
    tasks: [{ status_code: 20000, result: items }],
  })

interface Call {
  readonly url: string
  readonly auth: string | undefined
  readonly payload: {
    readonly keywords?: ReadonlyArray<string>
    readonly location_code?: number
    readonly language_code?: string
    readonly include_clickstream_data?: boolean
  }
}

// Answers each request with the next queued body, or repeats the last one when
// the queue runs dry, and records what was sent.
const fakeHttp = (
  calls: Array<Call>,
  responses: ReadonlyArray<{ status: number; body: string }>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const raw =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : "[{}]"
      calls.push({
        url: request.url,
        auth: request.headers["authorization"],
        payload: (JSON.parse(raw) as ReadonlyArray<Call["payload"]>)[0] ?? {},
      })
      const next = responses[calls.length - 1] ?? responses[responses.length - 1]!
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(next.body, { status: next.status })),
      )
    }),
  )

// A Map keyed the way the table is, so a second `refresh` sees what the first
// one wrote and the freshness cutoff is exercised for real.
type Store = Map<string, KeywordMetric>

const storageStub = (store: Store) =>
  Layer.mock(Storage.Service)({
    saveKeywordMetrics: (metrics) =>
      Effect.sync(() => {
        for (const metric of metrics)
          store.set(
            `${metric.keyword}|${metric.locationCode}|${metric.languageCode}`,
            metric,
          )
      }),
    keywordMetrics: (locationCode, languageCode) =>
      Effect.sync(() =>
        [...store.values()].filter(
          (metric) =>
            metric.locationCode === locationCode &&
            metric.languageCode === languageCode,
        ),
      ),
  })

const buildLayer = (
  store: Store,
  http: Layer.Layer<HttpClient.HttpClient>,
  site = unitedStates,
  env: Record<string, string> = { DATAFORSEO_API_KEY: "test-key" },
) =>
  KeywordMetrics.layer.pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({ current: () => Effect.succeed(site) }),
    ),
    Layer.provide(storageStub(store)),
    Layer.provide(http),
    Layer.provide(
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  )

test("refresh asks Labs, stores the answer, and cached reads it back", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const http = fakeHttp(calls, [
    { status: 200, body: labsBody([labsItem("wow mount tracker", 480, 17)]) },
  ])

  const summary = await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["WoW Mount Tracker"])
      .pipe(Effect.provide(buildLayer(store, http))),
  )

  expect(summary).toEqual({ asked: 1, answered: 1, requests: 1 })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toContain("/v3/dataforseo_labs/google/keyword_overview/live")
  expect(calls[0]!.auth).toBe("Basic test-key")
  // The candidate was folded before it was sent, so the same keyword typed
  // three ways is paid for once and joins to one row.
  expect(calls[0]!.payload.keywords).toEqual(["wow mount tracker"])
  expect(calls[0]!.payload.location_code).toBe(2840)
  expect(calls[0]!.payload.language_code).toBe("en")
  // Clickstream data doubles the price of a request, so it must stay off.
  expect(calls[0]!.payload.include_clickstream_data).toBe(false)

  const cached = await Effect.runPromise(
    KeywordMetrics.use
      .cached()
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], [{ status: 500, body: "" }])))),
  )
  const metric = cached.get("wow mount tracker")
  expect(metric?.searchVolume).toBe(480)
  expect(metric?.difficulty).toBe(17)
  expect(metric?.costPerClick).toBe(1.25)
  expect(metric?.competition).toBe(0.42)
  expect(metric?.intent).toBe("informational")
  expect(metric?.monthlySearches).toHaveLength(2)
})

test("no API key yields no metrics and never calls DataForSEO", async () => {
  const calls: Array<Call> = []
  const summary = await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["wow mount tracker"])
      .pipe(
        Effect.provide(
          buildLayer(new Map(), fakeHttp(calls, [{ status: 200, body: labsBody([]) }]), unitedStates, {}),
        ),
      ),
  )

  expect(summary).toBeNull()
  expect(calls).toHaveLength(0)
})

test("a blank key counts as absent rather than becoming a 401", async () => {
  const calls: Array<Call> = []
  const summary = await Effect.runPromise(
    KeywordMetrics.use.refresh(["wow mount tracker"]).pipe(
      Effect.provide(
        buildLayer(
          new Map(),
          fakeHttp(calls, [{ status: 200, body: labsBody([]) }]),
          unitedStates,
          { DATAFORSEO_API_KEY: "  " },
        ),
      ),
    ),
  )

  expect(summary).toBeNull()
  expect(calls).toHaveLength(0)
})

test("Brand queries and Operator queries are never paid for", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const http = fakeHttp(calls, [
    { status: 200, body: labsBody([labsItem("wow mount tracker", 480, 17)]) },
  ])

  const summary = await Effect.runPromise(
    KeywordMetrics.use
      .refresh([
        "wow mount tracker",
        // A Brand query: volume on your own name is not a decision waiting on
        // data, and DataForSEO charges per row.
        "example login",
        "ExampleCo reviews",
        // An Operator query: not a search term at all.
        "site:www.example.com",
        "(example.com) (site:example.com)",
        // Blank and whitespace candidates are not keywords either.
        "   ",
      ])
      .pipe(Effect.provide(buildLayer(store, http))),
  )

  expect(summary?.asked).toBe(1)
  expect(calls[0]!.payload.keywords).toEqual(["wow mount tracker"])
})

test("a keyword with a fresh answer is not asked about again", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const http = fakeHttp(calls, [
    { status: 200, body: labsBody([labsItem("wow mount tracker", 480, 17)]) },
    { status: 200, body: labsBody([labsItem("wow mount list", 90, 9)]) },
  ])

  await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["wow mount tracker"])
      .pipe(Effect.provide(buildLayer(store, http))),
  )

  // Same keyword plus a new one: only the new one is worth a row.
  const second = await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["wow mount tracker", "wow mount list"])
      .pipe(Effect.provide(buildLayer(store, http))),
  )

  expect(second?.asked).toBe(1)
  expect(calls[1]!.payload.keywords).toEqual(["wow mount list"])

  // Nothing left to ask about means nothing is sent at all.
  const third = await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["wow mount tracker", "wow mount list"])
      .pipe(Effect.provide(buildLayer(store, http))),
  )
  expect(third).toEqual({ asked: 0, answered: 0, requests: 0 })
  expect(calls).toHaveLength(2)
})

test("a stored answer past the refresh interval is asked about again", async () => {
  const store: Store = new Map()
  const stale = new Date(
    Date.now() - (KeywordMetrics.refreshAfterDays + 1) * 24 * 60 * 60 * 1000,
  ).toISOString()
  store.set("wow mount tracker|2840|en", {
    keyword: "wow mount tracker",
    locationCode: 2840,
    languageCode: "en",
    searchVolume: 100,
    difficulty: 10,
    costPerClick: null,
    competition: null,
    intent: null,
    monthlySearches: [],
    fetchedAt: stale,
  })

  const calls: Array<Call> = []
  const summary = await Effect.runPromise(
    KeywordMetrics.use.refresh(["wow mount tracker"]).pipe(
      Effect.provide(
        buildLayer(store, fakeHttp(calls, [
          { status: 200, body: labsBody([labsItem("wow mount tracker", 480, 17)]) },
        ])),
      ),
    ),
  )

  expect(summary?.asked).toBe(1)
  // The overwrite is the point: this is a cache, so the stale volume is
  // replaced rather than kept beside the new one as history.
  expect(store.get("wow mount tracker|2840|en")?.searchVolume).toBe(480)
})

test("a Google-Ads Market uses the other endpoint and reports no difficulty", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const http = fakeHttp(calls, [
    {
      status: 200,
      body: adsBody([
        {
          keyword: "wow mount tracker",
          search_volume: 210,
          cpc: 0.8,
          competition: "MEDIUM",
          competition_index: 55,
          monthly_searches: [{ year: 2026, month: 8, search_volume: 210 }],
        },
      ]),
    },
  ])

  await Effect.runPromise(
    KeywordMetrics.use
      .refresh(["wow mount tracker"])
      .pipe(Effect.provide(buildLayer(store, http, andorra))),
  )

  expect(calls[0]!.url).toContain("/v3/keywords_data/google_ads/search_volume/live")
  const metric = store.get("wow mount tracker|2020|ca")
  expect(metric?.searchVolume).toBe(210)
  // Google Ads does not measure organic difficulty, and this must be null
  // rather than derived from the paid competition index — a different question
  // with a similar-looking answer.
  expect(metric?.difficulty).toBeNull()
  expect(metric?.intent).toBeNull()
  // Their 0-100 index is stored as the 0-1 ratio Labs reports, so one column
  // means one thing whichever product answered.
  expect(metric?.competition).toBe(0.55)
})

test("an unserved Market is refused before anything is billed", async () => {
  const calls: Array<Call> = []
  const exit = await Effect.runPromiseExit(
    KeywordMetrics.use
      .refresh(["kachelofen kaufen"])
      .pipe(
        Effect.provide(
          buildLayer(new Map(), fakeHttp(calls, [{ status: 200, body: labsBody([]) }]), unserved),
        ),
      ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  // Nothing was sent: DataForSEO charges for rejecting a pair it does not
  // serve, so this check is the whole point of holding the country table.
  expect(calls).toHaveLength(0)
})

test("a failed task fails loudly rather than reading as no keywords matched", async () => {
  // Task failures ride inside an HTTP 200, and a failed task is still a
  // charged task. An empty result array and a rejected request are
  // indistinguishable from the stored side, so the status codes have to speak.
  const calls: Array<Call> = []
  const exit = await Effect.runPromiseExit(
    KeywordMetrics.use.refresh(["wow mount tracker"]).pipe(
      Effect.provide(
        buildLayer(new Map(), fakeHttp(calls, [
          {
            status: 200,
            body: JSON.stringify({
              status_code: 20000,
              tasks: [
                { status_code: 40501, status_message: "Invalid Field: 'language_code'." },
              ],
            }),
          },
        ])),
      ),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
})

test("a rejected key fails loudly rather than reading as no data", async () => {
  const exit = await Effect.runPromiseExit(
    KeywordMetrics.use.refresh(["wow mount tracker"]).pipe(
      Effect.provide(
        buildLayer(new Map(), fakeHttp([], [{ status: 401, body: "" }])),
      ),
    ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
})

test("a batch over the cap is split, and a later failure keeps what was paid for", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const many = Array.from({ length: 900 }, (_, index) => `keyword ${index}`)
  const http = fakeHttp(calls, [
    { status: 200, body: labsBody([labsItem("keyword 0", 10, 1)]) },
    { status: 500, body: "" },
  ])

  const exit = await Effect.runPromiseExit(
    KeywordMetrics.use.refresh(many).pipe(Effect.provide(buildLayer(store, http))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  // Two requests, split at the 700-keyword cap DataForSEO enforces. Exceeding
  // it is a rejected task, which is charged.
  expect(calls).toHaveLength(2)
  expect(calls[0]!.payload.keywords).toHaveLength(700)
  expect(calls[1]!.payload.keywords).toHaveLength(200)
  // The first batch was stored before the second was attempted, so a failure
  // halfway does not throw away an answer already paid for.
  expect(store.get("keyword 0|2840|en")?.searchVolume).toBe(10)
})
