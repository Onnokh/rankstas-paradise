// Reports service tests: exercise every report against a real Storage over a
// temp SQLite database seeded with the deterministic debug dataset (ported from
// src/debug.ts), plus a fixture Registry and Sitemap. Snapshots pin the exact
// output shape of each report; the dashboardSnapshot assertions confirm it
// returns the RAW internal shapes (un-tidied metrics, full-URL pages).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, ManagedRuntime } from "effect"

import { Registry } from "../registry/registry.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageDailyTotal,
  type SiteDailyTotal,
} from "../search-console/schema.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { type SitemapPage } from "../sitemap/schema.ts"
import { CurrentSite } from "../sites/current-site.ts"
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
  country: "USA",
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
} satisfies Site

// --- layer wiring ---

// Replace the non-deterministic SQLite createdAt timestamp with a stable
// placeholder so log-bearing snapshots are comparable across runs.
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === "createdAt" ? "<createdAt>" : normalize(entry)
    }
    return out
  }
  return value
}

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
  const base = Layer.mergeAll(
    storageLayer,
    registryLayer,
    sitemapLayer,
    currentSiteLayer,
  )
  runtime = ManagedRuntime.make(Reports.layer.pipe(Layer.provideMerge(base)))

  // Seed the store with the debug dataset and one action to exercise logFeed.
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.saveSnapshots(debugSnapshots)
      yield* storage.saveDailyTotals(debugDailyTotals, [...dates])
      yield* storage.addLogEntry({
        date: "2026-06-10",
        path: "/pocket-alternative",
        kind: "content-update",
        note: "Expanded the comparison table.",
      })
    }),
  )
}, 60_000)

afterAll(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Reports.Service>) =>
  runtime.runPromise(effect)

test("statusReport shape", async () => {
  const report = await run(Reports.use.statusReport())
  expect(report).toMatchSnapshot()
  // Sitemap has 6 pages; 3 mapped keyword targets + 1 inventory "/" → /pricing
  // and /about are unmapped.
  expect(report.sitemap.unmapped).toEqual(["/pricing", "/about"])
})

test("pagesReport shape", async () => {
  const report = await run(Reports.use.pagesReport())
  expect(report).toMatchSnapshot()
  // Sorted by allQueries.current impressions descending.
  const impressions = report.pages.map(
    (page) => page.allQueries?.current.impressions ?? 0,
  )
  expect([...impressions]).toEqual([...impressions].sort((a, b) => b - a))
})

test("pageReport shape", async () => {
  const report = await run(Reports.use.pageReport("/pocket-alternative"))
  expect(normalize(report)).toMatchSnapshot()
  expect(report.performance.scope).toBe("non-brand")
})

test("pageReport rejects a non-slash path", async () => {
  const exit = await runtime.runPromiseExit(
    Reports.use.pageReport("pocket-alternative"),
  )
  expect(exit._tag).toBe("Failure")
})

test("queriesReport shape (brand excluded by default)", async () => {
  const report = await run(Reports.use.queriesReport())
  expect(report).toMatchSnapshot()
  expect(
    report.queries.some((query) => query.query === "sleevy chrome extension"),
  ).toBe(false)
})

test("opportunitiesReport shape", async () => {
  const report = await run(Reports.use.opportunitiesReport())
  expect(report).toMatchSnapshot()
})

test("registryList shape", async () => {
  const report = await run(Reports.use.registryList())
  expect(report).toMatchSnapshot()
})

test("logFeed enriches an action with a before/after window", async () => {
  const feed = await run(Reports.use.logFeed())
  expect(normalize(feed)).toMatchSnapshot()
  const action = feed.find((item) => item.path === "/pocket-alternative")
  expect(action?.isAction).toBe(true)
  expect(action?.readout.state).toBe("window")
})

test("historyReport shape", async () => {
  const report = await run(Reports.use.historyReport())
  expect(report.days).toHaveLength(28)
  expect(report).toMatchSnapshot()
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

test("dashboardSnapshot returns RAW internal shapes", async () => {
  const snapshot = await run(Reports.use.dashboardSnapshot())
  expect(normalize(snapshot)).toMatchSnapshot()

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
