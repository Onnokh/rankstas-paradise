// Sync service tests: a mocked SearchConsole (records the dates each fetch is
// asked for and returns canned rows), a real Storage over a temp-file SQLite
// database, and fixture Registry/Sitemap/Config/CurrentSite layers. Covers the
// three behaviours that matter: a first sync writes, an immediate re-sync is a
// snapshot no-op, and a stale reconciliation window is re-fetched as a unit.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { Effect, Layer, ManagedRuntime } from "effect"

import { Config } from "../config/config.ts"
import { BingWebmaster } from "../bing-webmaster/bing-webmaster.ts"
import { BingAuthError, type BingSiteDailyTotal } from "../bing-webmaster/schema.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexInspection,
} from "../search-console/schema.ts"
import { SearchConsole } from "../search-console/search-console.ts"
import { Registry } from "../registry/registry.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { type Site } from "../sites/schema.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { Storage } from "../storage/storage.ts"
import { Sync } from "./sync.ts"

// --- fixtures ---------------------------------------------------------------

const site: Site = {
  id: "test" as Site["id"],
  name: "Test",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: ["brandy"],
} satisfies Site

const iso = (date: Date) => date.toISOString().slice(0, 10)
const daysAgo = (n: number) => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - n)
  return iso(date)
}
// The finalization cutoff is today − 3 (see Storage.finalizationCutoff), so the
// reconciliation window is today−3 .. today−7 (newest first).
const reconWindow = [3, 4, 5, 6, 7].map(daysAgo)

const registryEntry = {
  cluster: "",
  keyword: "widget",
  targetUrl: "/widgets",
  intent: "",
  whyOpportunity: "",
  country: "",
  priority: "P1",
  publishedAt: "",
  baselineDate: "",
  status: "",
}

// --- mock SearchConsole that records the dates it is asked to fetch ---------

interface Recorder {
  snapshotFetches: Array<ReadonlyArray<string>>
  totalFetches: Array<ReadonlyArray<string>>
  inspectFetches: Array<ReadonlyArray<string>>
  bingFetches: number
  bingQueryFetches: number
}

const searchConsoleMock = (recorder: Recorder) =>
  Layer.mock(SearchConsole.Service)({
    hasGoogleConnection: () => Effect.succeed(true),
    fetchSearchConsoleSnapshots: (dates) =>
      Effect.sync(() => {
        recorder.snapshotFetches.push(dates)
        return dates.map(
          (date): DailySnapshot => ({
            date,
            query: "widget",
            page: "https://example.com/widgets",
            device: "DESKTOP",
            country: "usa",
            clicks: 1,
            impressions: 10,
            ctr: 0.1,
            position: 5,
          }),
        )
      }),
    fetchDailyTotals: (dates) =>
      Effect.sync(() => {
        recorder.totalFetches.push(dates)
        return {
          site: dates.map((date) => ({
            date,
            clicks: 1,
            impressions: 10,
            ctr: 0.1,
            position: 5,
          })),
          pages: [],
        } satisfies DailyTotals
      }),
    fetchPageIndexStatuses: (targetUrls) =>
      Effect.sync(() => {
        recorder.inspectFetches.push(targetUrls)
        return {
          inspections: targetUrls.map((targetUrl) => ({
            targetUrl,
            status: "indexed" as const,
            verdict: "PASS",
            coverageState: "Submitted and indexed",
          })),
          failed: 0,
        } satisfies PageIndexInspection
      }),
  })

const registryMock = Layer.mock(Registry.Service)({
  loadRegistry: () => Effect.succeed([registryEntry]),
})

const sitemapMock = Layer.mock(Sitemap.Service)({
  refreshSitemapPages: () => Effect.succeed([]),
})

const bingWebmasterMock = (
  recorder: Recorder,
  rows: ReadonlyArray<BingSiteDailyTotal> | "fail",
) =>
  Layer.mock(BingWebmaster.Service)({
    hasBingConnection: () => Effect.succeed(true),
    fetchSiteDailyTotals: () =>
      rows === "fail"
        ? Effect.fail(
            new BingAuthError({ message: "Bing is down for this test." }),
          )
        : Effect.sync(() => {
            recorder.bingFetches += 1
            return rows
          }),
    fetchQueryWindow: () =>
      rows === "fail"
        ? Effect.fail(
            new BingAuthError({ message: "Bing is down for this test." }),
          )
        : Effect.sync(() => {
            recorder.bingQueryFetches += 1
            return [
              {
                query: "widget",
                clicks: 2,
                impressions: 20,
                position: 4,
              },
            ]
          }),
  })

const bingOffMock = Layer.mock(BingWebmaster.Service)({
  hasBingConnection: () => Effect.succeed(false),
  fetchSiteDailyTotals: () => Effect.die("should not be called"),
  fetchQueryWindow: () => Effect.die("should not be called"),
})

const configMock = Layer.mock(Config.Service)({
  debugMode: () => Effect.succeed(false),
})

const currentSiteLayer = (dir: string, dbPath: string) =>
  Layer.succeed(CurrentSite.Service, {
    current: () => Effect.succeed(site),
    dataDirectory: () => Effect.succeed(dir),
    databasePath: () => Effect.succeed(dbPath),
    registryPath: () => Effect.succeed(join(dir, "keyword-registry.csv")),
    sitemapPath: () => Effect.succeed(join(dir, "sitemap.json")),
  } satisfies CurrentSite.Interface)

// --- harness ----------------------------------------------------------------

const makeRuntime = (
  dir: string,
  dbPath: string,
  recorder: Recorder,
  bing: Layer.Layer<BingWebmaster.Service> = bingOffMock,
) => {
  const currentSite = currentSiteLayer(dir, dbPath)
  const deps = Layer.mergeAll(
    searchConsoleMock(recorder),
    bing,
    Storage.layer.pipe(Layer.provide(currentSite)),
    registryMock,
    sitemapMock,
    configMock,
    currentSite,
  )
  return ManagedRuntime.make(Sync.layer.pipe(Layer.provideMerge(deps)))
}

let dir: string
let dbPath: string
let recorder: Recorder
let runtime: ReturnType<typeof makeRuntime>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-sync-"))
  dbPath = join(dir, "search-console.sqlite")
  recorder = { snapshotFetches: [], totalFetches: [], inspectFetches: [], bingFetches: 0, bingQueryFetches: 0 }
  runtime = makeRuntime(dir, dbPath, recorder)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Sync.Service | Storage.Service>) =>
  runtime.runPromise(effect)

// --- tests ------------------------------------------------------------------

test("a first sync writes the tracked window to Storage", async () => {
  const summary = await run(Sync.use.syncSearchConsole())

  // The 28-day tracked window (today−30 .. today−3) is all missing → one fetch
  // of 28 dates, 28 rows persisted, 28 synced days recorded.
  expect(recorder.snapshotFetches).toHaveLength(1)
  expect(recorder.snapshotFetches[0]).toHaveLength(28)
  const summaryDb = await run(Storage.use.snapshotSummary())
  expect(summaryDb).toEqual({ rows: 28, dates: 28 })
  // Index statuses were inspected for the registry target and saved.
  expect(recorder.inspectFetches[0]).toEqual([
    "https://example.com/widgets",
  ])
  expect(summary).toContain("Saved 28 Search Console rows across 28 finalized days")
})

test("an immediate re-sync fetches no new snapshots (idempotent)", async () => {
  await run(Sync.use.syncSearchConsole())
  const rowsAfterFirst = (await run(Storage.use.snapshotSummary())).rows

  await run(Sync.use.syncSearchConsole())

  // Every tracked day is present and fresh (< 6h), so no snapshot fetch fires
  // on the second run and the ledger is unchanged.
  expect(recorder.snapshotFetches).toHaveLength(1)
  expect((await run(Storage.use.snapshotSummary())).rows).toBe(rowsAfterFirst)
  // Index statuses are fresh (< 24h) too, so no second inspection.
  expect(recorder.inspectFetches).toHaveLength(1)
})

test("a stale reconciliation window is re-fetched as a unit", async () => {
  await run(Sync.use.syncSearchConsole())
  expect(recorder.snapshotFetches).toHaveLength(1)

  // Age every synced day past the 6h reconciliation TTL. The days are still
  // present (not missing), so only the reconciliation window should re-fetch.
  const db = new Database(dbPath)
  db.run("update synced_day set fetched_at = datetime('now', '-10 hours')")
  db.close()

  await run(Sync.use.syncSearchConsole())

  // Exactly the newest-5-days window, fetched as one call.
  expect(recorder.snapshotFetches).toHaveLength(2)
  expect([...recorder.snapshotFetches[1]!].sort()).toEqual([...reconWindow].sort())
})

test("a Bing failure leaves the Google sync successful", async () => {
  runtime = makeRuntime(dir, dbPath, recorder, bingWebmasterMock(recorder, "fail"))
  const summary = await run(Sync.use.syncSearchConsole())

  expect(recorder.snapshotFetches).toHaveLength(1)
  expect(summary).toContain("Saved 28 Search Console rows")
  expect(summary).toContain("Bing site totals: skipped")
})

test("a connected Bing sync saves site daily rows", async () => {
  const bingRows = [
    { date: daysAgo(2), clicks: 4, impressions: 70 },
    { date: daysAgo(3), clicks: 1, impressions: 18 },
  ]
  runtime = makeRuntime(
    dir,
    dbPath,
    recorder,
    bingWebmasterMock(recorder, bingRows),
  )
  const summary = await run(Sync.use.syncSearchConsole())

  expect(recorder.bingFetches).toBe(1)
  expect(recorder.bingQueryFetches).toBe(1)
  expect(summary).toContain("Bing site totals: 2 days saved (5 clicks)")
  expect(summary).toContain("Bing query window: 1 queries captured on")
  const stored = await run(
    Storage.use.bingSiteDailyBetween(daysAgo(3), daysAgo(2)),
  )
  expect(stored).toHaveLength(2)
  const queryWindow = await run(Storage.use.bingQueryWindowLatest())
  expect(queryWindow?.rows).toEqual([
    { query: "widget", clicks: 2, impressions: 20, position: 4 },
  ])
})
