// KeywordDiscovery tests. No network and no database: a fake HttpClient returns
// canned DataForSEO payloads, a Map stands in for the proposal table, and an
// array stands in for the Registry CSV.
//
// The tests that matter most are the ones about *not* proposing. A run is
// charged for every row it gets back, and the value of the service is entirely
// in what it removes before a person reads it — so each filter is tested by the
// count it reports, not only by the rows that survive.
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { Registry } from "../registry/registry.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { Storage } from "../storage/storage.ts"
import { KeywordDiscovery } from "./keyword-discovery.ts"
import { type KeywordProposal } from "./schema.ts"

const siteIn = (locationCode: number, languageCode: string, provider: string) =>
  Schema.decodeUnknownSync(Site)({
    id: "test",
    name: "Test Site",
    property: "sc-domain:example.com",
    origin: "https://www.example.com",
    sitemapUrl: "https://www.example.com/sitemap.xml",
    brandTerms: ["ranksta"],
    market: { locationCode, languageCode, label: "Test Market", provider },
  })

const unitedStates = siteIn(2840, "en", "labs")
const andorra = siteIn(2020, "ca", "google-ads")

const labsItem = (
  keyword: string,
  volume: number | null,
  difficulty: number | null = 20,
  intent: string | null = "informational",
) => ({
  keyword,
  keyword_info: {
    search_volume: volume,
    cpc: 0.8,
    competition: 0.3,
    monthly_searches: [{ year: 2026, month: 8, search_volume: volume }],
  },
  keyword_properties: { keyword_difficulty: difficulty },
  search_intent_info: { main_intent: intent },
})

const labsBody = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({
    status_code: 20000,
    tasks: [{ status_code: 20000, result: [{ items }] }],
  })

// `related_keywords` wraps each item's payload in `keyword_data`, one level
// deeper than every other Labs endpoint.
const relatedBody = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({
    status_code: 20000,
    tasks: [
      { status_code: 20000, result: [{ items: items.map((item) => ({ keyword_data: item })) }] },
    ],
  })

const adsBody = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: items }] })

interface Call {
  readonly url: string
  readonly auth: string | undefined
  readonly payload: Record<string, unknown>
}

const fakeHttp = (calls: Array<Call>, body: string, status = 200) =>
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
        payload: (JSON.parse(raw) as ReadonlyArray<Record<string, unknown>>)[0] ?? {},
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status })),
      )
    }),
  )

type Store = Map<string, KeywordProposal>

const storageStub = (store: Store) =>
  Layer.mock(Storage.Service)({
    saveKeywordProposals: (proposals) =>
      Effect.sync(() => {
        for (const proposal of proposals) {
          const key = `${proposal.keyword}|${proposal.locationCode}|${proposal.languageCode}`
          const existing = store.get(key)
          // The real table leaves `status` out of its upsert, so a dismissal
          // survives being found again. A stub that overwrote it would let the
          // resurrection test pass for the wrong reason.
          store.set(key, existing ? { ...proposal, status: existing.status } : proposal)
        }
      }),
    keywordProposals: (locationCode, languageCode) =>
      Effect.sync(() =>
        [...store.values()].filter(
          (proposal) =>
            proposal.locationCode === locationCode && proposal.languageCode === languageCode,
        ),
      ),
    dismissKeywordProposals: (keywords, locationCode, languageCode) =>
      Effect.sync(() => {
        let dismissed = 0
        for (const keyword of keywords) {
          const key = `${keyword}|${locationCode}|${languageCode}`
          const existing = store.get(key)
          if (!existing || existing.status === "dismissed") continue
          store.set(key, { ...existing, status: "dismissed" })
          dismissed += 1
        }
        return dismissed
      }),
  })

const entry = (keyword: string): RegistryEntry => ({
  cluster: "test",
  keyword,
  targetUrl: "/test",
  intent: "informational",
  whyOpportunity: "",
  priority: "P2",
  publishedAt: "",
  baselineDate: "",
  status: "live",
})

const registryStub = (entries: ReadonlyArray<RegistryEntry>) =>
  Layer.mock(Registry.Service)({ loadRegistry: () => Effect.succeed(entries) })

const buildLayer = (
  store: Store,
  http: Layer.Layer<HttpClient.HttpClient>,
  {
    site = unitedStates,
    entries = [] as ReadonlyArray<RegistryEntry>,
    env = { DATAFORSEO_API_KEY: "test-key" } as Record<string, string>,
  } = {},
) =>
  KeywordDiscovery.layer.pipe(
    Layer.provide(Layer.mock(CurrentSite.Service)({ current: () => Effect.succeed(site) })),
    Layer.provide(storageStub(store)),
    Layer.provide(registryStub(entries)),
    Layer.provide(http),
    Layer.provide(
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  )

test("a suggestions run asks Labs, proposes what it keeps, and reads back", async () => {
  const store: Store = new Map()
  const calls: Array<Call> = []
  const http = fakeHttp(
    calls,
    labsBody([labsItem("wow mount tracker addon", 480), labsItem("wow mount tracker app", 90)]),
  )

  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "WoW Mount Tracker" })
      .pipe(Effect.provide(buildLayer(store, http))),
  )

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toContain("/v3/dataforseo_labs/google/keyword_suggestions/live")
  expect(calls[0]!.auth).toBe("Basic test-key")
  expect(calls[0]!.payload["keyword"]).toBe("WoW Mount Tracker")
  expect(calls[0]!.payload["location_code"]).toBe(2840)
  // Clickstream data doubles the price of a request, so it must stay off.
  expect(calls[0]!.payload["include_clickstream_data"]).toBe(false)
  // The seed's own row is a row we would pay for and already have.
  expect(calls[0]!.payload["include_seed_keyword"]).toBe(false)
  // The limit is the price of the call: these two endpoints bill per row.
  expect(calls[0]!.payload["limit"]).toBe(200)

  expect(result.source).toBe("suggestions")
  expect(result.returned).toBe(2)
  // Strongest demand first, so a reader who stops early stops on the good rows.
  expect(result.proposals.map((proposal) => proposal.keyword)).toEqual([
    "wow mount tracker addon",
    "wow mount tracker app",
  ])
  expect(result.proposals[0]!.searchVolume).toBe(480)
  expect(result.proposals[0]!.difficulty).toBe(20)
  expect(result.proposals[0]!.intent).toBe("informational")
  // The seed is folded on the row, so the same seed typed two ways groups.
  expect(result.proposals[0]!.seed).toBe("wow mount tracker")
  expect(result.proposals[0]!.status).toBe("proposed")

  const proposed = await Effect.runPromise(
    KeywordDiscovery.use
      .proposed()
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], "", 500)))),
  )
  expect(proposed.map((proposal) => proposal.keyword)).toEqual([
    "wow mount tracker addon",
    "wow mount tracker app",
  ])
})

test("a related run reads the deeper nesting and walks two levels", async () => {
  const calls: Array<Call> = []
  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker", source: "related" })
      .pipe(
        Effect.provide(
          buildLayer(new Map(), fakeHttp(calls, relatedBody([labsItem("mount farming guide", 720)]))),
        ),
      ),
  )

  expect(calls[0]!.url).toContain("/v3/dataforseo_labs/google/related_keywords/live")
  // Depth 2 branches to at most 72 keywords, which is under the limit, so
  // nothing is truncated by an order DataForSEO does not document.
  expect(calls[0]!.payload["depth"]).toBe(2)
  // The SERP for every keyword found is a much larger response, and unread.
  expect(calls[0]!.payload["include_serp_info"]).toBe(false)
  expect(result.source).toBe("related")
  expect(result.proposals.map((proposal) => proposal.keyword)).toEqual(["mount farming guide"])
})

test("a Google Ads market ignores the requested source and reports the one that ran", async () => {
  const calls: Array<Call> = []
  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "escapada", source: "related", limit: 2 })
      .pipe(
        Effect.provide(
          buildLayer(
            new Map(),
            fakeHttp(
              calls,
              adsBody([
                { keyword: "escapada rural", search_volume: 300, competition_index: 40 },
                { keyword: "escapada montana", search_volume: 200, competition_index: 20 },
                { keyword: "escapada barata", search_volume: 100, competition_index: 10 },
              ]),
            ),
            { site: andorra },
          ),
        ),
      ),
  )

  expect(calls[0]!.url).toContain("/v3/keywords_data/google_ads/keywords_for_keywords/live")
  // This endpoint has no `limit` parameter — it charges a flat fee and can
  // answer with thousands of rows — so the limit is applied on the way out.
  expect(calls[0]!.payload["limit"]).toBeUndefined()
  expect(calls[0]!.payload["sort_by"]).toBe("search_volume")
  expect(result.returned).toBe(2)
  expect(result.source).toBe("google-ads")
  // No difficulty and no intent, and the 0-100 competition index converts to
  // the 0-1 ratio Labs reports.
  expect(result.proposals[0]!.difficulty).toBeNull()
  expect(result.proposals[0]!.intent).toBeNull()
  expect(result.proposals[0]!.competition).toBe(0.4)
})

test("every filter is counted, and a dropped row is charged to one reason", async () => {
  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker", minVolume: 50, maxDifficulty: 30, intents: ["informational"] })
      .pipe(
        Effect.provide(
          buildLayer(
            new Map(),
            fakeHttp(
              [],
              labsBody([
                labsItem("mount tracker addon", 480),
                // Already planned.
                labsItem("mount tracker guide", 900),
                // The Site's own name, and a search operator.
                labsItem("ranksta mount tracker", 400),
                labsItem("site:example.com mounts", 300),
                // Under the floor, and reported as nothing at all.
                labsItem("mount tracker widget", 20),
                labsItem("mount tracker skin", null),
                // Out of reach. Not the seed itself: the wire layer drops the
                // seed's own row before the filters ever see it.
                labsItem("mount tracker pro", 5000, 74),
                // The wrong intent.
                labsItem("buy mount tracker", 600, 12, "transactional"),
              ]),
            ),
            { entries: [entry("Mount Tracker Guide")] },
          ),
        ),
      ),
  )

  expect(result.returned).toBe(8)
  expect(result.droppedKnown).toBe(1)
  expect(result.droppedBrandOrOperator).toBe(2)
  expect(result.droppedBelowVolume).toBe(2)
  expect(result.droppedAboveDifficulty).toBe(1)
  expect(result.droppedByIntent).toBe(1)
  expect(result.proposals.map((proposal) => proposal.keyword)).toEqual(["mount tracker addon"])
  // The counts account for every charged row.
  expect(
    result.proposals.length +
      result.droppedKnown +
      result.droppedBrandOrOperator +
      result.droppedBelowVolume +
      result.droppedAboveDifficulty +
      result.droppedByIntent,
  ).toBe(result.returned)
})

test("an intent filter keeps the rows that report no intent", async () => {
  // Half the world's Markets are served by Google Ads, which reports no intent
  // at all. Dropping the unknown would empty the list there rather than narrow
  // it, so a null intent survives.
  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "escapada", intents: ["informational"] })
      .pipe(
        Effect.provide(
          buildLayer(
            new Map(),
            fakeHttp([], adsBody([{ keyword: "escapada rural", search_volume: 300 }])),
            { site: andorra },
          ),
        ),
      ),
  )

  expect(result.droppedByIntent).toBe(0)
  expect(result.proposals.map((proposal) => proposal.keyword)).toEqual(["escapada rural"])
})

test("a dismissed keyword is not proposed again by a later run", async () => {
  const store: Store = new Map()
  const body = labsBody([labsItem("mount tracker addon", 480), labsItem("mount tracker app", 90)])

  await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker" })
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
  )

  const dismissed = await Effect.runPromise(
    KeywordDiscovery.use
      .dismiss(["Mount Tracker App"])
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
  )
  expect(dismissed).toBe(1)

  // Dismissing it twice changes nothing, so the count is rows changed and not
  // keywords named.
  expect(
    await Effect.runPromise(
      KeywordDiscovery.use
        .dismiss(["mount tracker app"])
        .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
    ),
  ).toBe(0)

  // The same run again: DataForSEO answers with both rows, and both are known.
  const again = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker" })
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
  )
  expect(again.droppedKnown).toBe(2)
  expect(again.proposals).toEqual([])

  const proposed = await Effect.runPromise(
    KeywordDiscovery.use
      .proposed()
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
  )
  expect(proposed.map((proposal) => proposal.keyword)).toEqual(["mount tracker addon"])
})

test("a keyword the registry has taken stops being proposed", async () => {
  const store: Store = new Map()
  const body = labsBody([labsItem("mount tracker addon", 480)])

  await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker" })
      .pipe(Effect.provide(buildLayer(store, fakeHttp([], body)))),
  )

  // Accepted: the keyword is in the plan now. There is no `accepted` status to
  // write, and no coupling to whatever added the row — a keyword typed in by
  // hand reads the same way, which is the honest reading of both.
  const proposed = await Effect.runPromise(
    KeywordDiscovery.use
      .proposed()
      .pipe(
        Effect.provide(
          buildLayer(store, fakeHttp([], body), { entries: [entry("Mount Tracker Addon")] }),
        ),
      ),
  )
  expect(proposed).toEqual([])
})

test("no API key is an error, not an empty result, and costs nothing", async () => {
  const calls: Array<Call> = []
  const exit = await Effect.runPromiseExit(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker" })
      .pipe(Effect.provide(buildLayer(new Map(), fakeHttp(calls, labsBody([])), { env: {} }))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(calls).toHaveLength(0)
})

test("an unserved market fails before anything is billed", async () => {
  const calls: Array<Call> = []
  const exit = await Effect.runPromiseExit(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker" })
      .pipe(
        Effect.provide(
          buildLayer(new Map(), fakeHttp(calls, labsBody([])), {
            // The Netherlands is served in Dutch only, so this pair is one
            // DataForSEO would reject — and charge for.
            site: siteIn(2528, "de", "labs"),
          }),
        ),
      ),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(calls).toHaveLength(0)
})

test("a limit above the vendor's own cap fails before anything is billed", async () => {
  const calls: Array<Call> = []
  const exit = await Effect.runPromiseExit(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker", limit: 5000 })
      .pipe(Effect.provide(buildLayer(new Map(), fakeHttp(calls, labsBody([]))))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(calls).toHaveLength(0)
})

test("a keyword answered twice is proposed and counted once", async () => {
  // A related-searches walk can reach the same keyword down two branches.
  const result = await Effect.runPromise(
    KeywordDiscovery.use
      .discover({ seed: "mount tracker", source: "related" })
      .pipe(
        Effect.provide(
          buildLayer(
            new Map(),
            fakeHttp(
              [],
              relatedBody([labsItem("mount farming guide", 720), labsItem("Mount Farming Guide", 720)]),
            ),
          ),
        ),
      ),
  )

  expect(result.proposals).toHaveLength(1)
  expect(result.droppedKnown).toBe(0)
})
