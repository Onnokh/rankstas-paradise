// Reports service tests: exercise every report against a real Storage over a
// temp SQLite database seeded with the deterministic debug dataset (ported from
// src/debug.ts), plus a fixture Registry and Sitemap. Each test asserts the
// specific fields that matter per report (counts, sorting, verdicts, filtering);
// the dashboardSnapshot assertions confirm it returns the RAW internal shapes
// (un-tidied metrics, full-URL pages).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, ManagedRuntime } from "effect"

import { Analytics } from "../analytics/analytics.ts"
import { Revenue } from "../revenue/revenue.ts"
import { type VisitsDays } from "../analytics/schema.ts"
import { Registry } from "../registry/registry.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexStatus,
  type PageDailyTotal,
  type SiteDailyTotal,
} from "../search-console/schema.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { type SitemapPage } from "../sitemap/schema.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { DomainRating } from "../domain-rating/domain-rating.ts"
import { type DomainRating as DomainRatingReading } from "../domain-rating/schema.ts"
import { KeywordMetrics } from "../keyword-metrics/keyword-metrics.ts"
import { type KeywordMetric } from "../keyword-metrics/schema.ts"
import { type Site } from "../sites/schema.ts"
import { type StorageError } from "../storage/schema.ts"
import { Storage } from "../storage/storage.ts"
import { Reports } from "./reports.ts"

// --- deterministic fixture: the sleevy.app debug dataset (ported verbatim) ---

const ORIGIN = "https://sleevy.app"

const endDate = new Date("2026-07-12T00:00:00.000Z")
const dates = Array.from({ length: 56 }, (_, index) => {
  const date = new Date(endDate)
  date.setUTCDate(date.getUTCDate() - 55 + index)
  return date.toISOString().slice(0, 10)
})

const row = (
  date: string,
  query: string,
  page: string,
  impressions: number,
  clicks: number,
  position: number,
): DailySnapshot => ({
  date,
  query,
  page: `${ORIGIN}${page}`,
  device: "MOBILE",
  country: "USA",
  impressions,
  clicks,
  ctr: clicks / impressions,
  position,
})

const daily = (
  query: string,
  page: string,
  values: (day: number) => readonly [number, number, number],
) =>
  dates.map((date, day) => {
    const [impressions, clicks, position] = values(day)
    return row(date, query, page, impressions, clicks, position)
  })

const debugSnapshots: ReadonlyArray<DailySnapshot> = [
  ...daily("pocket alternative", "/pocket-alternative", (day) => [
    55 + day * 3,
    3 + Math.floor(day / 11),
    14 - day * 0.12,
  ]),
  ...daily("pocket replacement", "/pocket-alternative", (day) => [
    32 + day * 2,
    2 + Math.floor(day / 18),
    15.5 - day * 0.08,
  ]),
  ...daily("chrome read later extension", "/chrome-extension", (day) => [
    260 + day * 6,
    7 + Math.floor(day / 20),
    4.9 - day * 0.01,
  ]),
  ...daily("save tabs for later chrome", "/chrome-extension", (day) => [
    38 + day,
    2 + Math.floor(day / 24),
    13.8 - day * 0.03,
  ]),
  ...daily("save links from iphone", "/ios-app", (day) => [
    45 + day * 2,
    2 + Math.floor(day / 16),
    12.6 - day * 0.09,
  ]),
  ...daily("ios share sheet read later app", "/ios-app", (day) => [
    18 + day,
    1 + Math.floor(day / 21),
    17.2 - day * 0.06,
  ]),
  ...daily("raindrop alternative", "/pocket-alternative", (day) => [
    12 + day * 4,
    Math.floor(day / 20),
    19 - day * 0.09,
  ]),
  ...daily("bookmark organizer mac", "/", (day) => [
    8 + day * 3,
    Math.floor(day / 22),
    18.5 - day * 0.08,
  ]),
  ...daily("read later app", "/ios-app", (day) => [
    38 + day,
    2 + Math.floor(day / 18),
    9.8 - day * 0.03,
  ]),
  ...daily("read later app", "/chrome-extension", (day) => [
    31 + day,
    1 + Math.floor(day / 21),
    11.5 - day * 0.02,
  ]),
  ...daily("raycast save links", "/raycast", (day) => [
    10 + day,
    Math.floor(day / 23),
    19.5 - day * 0.04,
  ]),
  ...daily("read later api", "/docs", (day) => [
    9 + Math.floor(day * 1.5),
    Math.floor(day / 25),
    16 - day * 0.05,
  ]),
  ...daily("sleevy chrome extension", "/chrome-extension", (day) => [
    70 + day * 2,
    22 + Math.floor(day / 5),
    2.2,
  ]),
]

const debugDailyTotals: DailyTotals = (() => {
  const anonymizedUplift = 1.25
  const pageBuckets = new Map<
    string,
    { clicks: number; impressions: number; weightedPosition: number }
  >()
  for (const snapshot of debugSnapshots) {
    const key = `${snapshot.date} ${snapshot.page}`
    const bucket = pageBuckets.get(key) ?? {
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
    }
    bucket.clicks += snapshot.clicks
    bucket.impressions += snapshot.impressions
    bucket.weightedPosition += snapshot.position * snapshot.impressions
    pageBuckets.set(key, bucket)
  }
  const pages: PageDailyTotal[] = [...pageBuckets.entries()].map(
    ([key, bucket]) => {
      const [date, page] = key.split(" ") as [string, string]
      const impressions = Math.round(bucket.impressions * anonymizedUplift)
      return {
        date,
        page,
        clicks: bucket.clicks,
        impressions,
        ctr: impressions > 0 ? bucket.clicks / impressions : 0,
        position:
          bucket.impressions > 0
            ? bucket.weightedPosition / bucket.impressions
            : 0,
      }
    },
  )
  const siteBuckets = new Map<
    string,
    { clicks: number; impressions: number; weightedPosition: number }
  >()
  for (const page of pages) {
    const bucket = siteBuckets.get(page.date) ?? {
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
    }
    bucket.clicks += page.clicks
    bucket.impressions += page.impressions
    bucket.weightedPosition += page.position * page.impressions
    siteBuckets.set(page.date, bucket)
  }
  const site: SiteDailyTotal[] = [...siteBuckets.entries()].map(
    ([date, bucket]) => ({
      date,
      clicks: bucket.clicks,
      impressions: bucket.impressions,
      ctr: bucket.impressions > 0 ? bucket.clicks / bucket.impressions : 0,
      position:
        bucket.impressions > 0
          ? bucket.weightedPosition / bucket.impressions
          : 0,
    }),
  )
  return { site, pages }
})()

// --- fixture registry + sitemap ---

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  cluster: "",
  keyword: "",
  targetUrl: "/",
  intent: "",
  whyOpportunity: "",
  priority: "",
  publishedAt: "",
  baselineDate: "",
  status: "",
  ...over,
})

const fixtureRegistry: ReadonlyArray<RegistryEntry> = [
  entry({
    cluster: "Alternatives",
    keyword: "pocket alternative",
    targetUrl: "/pocket-alternative",
    intent: "comparison",
    whyOpportunity: "High-intent switchers searching for a Pocket replacement.",
    priority: "P1",
    publishedAt: "2026-05-20",
    baselineDate: "2026-05-18",
    status: "Measuring",
  }),
  entry({
    cluster: "Extension",
    keyword: "chrome read later extension",
    targetUrl: "/chrome-extension",
    intent: "product-solution",
    whyOpportunity: "Strong demand with a weak click-through rate to fix.",
    priority: "P2",
    publishedAt: "2026-05-20",
    baselineDate: "2026-05-18",
    status: "Measuring",
  }),
  entry({
    cluster: "Mobile",
    keyword: "save links from iphone",
    targetUrl: "/ios-app",
    intent: "product-how-to",
    whyOpportunity: "Growing iOS share-sheet interest.",
    priority: "P1",
    publishedAt: "2026-05-20",
    baselineDate: "2026-05-18",
    status: "Measuring",
  }),
  entry({
    cluster: "Site inventory",
    keyword: "",
    targetUrl: "/",
    intent: "site-inventory",
    status: "Inventory",
  }),
]

const fixtureSitemap: ReadonlyArray<SitemapPage> = [
  { url: `${ORIGIN}/`, path: "/", lastModified: "2026-07-01" },
  {
    url: `${ORIGIN}/pocket-alternative`,
    path: "/pocket-alternative",
    lastModified: "2026-07-01",
  },
  {
    url: `${ORIGIN}/chrome-extension`,
    path: "/chrome-extension",
    lastModified: "2026-07-01",
  },
  { url: `${ORIGIN}/ios-app`, path: "/ios-app", lastModified: "2026-07-01" },
  { url: `${ORIGIN}/pricing`, path: "/pricing", lastModified: "2026-07-01" },
  { url: `${ORIGIN}/about`, path: "/about", lastModified: "2026-07-01" },
]

const site: Site = {
  id: "sleevy" as Site["id"],
  name: "Sleevy",
  property: "sc-domain:sleevy.app",
  origin: ORIGIN,
  sitemapUrl: `${ORIGIN}/sitemap.xml`,
  brandTerms: ["sleevy"],
  market: {
    locationCode: 2840,
    languageCode: "en",
    label: "United States",
    provider: "labs",
  },
} satisfies Site

// The Keyword metrics the KeywordMetrics stub reports. Filled by the demand
// tests and emptied after each one, so every other test in this file reads the
// ordinary case: a site whose metrics have never been fetched.
const storedDemand = new Map<string, KeywordMetric>()

// The Domain Rating the stub reports, on the same terms. Empty is the ordinary
// case: most sites have no reading stored.
const storedRating: { value: DomainRatingReading | null } = { value: null }

const demandMetric = (
  keyword: string,
  over: Partial<KeywordMetric> = {},
): KeywordMetric => ({
  keyword,
  locationCode: 2840,
  languageCode: "en",
  searchVolume: 1_900,
  difficulty: 31,
  costPerClick: 2.4,
  competition: 0.18,
  intent: "commercial",
  monthlySearches: [{ year: 2026, month: 7, searchVolume: 1_900 }],
  fetchedAt: "2026-09-08T00:00:00.000Z",
  ...over,
})

// --- layer wiring ---

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<
  | Reports.Service
  | Storage.Service
  | Registry.Service
  | Sitemap.Service
  | CurrentSite.Service,
  StorageError
>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rp-reports-"))
  const dbPath = join(dir, "search-console.sqlite")

  const currentSiteLayer = Layer.succeed(CurrentSite.Service, {
    current: () => Effect.succeed(site),
    dataDirectory: () => Effect.succeed(dir),
    databasePath: () => Effect.succeed(dbPath),
    registryPath: () => Effect.succeed(join(dir, "keyword-registry.csv")),
    sitemapPath: () => Effect.succeed(join(dir, "sitemap.json")),
  } satisfies CurrentSite.Interface)

  const registryLayer = Layer.succeed(Registry.Service, {
    loadRegistry: () => Effect.succeed(fixtureRegistry),
    appendRegistryEntry: () => Effect.void,
    updateRegistryRows: () => Effect.succeed(0),
    markMissingBaselines: () => Effect.succeed(0),
  } satisfies Registry.Interface)

  const sitemapLayer = Layer.succeed(Sitemap.Service, {
    refreshSitemapPages: () => Effect.succeed(fixtureSitemap),
    loadCachedSitemapPages: () => Effect.succeed(fixtureSitemap),
    unmappedSitemapPages: (pages, registry) =>
      Effect.succeed(
        pages.filter(
          (page) => !registry.some((row) => row.targetUrl === page.path),
        ),
      ),
  } satisfies Sitemap.Interface)

  const storageLayer = Storage.layer.pipe(Layer.provide(currentSiteLayer))
  // The dashboard reads a stored rating and never fetches one; a site without a
  // reading is the ordinary case, so the cell starts empty.
  const domainRatingLayer = Layer.mock(DomainRating.Service)({
    cached: () => Effect.succeed(storedRating.value),
  })
  // Reads whatever the demand tests put in `storedDemand`. Empty for every
  // other test, so the reports must read every number exactly as they did
  // before demand existed.
  const keywordMetricsLayer = Layer.mock(KeywordMetrics.Service)({
    cached: () => Effect.succeed(storedDemand),
  })
  // Reports only ask which provider is configured; the visits themselves are
  // read from the ledger, seeded below. A ready "fake" provider stands in.
  const analyticsLayer = Layer.mock(Analytics.Service)({
    status: () =>
      Effect.succeed({
        provider: "fake",
        siteId: "1",
        ready: true,
        reason: null,
      }),
    liveVisitors: () =>
      Effect.succeed({
        visitors: 4,
        windowMinutes: 30,
        online: 1,
        onlineWindowMinutes: 5,
        series: Array<number>(30).fill(0),
        fetchedAt: "2026-07-12T12:00:00.000Z",
      }),
    // The fixture's "today" is the day after its last synced day.
    localDay: () =>
      Effect.succeed({ date: "2026-07-13", hour: 12, timeZone: "UTC" }),
  })
  // A ready "fake" commerce provider on the same terms; its rows are seeded
  // into the ledger by the revenue tests below.
  const revenueLayer = Layer.mock(Revenue.Service)({
    status: () =>
      Effect.succeed({
        provider: "fake",
        accountId: null,
        ready: true,
        reason: null,
      }),
    localDay: () =>
      Effect.succeed({ date: "2026-07-13", hour: 12, timeZone: "UTC" }),
  })
  const base = Layer.mergeAll(
    storageLayer,
    registryLayer,
    sitemapLayer,
    domainRatingLayer,
    keywordMetricsLayer,
    analyticsLayer,
    revenueLayer,
    currentSiteLayer,
  )
  runtime = ManagedRuntime.make(Reports.layer.pipe(Layer.provideMerge(base)))

  // Seed the store with the debug dataset and one action to exercise logFeed.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveSnapshots(debugSnapshots)
      yield* storage.saveDailyTotals(debugDailyTotals, [...dates])
      yield* storage.savePageIndexStatuses([
        {
          targetUrl: `${ORIGIN}/pocket-alternative`,
          status: "not-indexed",
          verdict: "NEUTRAL",
          coverageState: "Crawled - currently not indexed",
        } satisfies PageIndexStatus,
      ])
      yield* storage.addLogEntry({
        date: "2026-06-10",
        path: "/pocket-alternative",
        kind: "content-update",
        note: "Expanded the comparison table.",
      })
      yield* storage.saveVisits(debugVisits, [...dates], "fake")
    }),
  )
}, 60_000)

afterAll(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Reports.Service>) =>
  runtime.runPromise(effect)

// Flat visits over the whole 56-day fixture: 100 pageviews a day site-wide, 40
// on /chrome-extension, 30 on /, 5 on a page Search Console never saw, and two
// purchases a day. Flat so both 28-day windows sum to the same number and a
// delta of zero proves the windows line up with the Search Console ones.
const debugVisits: VisitsDays = {
  site: dates.map((date) => ({ date, pageviews: 100, visits: 60, visitors: 50 })),
  pages: dates.flatMap((date) => [
    { date, page: "/chrome-extension", pageviews: 40, visits: 25 },
    { date, page: "/", pageviews: 30, visits: 20 },
    { date, page: "/visits-only", pageviews: 5, visits: 4 },
  ]),
  events: dates.map((date) => ({ date, name: "purchase", count: 2 })),
}

test("statusReport counts registry targets/keywords and sitemap pages", async () => {
  const report = await run(Reports.use.statusReport())
  // 4 registry rows over 4 distinct targetUrls; 3 carry a keyword (the 4th is
  // the inventory "/" row with an empty keyword).
  expect(report.registry.targets).toBe(4)
  expect(report.registry.keywords).toBe(3)
  // Sitemap has 6 pages; 3 mapped keyword targets + 1 inventory "/" → /pricing
  // and /about are unmapped.
  expect(report.sitemap.pages).toBe(6)
  expect(report.sitemap.unmapped).toEqual(["/pricing", "/about"])
  // Data block reflects the seeded 56-day debug dataset.
  expect(report.data.syncedDays).toBe(56)
  expect(report.data.firstDate).toBe("2026-05-18")
  expect(report.data.lastDate).toBe("2026-07-12")
  // lastSyncedAt is when the data arrived — the newest synced_day.fetched_at,
  // written as this fixture was seeded — not when the report was shaped.
  expect(report.data.lastSyncedAt).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  )
  // This fixture writes straight to Storage and never runs a sync, so the two
  // fields disagree here on purpose: data has arrived, but Ranksta never asked
  // Google for it. That is the "never checked" state a client must be able to
  // tell apart from a checked site with nothing new.
  expect(report.data.lastCheckedAt).toBeNull()
})

test("pagesReport sorts a known page by impressions desc", async () => {
  const report = await run(Reports.use.pagesReport())
  // Sorted by allQueries.current impressions descending.
  const impressions = report.pages.map(
    (page) => page.allQueries?.current.impressions ?? 0,
  )
  expect([...impressions]).toEqual([...impressions].sort((a, b) => b - a))
  // /chrome-extension is the highest-traffic page in the debug dataset, so it
  // sorts first and is a mapped keyword target with a computed verdict.
  const top = report.pages[0]
  expect(top?.path).toBe("/chrome-extension")
  expect(top?.mapped).toBe(true)
  expect(typeof top?.verdict).toBe("string")
})

test("pageReport returns path, verdict, and top queries for a mapped page", async () => {
  const report = await run(Reports.use.pageReport("/pocket-alternative"))
  expect(report.path).toBe("/pocket-alternative")
  expect(report.mapped).toBe(true)
  expect(report.indexed).toBe("not-indexed")
  expect(report.coverageState).toBe("Crawled - currently not indexed")
  // Judged on non-brand query rows for a keyword target.
  expect(report.performance.scope).toBe("non-brand")
  expect(typeof report.verdict).toBe("string")
  // Top queries are surfaced and the seeded "pocket alternative" query is among
  // them (non-brand for this site).
  expect(report.topQueries.length).toBeGreaterThan(0)
  const pocket = report.topQueries.find(
    (query) => query.query === "pocket alternative",
  )
  expect(pocket).toBeDefined()
  expect(pocket?.brand).toBe(false)
})

test("pageReport rejects a non-slash path", async () => {
  const exit = await runtime.runPromiseExit(
    Reports.use.pageReport("pocket-alternative"),
  )
  expect(exit._tag).toBe("Failure")
})

afterEach(() => {
  storedDemand.clear()
  storedRating.value = null
})

test("queriesReport carries the Market and the demand behind each Query", async () => {
  storedDemand.set(
    "pocket alternative",
    demandMetric("pocket alternative", { searchVolume: 1_900, difficulty: 31 }),
  )

  const report = await run(Reports.use.queriesReport())
  // A search volume without its Market is ambiguous — the same keyword has a
  // different number in every country — so the Market travels with it.
  expect(report.market).toEqual({
    locationCode: 2840,
    languageCode: "en",
    label: "United States",
    provider: "labs",
  })

  const known = report.queries.find((query) => query.query === "pocket alternative")
  expect(known?.demand).toEqual({
    searchVolume: 1_900,
    difficulty: 31,
    costPerClick: 2.4,
    competition: 0.18,
    intent: "commercial",
    fetchedAt: "2026-09-08T00:00:00.000Z",
  })
  // The monthly series is deliberately left out. The vendor sends about 94
  // months a keyword, so a report with forty rows would otherwise carry nearly
  // four thousand numbers for a question nobody asked.
  expect(known?.demand).not.toHaveProperty("monthlySearches")

  // A Query with no stored answer simply has no demand block, rather than one
  // full of zeroes.
  const others = report.queries.filter((query) => query.query !== "pocket alternative")
  expect(others.length).toBeGreaterThan(0)
  expect(others.every((query) => query.demand === undefined)).toBe(true)
})

test("registryList carries the demand behind each planned Keyword", async () => {
  storedDemand.set("pocket alternative", demandMetric("pocket alternative"))
  storedDemand.set(
    "chrome read later extension",
    // The case this exists for: a planned keyword nobody searches for. A page
    // aimed at it will not be found, whatever its priority says.
    demandMetric("chrome read later extension", { searchVolume: 0, difficulty: 4 }),
  )

  const report = await run(Reports.use.registryList())
  expect(report.market?.label).toBe("United States")

  const keywords = report.targets.flatMap((target) => target.keywords)
  expect(
    keywords.find((keyword) => keyword.keyword === "pocket alternative")?.demand
      ?.searchVolume,
  ).toBe(1_900)
  expect(
    keywords.find((keyword) => keyword.keyword === "chrome read later extension")
      ?.demand?.searchVolume,
  ).toBe(0)
  // Every other planned keyword has no answer stored, which is not the same as
  // no demand.
  expect(
    keywords
      .filter(
        (keyword) =>
          keyword.keyword !== "pocket alternative" &&
          keyword.keyword !== "chrome read later extension",
      )
      .every((keyword) => keyword.demand === undefined),
  ).toBe(true)
})

test("a report reads no demand at all when nothing is stored", async () => {
  // The site with no DataForSEO key, which is every site until one is
  // configured. The Market is still reported — it is a Site property, not a
  // vendor answer — but no row claims a number.
  const queries = await run(Reports.use.queriesReport())
  expect(queries.market?.label).toBe("United States")
  expect(queries.queries.every((query) => query.demand === undefined)).toBe(true)

  const registryReport = await run(Reports.use.registryList())
  expect(
    registryReport.targets
      .flatMap((target) => target.keywords)
      .every((keyword) => keyword.demand === undefined),
  ).toBe(true)
})

// --- seasonality -----------------------------------------------------------

// A synthetic series, newest first, the way DataForSEO sends it. `shape` gives
// a multiplier per calendar month (index 0 = January) and `growth` compounds
// per year, so a term can be seasonal, trending, both, or neither.
const monthly = (
  options: {
    readonly years?: number
    readonly shape?: ReadonlyArray<number>
    readonly growth?: number
    readonly startMonth?: number
    readonly endMonth?: number
  } = {},
) => {
  const {
    years = 3,
    shape = Array.from({ length: 12 }, () => 1),
    growth = 1,
    startMonth = 1,
    endMonth = 12,
  } = options
  const rows: Array<{ year: number; month: number; searchVolume: number }> = []
  for (let year = 0; year < years; year += 1)
    for (let month = 1; month <= 12; month += 1) {
      if (year === 0 && month < startMonth) continue
      if (year === years - 1 && month > endMonth) continue
      rows.push({
        year: 2020 + year,
        month,
        searchVolume: Math.round(1_000 * shape[month - 1]! * growth ** year),
      })
    }
  return rows.reverse()
}

test("flat demand still names its highest month, and says it is not a season", () => {
  // Every term has a highest month. Only some have a season, and the whole
  // point of reporting the index beside the month is telling those apart.
  const flat = Reports.seasonalityOf(monthly())
  expect(flat.peakMonth).not.toBeNull()
  expect(flat.seasonality).toBe(1)
})

test("a December peak is found", () => {
  const shape = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3]
  const result = Reports.seasonalityOf(monthly({ shape }))
  expect(result.peakMonth).toBe(12)
  // December runs at three where the others run at one, so the year averages
  // 1.167 and December indexes at 3 / 1.167.
  expect(result.seasonality).toBeCloseTo(2.57, 1)
})

test("a growing term's peak is its season, not the end of the series", () => {
  // THE case this derivation exists for. Demand doubles every year and peaks
  // each March. Averaging raw months over the whole series would put the peak
  // in the last month the data holds, because the newest year dwarfs the
  // oldest — which is exactly backwards, since a growing term is the one most
  // worth planning around.
  const shape = [1, 1, 2.5, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  const rising = monthly({ years: 4, shape, growth: 2, endMonth: 8 })
  expect(Reports.seasonalityOf(rising).peakMonth).toBe(3)

  // The naive reading, for contrast: the highest raw month is in the newest
  // year, and it is not March.
  const highestRaw = [...rising].sort(
    (left, right) => right.searchVolume - left.searchVolume,
  )[0]!
  expect(highestRaw.year).toBe(2023)
})

test("a dying term's peak is its season too", () => {
  // The mirror image: demand halves every year, so the naive reading would
  // put the peak in the oldest year instead of the newest.
  const shape = [1, 1, 1, 1, 1, 1, 1, 2.5, 1, 1, 1, 1]
  const falling = monthly({ years: 4, shape, growth: 0.5 })
  expect(Reports.seasonalityOf(falling).peakMonth).toBe(8)
})

test("under two complete years there is no peak to report", () => {
  // One observation of a calendar month is that month, not an average of it.
  expect(Reports.seasonalityOf([])).toEqual({ peakMonth: null, seasonality: null })
  expect(Reports.seasonalityOf(monthly({ years: 1 }))).toEqual({
    peakMonth: null,
    seasonality: null,
  })
  // Two calendar years, but neither of them complete: 2020 starts in June and
  // 2021 stops in June. Twenty-four rows is not two years.
  expect(
    Reports.seasonalityOf(monthly({ years: 2, startMonth: 6, endMonth: 6 })),
  ).toEqual({ peakMonth: null, seasonality: null })
})

test("partial years at the ends are ignored rather than averaged", () => {
  // The real series runs 2018-10 to 2026-07, so both ends are stubs. An
  // October-to-December stub read as a year would make Q4 look merely average
  // and drag every other month's index up against it.
  const shape = [1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 4, 4]
  const withStubs = monthly({ years: 4, shape, startMonth: 10, endMonth: 7 })
  const result = Reports.seasonalityOf(withStubs)
  // Two complete years remain (2021, 2022) and both carry the Q4 shape, so the
  // peak is still Q4 and its index is unpolluted by the stubs.
  expect(result.peakMonth).not.toBeNull()
  expect([10, 11, 12]).toContain(result.peakMonth!)
  // Nine months at 1 and three at 4 gives a year mean of 1.75, so each Q4
  // month indexes at 4 / 1.75.
  expect(result.seasonality).toBeCloseTo(2.29, 1)
})

test("a year of no searches at all is skipped, not divided by", () => {
  // Dividing by a zero mean would put an infinity into every index for that
  // year and poison the average.
  const dead = monthly({ years: 3 }).map((month) =>
    month.year === 2021 ? { ...month, searchVolume: 0 } : month,
  )
  const result = Reports.seasonalityOf(dead)
  expect(Number.isFinite(result.seasonality!)).toBe(true)
  expect(result.seasonality).toBe(1)
})

// --- the Registry judged on demand -----------------------------------------

test("registryHealth sorts the plan by demand and counts each verdict", async () => {
  storedDemand.set("pocket alternative", demandMetric("pocket alternative", { searchVolume: 1_900 }))
  // Measured, and the vendor found nothing. This is the row to act on: a page
  // aimed here will not be found.
  storedDemand.set("chrome read later extension", demandMetric("chrome read later extension", { searchVolume: 0 }))
  // Measured, and the vendor has no volume — the term is too rare for it to
  // report, which is a different fact from a measured zero.
  storedDemand.set("save links from iphone", demandMetric("save links from iphone", { searchVolume: null }))

  const report = await run(Reports.use.registryHealth())

  // Demand first, then the measured-and-empty row, then the unreported one.
  expect(report.keywords.map((row) => [row.keyword, row.verdict])).toEqual([
    ["pocket alternative", "has-demand"],
    ["chrome read later extension", "no-demand"],
    ["save links from iphone", "unreported"],
  ])
  expect(report.totals).toEqual({
    keywords: 3,
    unmeasured: 0,
    unreported: 1,
    noDemand: 1,
    hasDemand: 1,
    // Only the keywords with demand count toward the plan's addressable
    // market; the empty ones would otherwise read as if they contributed.
    monthlyVolume: 1_900,
  })
  expect(report.market?.label).toBe("United States")
})

test("the verdict decides the order, not the plan's own", async () => {
  // The plan lists "chrome read later extension" before "save links from
  // iphone". Both have a volume that sorts to zero, so only the verdict rank
  // can separate them — and a measured-empty row has to come before an
  // unreported one, because that is a decision and this is closer to a gap in
  // the data.
  storedDemand.set(
    "chrome read later extension",
    demandMetric("chrome read later extension", { searchVolume: null }),
  )
  storedDemand.set(
    "save links from iphone",
    demandMetric("save links from iphone", { searchVolume: 0 }),
  )

  const report = await run(Reports.use.registryHealth())
  expect(report.keywords.map((row) => [row.keyword, row.verdict])).toEqual([
    ["save links from iphone", "no-demand"],
    ["chrome read later extension", "unreported"],
    // Nobody asked about this one at all, so it comes last.
    ["pocket alternative", "unmeasured"],
  ])
})

test("registryHealth carries each keyword's peak month", async () => {
  // The series comes from the store, not from the KeywordMetrics stub, so this
  // seeds the real table the way a sync would. Demand peaks every March and
  // doubles each year, which is the case the detrending exists for.
  const shape = [1, 1, 2.5, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveKeywordMetrics([
        {
          ...demandMetric("save links from iphone", { searchVolume: 720 }),
          monthlySearches: monthly({ years: 4, shape, growth: 2, endMonth: 8 }),
        },
      ])
    }),
  )
  storedDemand.set(
    "save links from iphone",
    demandMetric("save links from iphone", { searchVolume: 720 }),
  )

  const report = await run(Reports.use.registryHealth())
  const row = report.keywords.find(
    (candidate) => candidate.keyword === "save links from iphone",
  )
  expect(row?.peakMonth).toBe(3)
  expect(row?.seasonality).toBeGreaterThan(1.5)

  // A keyword with no stored series has no peak, rather than a made-up one.
  storedDemand.set("pocket alternative", demandMetric("pocket alternative"))
  const second = await run(Reports.use.registryHealth())
  expect(
    second.keywords.find((candidate) => candidate.keyword === "pocket alternative")
      ?.peakMonth,
  ).toBeNull()

  // Blanked rather than left in the shared temp database, where it would give a
  // later test a peak month it did not ask for.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveKeywordMetrics([
        { ...demandMetric("save links from iphone"), monthlySearches: [] },
      ])
    }),
  )
})

test("registryHealth leaves inventory-only rows out", async () => {
  // The fixture registry holds four rows and one of them has a blank keyword:
  // a page the sitemap contributed. It makes no claim about demand, so judging
  // it would invent a verdict about nothing.
  const report = await run(Reports.use.registryHealth())
  expect(report.keywords).toHaveLength(3)
  expect(report.keywords.every((row) => row.keyword.trim() !== "")).toBe(true)
})

test("an unmeasured keyword says nothing about the keyword", async () => {
  // Every site before a DataForSEO key is configured. The report still has its
  // shape, and no row claims the vendor said anything.
  const report = await run(Reports.use.registryHealth())
  expect(report.totals.unmeasured).toBe(3)
  expect(report.totals.monthlyVolume).toBe(0)
  expect(report.keywords.every((row) => row.verdict === "unmeasured")).toBe(true)
  expect(report.keywords.every((row) => row.searchVolume === null)).toBe(true)
})

test("registryHealth ranks demand strongest first within a verdict", async () => {
  storedDemand.set("pocket alternative", demandMetric("pocket alternative", { searchVolume: 90 }))
  storedDemand.set("chrome read later extension", demandMetric("chrome read later extension", { searchVolume: 4_400 }))
  storedDemand.set("save links from iphone", demandMetric("save links from iphone", { searchVolume: 720 }))

  const report = await run(Reports.use.registryHealth())
  expect(report.keywords.map((row) => row.searchVolume)).toEqual([4_400, 720, 90])
  expect(report.totals.monthlyVolume).toBe(5_210)
})

test("difficultyGap reads a keyword's difficulty against the site's rating", async () => {
  storedRating.value = {
    target: "sleevy.app",
    rating: 12,
    fetchedAt: "2026-09-08T00:00:00.000Z",
    license: "https://ahrefs.com/legal/domain-rating-license",
  }
  storedDemand.set(
    "pocket alternative",
    demandMetric("pocket alternative", { searchVolume: 1_900, difficulty: 31 }),
  )
  // A keyword the vendor scored no difficulty for — the ordinary case for a
  // Google-Ads market, which does not measure it.
  storedDemand.set(
    "chrome read later extension",
    demandMetric("chrome read later extension", { searchVolume: 800, difficulty: null }),
  )

  const report = await run(Reports.use.registryHealth())
  expect(report.domainRating).toBe(12)
  const rows = new Map(report.keywords.map((row) => [row.keyword, row]))
  // 31 − 12: the keyword scores harder than the site rates.
  expect(rows.get("pocket alternative")?.difficultyGap).toBe(19)
  // No difficulty means no gap, rather than a gap measured from nothing.
  expect(rows.get("chrome read later extension")?.difficultyGap).toBeNull()
})

test("a site with no Domain Rating gets no gap rather than no report", async () => {
  // The rating is supplementary. Reading it as a zero would report every
  // keyword as scoring its full difficulty above the site, which is a claim
  // nobody made.
  storedDemand.set(
    "pocket alternative",
    demandMetric("pocket alternative", { searchVolume: 1_900, difficulty: 31 }),
  )
  const report = await run(Reports.use.registryHealth())
  expect(report.domainRating).toBeNull()
  expect(report.keywords[0]?.difficulty).toBe(31)
  expect(report.keywords[0]?.difficultyGap).toBeNull()
})

test("registryHealth carries the plan's own fields beside the vendor's", async () => {
  // The report has to be actionable on its own: the reader needs the target and
  // the priority to decide what to do about a keyword with no demand.
  storedDemand.set(
    "pocket alternative",
    demandMetric("pocket alternative", { searchVolume: 1_900, intent: "commercial" }),
  )
  const report = await run(Reports.use.registryHealth())
  const row = report.keywords[0]!
  expect(row.targetUrl).toBe("/pocket-alternative")
  expect(row.priority).toBe("P1")
  expect(row.cluster).toBe("Alternatives")
  // The plan's claimed intent and the one the vendor observed, side by side:
  // a disagreement is worth seeing rather than resolving here.
  expect(row.intent).toBe("comparison")
  expect(row.reportedIntent).toBe("commercial")
})

test("queriesReport excludes brand queries by default", async () => {
  const report = await run(Reports.use.queriesReport())
  expect(report.queries.length).toBeGreaterThan(0)
  // "sleevy chrome extension" is a brand query and must be filtered out.
  expect(
    report.queries.some((query) => query.query === "sleevy chrome extension"),
  ).toBe(false)
  // No returned query is flagged as brand.
  expect(report.queries.every((query) => query.brand === false)).toBe(true)
})

test("queriesReport includes brand queries when requested", async () => {
  const report = await run(Reports.use.queriesReport({ includeBrand: true }))
  expect(
    report.queries.some((query) => query.query === "sleevy chrome extension"),
  ).toBe(true)
})

test("opportunitiesReport surfaces the expected signal kinds", async () => {
  const report = await run(Reports.use.opportunitiesReport())
  expect(report.signals.length).toBeGreaterThan(0)
  const kinds = new Set(report.signals.map((signal) => signal.kind))
  // Every emitted kind is a known opportunity kind, and the debug dataset (a
  // page ranking ~4-14 with sub-10% CTR) reliably produces striking-distance.
  const known = new Set([
    "striking-distance",
    "ctr",
    "new-demand",
    "cannibalization",
  ])
  expect([...kinds].every((kind) => known.has(kind))).toBe(true)
  expect(kinds.has("striking-distance")).toBe(true)
})

test("opportunitiesReport carries the demand behind each signal", async () => {
  // The digest reads the store directly rather than the KeywordMetrics
  // service, so this seeds the real table the way a sync would.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveKeywordMetrics([
        demandMetric("pocket alternative", { searchVolume: 1_900, difficulty: 31 }),
      ])
    }),
  )

  const report = await run(Reports.use.opportunitiesReport())
  const known = report.signals.find(
    (signal) => signal.query === "pocket alternative",
  )
  expect(known?.demand).toEqual({
    searchVolume: 1_900,
    difficulty: 31,
    intent: "commercial",
  })
  // Difficulty is reported and never scored: a term the site cannot reach yet
  // is still a real opportunity, and folding that judgement into one number
  // would hide it from the reader who has to make the call.
  expect(known!.score).not.toBe(31)
  // A signal with no stored answer carries no demand block. Asserted against a
  // named query rather than "every other signal": this database is shared with
  // every test in the file, so a blanket claim about rows nobody seeded here
  // makes the suite depend on its own declaration order.
  const unmeasured = report.signals.find(
    (signal) => signal.query === "raindrop alternative",
  )
  // Found first, so the assertion below cannot pass by matching nothing.
  expect(unmeasured).toBeDefined()
  expect(unmeasured?.demand).toBeUndefined()

  // Unlike `storedDemand`, this row is in the shared temp database, so it is
  // blanked rather than left to re-rank a later test's digest. A null volume
  // restores the impression-only weighting.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveKeywordMetrics([
        demandMetric("pocket alternative", { searchVolume: null }),
      ])
    }),
  )
})

test("opportunitiesReport filters by a single kind", async () => {
  const report = await run(Reports.use.opportunitiesReport("striking-distance"))
  expect(report.signals.length).toBeGreaterThan(0)
  expect(
    report.signals.every((signal) => signal.kind === "striking-distance"),
  ).toBe(true)
})

test("opportunitiesReport caps signals at the limit but counts them all", async () => {
  const full = await run(Reports.use.opportunitiesReport())
  expect(full.totalSignals).toBe(full.signals.length)
  const limited = await run(Reports.use.opportunitiesReport(undefined, 1))
  expect(limited.signals.length).toBe(1)
  expect(limited.totalSignals).toBe(full.totalSignals)
  // The kept signal is the strongest one.
  expect(limited.signals[0]).toEqual(full.signals[0])
})

test("registryList includes a known target with its keywords", async () => {
  const report = await run(Reports.use.registryList())
  const pocket = report.targets.find(
    (target) => target.targetUrl === "/pocket-alternative",
  )
  expect(pocket).toBeDefined()
  expect(pocket?.priority).toBe("P1")
  expect(pocket?.indexed).toBe("not-indexed")
  expect(pocket?.coverageState).toBe("Crawled - currently not indexed")
  expect(pocket?.keywords.map((keyword) => keyword.keyword)).toContain(
    "pocket alternative",
  )
  // Visits ride along over the target's own 28 days: flat fixture, so both
  // windows agree and the delta is zero. A target the provider never saw
  // carries zeros, not null — null is reserved for "no provider / nothing
  // synced" (see the debug-mode test below).
  const chrome = report.targets.find((t) => t.targetUrl === "/chrome-extension")
  expect(chrome?.visits).toEqual({
    current: { pageviews: 40 * 28, visits: 25 * 28 },
    previous: { pageviews: 40 * 28, visits: 25 * 28 },
    deltaPageviews: 0,
    deltaVisits: 0,
  })
  expect(pocket?.visits?.current).toEqual({ pageviews: 0, visits: 0 })
})

test("logFeed enriches an action with a before/after window", async () => {
  const feed = await run(Reports.use.logFeed())
  const action = feed.find((item) => item.path === "/pocket-alternative")
  expect(action?.isAction).toBe(true)
  expect(action?.readout.state).toBe("window")
})

test("historyReport returns 28 tidied days", async () => {
  const report = await run(Reports.use.historyReport())
  expect(report.days).toHaveLength(28)
  // Days carry a date plus tidied metrics.
  const day = report.days[0]
  expect(day?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(typeof day?.impressions).toBe("number")
})

test("recentActions returns actions newest-first", async () => {
  const actions = await run(Reports.use.recentActions())
  expect(actions.every((entry) => entry.kind !== "note")).toBe(true)
})

test("registryAdd validates keyword rows require cluster/intent/priority", async () => {
  const exit = await runtime.runPromiseExit(
    Reports.use.registryAdd({ target: "/new", keyword: "some keyword" }),
  )
  expect(exit._tag).toBe("Failure")
})

test("logAdd rejects a path that does not start with a slash", async () => {
  const exit = await runtime.runPromiseExit(
    Reports.use.logAdd({ path: "pocket-alternative", kind: "content-update" }),
  )
  expect(exit._tag).toBe("Failure")
})

test("dashboardSnapshot returns RAW internal shapes", async () => {
  const snapshot = await run(Reports.use.dashboardSnapshot())

  // Raw, un-tidied: registry entries are the full RegistryEntry rows.
  expect(snapshot.registry).toEqual(fixtureRegistry)
  expect(snapshot.sitemapPageCount).toBe(fixtureSitemap.length)

  // digest signals carry full-URL pages (not site-relative paths).
  const withPage = snapshot.digest.signals.find(
    (signal) => signal.pages.length > 0,
  )
  expect(withPage?.pages[0]?.startsWith(`${ORIGIN}/`)).toBe(true)

  // performances precomputed for every registry target.
  expect(snapshot.performances.map((item) => item.targetUrl).sort()).toEqual(
    snapshot.registryTargets.map((target) => target.targetUrl).sort(),
  )
  // Per-target series are the raw 28-day RegistryPerformance (metrics not tidied).
  const perf = snapshot.performances[0]?.performance
  expect(perf?.days.length).toBe(28)
})

// --- visits: the analytics provider's series beside the Search Console one ---

test("statusReport names the analytics provider and how much is stored", async () => {
  const report = await run(Reports.use.statusReport())
  expect(report.analytics).toEqual({
    provider: "fake",
    siteId: "1",
    ready: true,
    reason: null,
    days: 56,
    firstDate: "2026-05-18",
    lastDate: "2026-07-12",
    lastSyncedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  })
})

test("pagesReport carries visits over the Search Console windows", async () => {
  const report = await run(Reports.use.pagesReport())
  const top = report.pages.find((page) => page.path === "/chrome-extension")
  // 28 days × 40 pageviews in each window: the visits window is anchored on the
  // Search Console latest date (2026-07-12), so a flat series has no delta.
  expect(top?.visits).toEqual({
    current: { pageviews: 1120, visits: 700 },
    previous: { pageviews: 1120, visits: 700 },
    deltaPageviews: 0,
    deltaVisits: 0,
  })
  // A page only the provider knows still gets a row — unmapped, no clicks.
  const visitsOnly = report.pages.find((page) => page.path === "/visits-only")
  expect(visitsOnly?.mapped).toBe(false)
  expect(visitsOnly?.visits?.current.pageviews).toBe(140)
  expect(visitsOnly?.allQueries?.current.impressions ?? 0).toBe(0)
})

test("pageReport carries the page's visits", async () => {
  const report = await run(Reports.use.pageReport("/chrome-extension"))
  expect(report.visits?.current).toEqual({ pageviews: 1120, visits: 700 })
})

test("historyReport puts each day's visits beside its totals", async () => {
  const report = await run(Reports.use.historyReport())
  expect(report.days).toHaveLength(28)
  for (const day of report.days)
    expect(day.visits).toEqual({ pageviews: 100, visits: 60, visitors: 50 })
})

test("dashboardSnapshot carries the provider, its history, and event counts", async () => {
  const snapshot = await run(Reports.use.dashboardSnapshot())
  expect(snapshot.analytics?.provider).toBe("fake")
  expect(snapshot.visitsHistory).toHaveLength(28)
  expect(snapshot.events).toEqual([{ name: "purchase", current: 56, previous: 56 }])
})

test("eventsReport sums each event over the window and the one before", async () => {
  const report = await run(Reports.use.eventsReport())
  expect(report.analytics?.provider).toBe("fake")
  expect(report.windowDays).toBe(28)
  // Anchored on the newest finished day of visits (here the fixture's last
  // day), not on the Search Console latest date.
  expect(report.window.currentEnd).toBe("2026-07-12")
  expect(report.window.currentStart).toBe("2026-06-15")
  expect(report.window.previousEnd).toBe("2026-06-14")
  expect(report.window.previousStart).toBe("2026-05-18")
  // Two purchases a day, flat, so both windows agree.
  expect(report.events).toEqual([
    { name: "purchase", current: 56, previous: 56, delta: 0 },
  ])

  const week = await run(Reports.use.eventsReport(7))
  expect(week.events).toEqual([{ name: "purchase", current: 14, previous: 14, delta: 0 }])
  expect(week.window.currentStart).toBe("2026-07-06")
})

test("todayReport reads the day in progress from the ledger", async () => {
  // Before the today sync has run: the day is zeros, not an error.
  const before = await run(Reports.use.todayReport())
  expect(before.analytics?.provider).toBe("fake")
  expect(before.today?.date).toBe("2026-07-13")
  expect(before.today?.hoursElapsed).toBe(13)
  expect(before.today?.site).toBeNull()
  expect(before.today?.hours).toHaveLength(24)
  expect(before.today?.syncedAt).toBeNull()

  // What the today sync writes, as it writes it.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveVisits(
        {
          site: [{ date: "2026-07-13", pageviews: 40, visits: 25, visitors: 20 }],
          pages: [{ date: "2026-07-13", page: "/", pageviews: 40, visits: 25 }],
          events: [{ date: "2026-07-13", name: "purchase", count: 1 }],
        },
        ["2026-07-13"],
        "fake",
      )
      yield* storage.saveHours(
        "2026-07-13",
        [{ hour: 12, pageviews: 40, visits: 25, visitors: 20 }],
        "fake",
      )
    }),
  )

  const report = await run(Reports.use.todayReport())
  expect(report.today?.site?.visits).toBe(25)
  expect(report.today?.hours[12]).toEqual({ hour: 12, pageviews: 40, visits: 25, visitors: 20 })
  expect(report.today?.hours[11]).toEqual({ hour: 11, pageviews: 0, visits: 0, visitors: 0 })
  expect(report.today?.pages).toEqual([{ date: "2026-07-13", page: "/", pageviews: 40, visits: 25 }])
  expect(report.today?.events).toEqual([{ date: "2026-07-13", name: "purchase", count: 1 }])
  expect(report.today?.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

  // The events window still ends on the last FINISHED day, so today's partial
  // purchase does not leak into the 28-day figure.
  const events = await run(Reports.use.eventsReport())
  expect(events.window.currentEnd).toBe("2026-07-12")
  expect(events.events).toEqual([{ name: "purchase", current: 56, previous: 56, delta: 0 }])
})

test("revenueReport sums the window and the one before from the ledger, ending on the last whole day", async () => {
  // Nothing synced yet: the status is there, everything else is empty.
  const before = await run(Reports.use.revenueReport())
  expect(before.revenue?.provider).toBe("fake")
  expect(before.days).toEqual([])
  expect(before.currency).toBeNull()
  expect(before.window.currentEnd).toBeNull()

  // Two orders of $19.99 every day up to and including "today" (2026-07-13),
  // as the daily sync and the today sync between them would write it.
  const dates: Array<string> = []
  const cursor = new Date("2026-05-18T00:00:00Z")
  while (cursor <= new Date("2026-07-13T00:00:00Z")) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveRevenue(
        dates.map((date) => ({ date, orders: 2, revenue: 3998, net: 3998, currency: "USD" })),
        dates,
        "fake",
      )
    }),
  )

  const report = await run(Reports.use.revenueReport())
  // Anchored on yesterday: today's row is in the ledger but not in the window.
  expect(report.window).toEqual({
    currentStart: "2026-06-15",
    currentEnd: "2026-07-12",
    previousStart: "2026-05-18",
    previousEnd: "2026-06-14",
  })
  expect(report.currency).toBe("USD")
  expect(report.days).toHaveLength(28)
  expect(report.days[0]?.date).toBe("2026-06-15")
  expect(report.days.at(-1)?.date).toBe("2026-07-12")
  expect(report.current).toEqual({ orders: 56, revenue: 111944, net: 111944 })
  expect(report.previous).toEqual({ orders: 56, revenue: 111944, net: 111944 })
  expect(report.delta).toEqual({ orders: 0, revenue: 0, net: 0 })

  const week = await run(Reports.use.revenueReport(7))
  expect(week.days).toHaveLength(7)
  expect(week.current.orders).toBe(14)

  // The status report counts the synced days too.
  const status = await run(Reports.use.statusReport())
  expect(status.revenue?.provider).toBe("fake")
  expect(status.revenue?.days).toBe(dates.length)
  expect(status.revenue?.lastDate).toBe("2026-07-13")
})

test("liveReport carries the provider status and the live count", async () => {
  const report = await run(Reports.use.liveReport())
  expect(report.analytics?.provider).toBe("fake")
  expect(report.live?.visitors).toBe(4)
  expect(report.live?.windowMinutes).toBe(30)
  expect(report.live?.series).toHaveLength(30)
})
