// Sync service tests: a mocked SearchConsole (records the dates each fetch is
// asked for and returns canned rows), a real Storage over a temp-file SQLite
// database, and fixture Registry/Sitemap/Config/CurrentSite layers. Covers the
// behaviours that matter: a first sync writes, an immediate re-sync is a
// snapshot no-op, a stale reconciliation window is re-fetched as a unit, and the
// three ways lastCheckedAt and lastSyncedAt move (or refuse to) together.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"

import { Analytics } from "../analytics/analytics.ts"
import { AnalyticsError, type VisitsDays } from "../analytics/schema.ts"
import { Config } from "../config/config.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexInspection,
} from "../search-console/schema.ts"
import { SearchConsoleHttpError } from "../search-console/schema.ts"
import { SearchConsole } from "../search-console/search-console.ts"
import { Registry } from "../registry/registry.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { DomainRating } from "../domain-rating/domain-rating.ts"
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
  visitFetches: Array<ReadonlyArray<string>>
}

const searchConsoleMock = (recorder: Recorder) =>
  Layer.mock(SearchConsole.Service)({
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

// A SearchConsole whose very first fetch fails, so a whole sync run fails.
const failingSearchConsole = Layer.mock(SearchConsole.Service)({
  fetchSearchConsoleSnapshots: () =>
    Effect.fail(
      new SearchConsoleHttpError({
        message: "Google refused the request.",
        status: 503,
      }),
    ),
})

// --- mock Analytics: a ready "fake" provider that records the dates asked ---

const analyticsMock = (recorder: Recorder) =>
  Layer.mock(Analytics.Service)({
    status: () =>
      Effect.succeed({
        provider: "fake",
        siteId: "1",
        ready: true,
        reason: null,
      }),
    fetchVisits: (dates) =>
      Effect.sync((): VisitsDays => {
        recorder.visitFetches.push(dates)
        return {
          site: dates.map((date) => ({
            date,
            pageviews: 20,
            visits: 10,
            visitors: 8,
          })),
          pages: dates.map((date) => ({
            date,
            page: "/widgets",
            pageviews: 12,
            visits: 6,
          })),
          events: dates.map((date) => ({ date, name: "purchase", count: 1 })),
        }
      }),
  })

// A site with no analytics configured: status null, and a fetch would be a bug.
const noAnalyticsMock = Layer.mock(Analytics.Service)({
  status: () => Effect.succeed(null),
})

// A configured provider whose every fetch fails (a wrong key, a vendor outage).
const failingAnalyticsMock = Layer.mock(Analytics.Service)({
  status: () =>
    Effect.succeed({ provider: "fake", siteId: "1", ready: true, reason: null }),
  fetchVisits: () =>
    Effect.fail(new AnalyticsError({ message: "The provider refused the key." })),
})

const registryMock = Layer.mock(Registry.Service)({
  loadRegistry: () => Effect.succeed([registryEntry]),
})

const sitemapMock = Layer.mock(Sitemap.Service)({
  refreshSitemapPages: () => Effect.succeed([]),
})

// Domain Rating is a third-party read the sync forks and swallows, so a stub
// that yields nothing is enough: these tests assert the Search Console work,
// and a rating must never be able to change its outcome.
const domainRatingMock = Layer.mock(DomainRating.Service)({
  refresh: () => Effect.succeed(null),
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
  searchConsole: Layer.Layer<SearchConsole.Service> = searchConsoleMock(recorder),
  analytics: Layer.Layer<Analytics.Service> = analyticsMock(recorder),
) => {
  const currentSite = currentSiteLayer(dir, dbPath)
  const deps = Layer.mergeAll(
    searchConsole,
    analytics,
    Storage.layer.pipe(Layer.provide(currentSite)),
    registryMock,
    sitemapMock,
    domainRatingMock,
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
  recorder = {
    snapshotFetches: [],
    totalFetches: [],
    inspectFetches: [],
    visitFetches: [],
  }
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

// --- visits: the analytics provider rides along on the sync -----------------

test("a first sync fetches the last 28 whole days of visits and saves them", async () => {
  const summary = await run(Sync.use.syncSearchConsole())

  // One fetch of 28 dates ending yesterday: visits have no finalization lag.
  expect(recorder.visitFetches).toHaveLength(1)
  const asked = [...recorder.visitFetches[0]!].sort()
  expect(asked).toHaveLength(28)
  expect(asked.at(-1)).toBe(daysAgo(1))
  expect(asked[0]).toBe(daysAgo(28))
  const stored = await run(Storage.use.visitsSummary())
  expect(stored).toEqual({
    days: 28,
    firstDate: daysAgo(28),
    lastDate: daysAgo(1),
    source: "fake",
  })
  expect(summary).toContain("Visits: 28 days from fake.")
})

test("an immediate re-sync fetches no visits, then re-fetches only the stale two days", async () => {
  await run(Sync.use.syncSearchConsole())
  await run(Sync.use.syncSearchConsole())
  // Every day is present and fresh, so the second run asks for nothing.
  expect(recorder.visitFetches).toHaveLength(1)

  // Age every fetched day past the TTL: only the two-day reconcile window
  // should go back to the provider, as one call.
  const db = new Database(dbPath)
  db.run("update analytics_synced_day set fetched_at = datetime('now', '-10 hours')")
  db.close()
  await run(Sync.use.syncSearchConsole())

  expect(recorder.visitFetches).toHaveLength(2)
  expect([...recorder.visitFetches[1]!].sort()).toEqual([daysAgo(2), daysAgo(1)])
})

test("a site without analytics fetches no visits and stamps nothing", async () => {
  const quiet = makeRuntime(dir, dbPath, recorder, searchConsoleMock(recorder), noAnalyticsMock)
  try {
    const summary = await quiet.runPromise(Sync.use.syncSearchConsole())
    expect(recorder.visitFetches).toHaveLength(0)
    expect(summary).not.toContain("Visits:")
    const stored = await quiet.runPromise(Storage.use.visitsSummary())
    expect(stored.days).toBe(0)
  } finally {
    await quiet.dispose()
  }
})

test("a failing analytics provider does not fail the Search Console sync", async () => {
  const broken = makeRuntime(dir, dbPath, recorder, searchConsoleMock(recorder), failingAnalyticsMock)
  try {
    const summary = await broken.runPromise(Sync.use.syncSearchConsole())
    // The Search Console work landed and the run stamped itself as complete…
    expect(summary).toContain("Saved 28 Search Console rows")
    expect(await broken.runPromise(Storage.use.latestCheckedAt())).not.toBeNull()
    // …while the visits side reports nothing rather than a wrong number.
    expect(summary).not.toContain("Visits:")
    expect((await broken.runPromise(Storage.use.visitsSummary())).days).toBe(0)
  } finally {
    await broken.dispose()
  }
})

// --- lastCheckedAt: "it ran" recorded apart from "the data changed" ----------

// Backdate an instant to a fixed, obviously-old value so a test can tell "moved"
// from "did not move" without racing SQLite's one-second timestamp resolution.
const backdated = "2024-01-01 00:00:00"
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const backdate = (target: "sync_run" | "both") => {
  const db = new Database(dbPath)
  if (target === "both")
    db.run("update synced_day set fetched_at = '" + backdated + "'")
  db.run("update sync_run set checked_at = '" + backdated + "'")
  db.close()
}

test("a sync that fetches nothing still advances lastCheckedAt", async () => {
  await run(Sync.use.syncSearchConsole())
  // Age only the check stamp. Every synced day stays fresh, so this second run
  // finds nothing missing and nothing stale — the exact case that used to leave
  // no trace anywhere, and so read from outside as a feature that never ran.
  backdate("sync_run")

  await run(Sync.use.syncSearchConsole())

  expect(recorder.snapshotFetches).toHaveLength(1)
  const checkedAt = await run(Storage.use.latestCheckedAt())
  expect(checkedAt).toMatch(ISO_INSTANT)
  expect(checkedAt).not.toBe("2024-01-01T00:00:00Z")
  // The data did not change, so lastSyncedAt must not claim it did: it still
  // reports the first run's write, untouched by this one.
  expect(await run(Storage.use.latestSyncedAt())).toMatch(ISO_INSTANT)
})

test("a sync that fetches something advances both instants", async () => {
  await run(Sync.use.syncSearchConsole())
  // Age both. The reconciliation window is now stale, so this run does fetch.
  backdate("both")

  await run(Sync.use.syncSearchConsole())

  expect(recorder.snapshotFetches).toHaveLength(2)
  const syncedAt = await run(Storage.use.latestSyncedAt())
  const checkedAt = await run(Storage.use.latestCheckedAt())
  expect(syncedAt).toMatch(ISO_INSTANT)
  expect(checkedAt).toMatch(ISO_INSTANT)
  expect(syncedAt).not.toBe("2024-01-01T00:00:00Z")
  expect(checkedAt).not.toBe("2024-01-01T00:00:00Z")
})

test("a failed sync advances neither instant", async () => {
  const failing = makeRuntime(dir, dbPath, recorder, failingSearchConsole)
  try {
    const exit = await failing.runPromiseExit(Sync.use.syncSearchConsole())
    expect(Exit.isFailure(exit)).toBe(true)

    // Nothing was fetched and nothing was stamped, so a client reading status
    // sees both fields null. "Never checked" is the honest answer; the reason
    // the run failed goes to the error log, not into the ledger.
    expect(await failing.runPromise(Storage.use.latestSyncedAt())).toBeNull()
    expect(await failing.runPromise(Storage.use.latestCheckedAt())).toBeNull()
  } finally {
    await failing.dispose()
  }
})
