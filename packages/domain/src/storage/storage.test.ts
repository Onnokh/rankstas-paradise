// Storage service tests: seed a temp-file SQLite database via a test
// CurrentSite layer, then exercise representative reads/writes plus one
// transaction-rollback case. The DDL + backfill run once on layer acquisition.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Database } from "bun:sqlite"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"

import { CurrentSite } from "../sites/current-site.ts"
import { type Site } from "../sites/schema.ts"
import { type StorageError } from "./schema.ts"
import { type VisitsDays } from "../analytics/schema.ts"
import { Storage } from "./storage.ts"

const site: Site = {
  id: "test" as Site["id"],
  name: "Test",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: ["brandy"],
} satisfies Site

const currentSiteLayer = (dir: string, dbPath: string, forSite: Site = site) =>
  Layer.succeed(CurrentSite.Service, {
    current: () => Effect.succeed(forSite),
    dataDirectory: () => Effect.succeed(dir),
    databasePath: () => Effect.succeed(dbPath),
    registryPath: () => Effect.succeed(join(dir, "keyword-registry.csv")),
    sitemapPath: () => Effect.succeed(join(dir, "sitemap.json")),
  } satisfies CurrentSite.Interface)

let dir: string
let dbPath: string
let runtime: ManagedRuntime.ManagedRuntime<Storage.Service, StorageError>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-storage-"))
  dbPath = join(dir, "search-console.sqlite")
  runtime = ManagedRuntime.make(
    Storage.layer.pipe(Layer.provide(currentSiteLayer(dir, dbPath))),
  )
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Storage.Service>) =>
  runtime.runPromise(effect)

const snapshot = (over: Partial<Parameters<typeof mkSnapshot>[0]> = {}) =>
  mkSnapshot(over)

function mkSnapshot(over: {
  date?: string
  query?: string
  page?: string
  device?: string
  country?: string
  clicks?: number
  impressions?: number
  ctr?: number
  position?: number
}) {
  return {
    date: over.date ?? "2024-01-10",
    query: over.query ?? "widget",
    page: over.page ?? "https://example.com/widgets",
    device: over.device ?? "DESKTOP",
    country: over.country ?? "usa",
    clicks: over.clicks ?? 5,
    impressions: over.impressions ?? 100,
    ctr: over.ctr ?? 0.05,
    position: over.position ?? 8,
  }
}

test("empty database reads return zeroed/null shapes", async () => {
  expect(await run(Storage.use.snapshotSummary())).toEqual({ rows: 0, dates: 0 })
  expect(await run(Storage.use.latestSnapshotDate())).toBeNull()
  expect(await run(Storage.use.latestSyncedAt())).toBeNull()
  expect(await run(Storage.use.latestCheckedAt())).toBeNull()
  expect(await run(Storage.use.historyWithPending())).toEqual([])
  expect(await run(Storage.use.snapshotDateRange())).toEqual({
    first: null,
    last: null,
  })
  const digest = await run(Storage.use.opportunityDigest([]))
  expect(digest.latestDate).toBeNull()
  expect(digest.signals).toEqual([])
})

test("saveSnapshots persists rows and reads aggregate correctly", async () => {
  await run(
    Storage.use.saveSnapshots([
      snapshot({ query: "widget", clicks: 5, impressions: 100, position: 8 }),
      snapshot({
        query: "brandy shoes",
        clicks: 2,
        impressions: 10,
        ctr: 0.2,
        position: 3,
      }),
    ]),
  )

  expect(await run(Storage.use.latestSnapshotDate())).toBe("2024-01-10")
  expect(await run(Storage.use.snapshotSummary())).toEqual({ rows: 2, dates: 1 })
  expect(await run(Storage.use.snapshotDateRange())).toEqual({
    first: "2024-01-10",
    last: "2024-01-10",
  })
  expect(
    await run(Storage.use.missingSnapshotDates(["2024-01-10", "2024-01-11"])),
  ).toEqual(["2024-01-11"])
  expect(await run(Storage.use.recentlySyncedDates(["2024-01-10"], 24))).toEqual([
    "2024-01-10",
  ])
  expect(await run(Storage.use.syncedWithinHours(24))).toBe(true)

  // topQueries excludes brand queries by default ("brandy shoes" matches %brandy%).
  const top = await run(Storage.use.topQueries())
  expect(top.rows.map((row) => row.query)).toEqual(["widget"])
  const topAll = await run(Storage.use.topQueries({ includeBrand: true }))
  expect(topAll.rows.map((row) => row.query).sort()).toEqual([
    "brandy shoes",
    "widget",
  ])
})

test("latestSyncedAt reports the newest synced day's fetched_at", async () => {
  await run(
    Storage.use.saveSnapshots([
      snapshot({ date: "2024-01-10" }),
      snapshot({ date: "2024-01-11" }),
    ]),
  )

  // Both days were just fetched. Restate the two instants hours apart so the
  // newest one is unambiguous; SQLite writes fetched_at as UTC
  // 'YYYY-MM-DD HH:MM:SS', which latestSyncedAt returns as an ISO 8601 instant.
  const db = new Database(dbPath)
  db.run(
    "update synced_day set fetched_at = '2024-01-11 06:00:00' where date = '2024-01-10'",
  )
  db.run(
    "update synced_day set fetched_at = '2024-01-11 09:30:15' where date = '2024-01-11'",
  )
  db.close()

  expect(await run(Storage.use.latestSyncedAt())).toBe("2024-01-11T09:30:15Z")
})

test("recordSyncCheck stamps one row and later checks overwrite it", async () => {
  await run(Storage.use.recordSyncCheck())
  expect(await run(Storage.use.latestCheckedAt())).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  )

  // Backdate the stamp, then check again. sync_run holds one row, so the second
  // check overwrites the first rather than accumulating a series — and a stamp
  // written by an earlier process survives into this one, which is the whole
  // reason it is in the ledger and not in memory.
  const db = new Database(dbPath)
  db.run("update sync_run set checked_at = '2024-01-01 00:00:00'")
  db.close()
  expect(await run(Storage.use.latestCheckedAt())).toBe("2024-01-01T00:00:00Z")

  await run(Storage.use.recordSyncCheck())
  const restamped = await run(Storage.use.latestCheckedAt())
  expect(restamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  expect(restamped).not.toBe("2024-01-01T00:00:00Z")
  const rows = new Database(dbPath).query("select count(*) as n from sync_run")
  expect((rows.get() as { n: number }).n).toBe(1)
})

test("a day Google returns nothing for is stored as zero, not left missing", async () => {
  // The whole point: an empty day must not come back as "missing" on the next
  // sync, or a quiet site re-asks about the same days forever.
  await run(
    Storage.use.saveDailyTotals({ site: [], pages: [] }, ["2024-02-01", "2024-02-02"]),
  )

  expect(
    await run(Storage.use.missingDailyTotalDates(["2024-02-01", "2024-02-02"])),
  ).toEqual([])

  const history = await run(Storage.use.historyWithPending())
  const day = history.find((candidate) => candidate.date === "2024-02-01")
  expect(day?.impressions).toBe(0)
  expect(day?.clicks).toBe(0)
})

test("an empty response never overwrites a reading already stored", async () => {
  await run(
    Storage.use.saveDailyTotals(
      {
        site: [
          { date: "2024-03-01", clicks: 4, impressions: 90, ctr: 0.044, position: 6 },
        ],
        pages: [],
      },
      ["2024-03-01"],
    ),
  )
  // A transient empty answer for the same date must leave the real numbers alone.
  await run(Storage.use.saveDailyTotals({ site: [], pages: [] }, ["2024-03-01"]))

  const history = await run(Storage.use.historyWithPending())
  const day = history.find((candidate) => candidate.date === "2024-03-01")
  expect(day?.impressions).toBe(90)
  expect(day?.clicks).toBe(4)
})

test("saveDailyTotals feeds pagesWindowOverview true totals + coverage", async () => {
  await run(
    Storage.use.saveSnapshots([
      snapshot({ clicks: 5, impressions: 100, position: 8 }),
    ]),
  )
  await run(
    Storage.use.saveDailyTotals(
      {
        site: [
          {
            date: "2024-01-10",
            clicks: 9,
            impressions: 200,
            ctr: 0.045,
            position: 7,
          },
        ],
        pages: [
          {
            date: "2024-01-10",
            page: "https://example.com/widgets",
            clicks: 8,
            impressions: 150,
            ctr: 0.053,
            position: 7.5,
          },
        ],
      },
      ["2024-01-10"],
    ),
  )

  expect(await run(Storage.use.missingDailyTotalDates(["2024-01-10", "x"]))).toEqual(
    ["x"],
  )
  const overview = await run(Storage.use.pagesWindowOverview())
  expect(overview.totalsCoverage).toEqual({ siteDays: 1, pageDays: 1 })
  const row = overview.rows.find(
    (candidate) => candidate.page === "https://example.com/widgets",
  )
  expect(row?.trueTotals?.current.impressions).toBe(150)
  expect(row?.allQueries.current.impressions).toBe(100)

  // historyWithPending reads the true site-wide daily totals from site_daily
  // (200 impressions), NOT the query-row sum from search_snapshot (100). The
  // day is old, so it is not flagged provisional.
  const history = await run(Storage.use.historyWithPending())
  expect(history).toEqual([
    {
      date: "2024-01-10",
      impressions: 200,
      clicks: 9,
      ctr: 0.045,
      position: 7,
      provisional: false,
    },
  ])
})

test("addLogEntry returns assigned id/createdAt and listLog filters by path", async () => {
  const entry = await run(
    Storage.use.addLogEntry({
      date: "2024-01-10",
      path: "/widgets",
      kind: "publish",
      note: "launched",
    }),
  )
  expect(entry.id).toBe(1)
  expect(entry.createdAt).toBeTruthy()
  expect(entry).toMatchObject({
    date: "2024-01-10",
    path: "/widgets",
    kind: "publish",
    note: "launched",
  })

  const log = await run(Storage.use.listLog())
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ id: 1, kind: "publish" })
  expect(await run(Storage.use.listLog("/other"))).toEqual([])
})

test("index statuses upsert, prune (returning count) and freshness", async () => {
  await run(
    Storage.use.savePageIndexStatuses([
      {
        targetUrl: "https://example.com/a",
        status: "indexed",
        verdict: "PASS",
        coverageState: "Submitted and indexed",
      },
      {
        targetUrl: "https://example.com/b",
        status: "not-indexed",
        verdict: "NEUTRAL",
        coverageState: "Discovered",
      },
    ]),
  )
  expect(
    await run(
      Storage.use.recentlyInspectedUrls(
        ["https://example.com/a", "https://example.com/c"],
        24,
      ),
    ),
  ).toEqual(["https://example.com/a"])

  // Keep only /a → /b is pruned.
  expect(await run(Storage.use.pruneIndexStatuses(["https://example.com/a"]))).toBe(1)
  expect(
    await run(
      Storage.use.recentlyInspectedUrls(["https://example.com/b"], 24),
    ),
  ).toEqual([])
  // Empty keep-set prunes everything.
  expect(await run(Storage.use.pruneIndexStatuses([]))).toBe(1)
})

test("capturePageBaselines + registryProgress", async () => {
  // Seed a window of data ending well before the baseline date.
  await run(
    Storage.use.saveSnapshots([
      snapshot({
        date: "2024-03-01",
        query: "widget",
        page: "https://example.com/widgets",
        clicks: 4,
        impressions: 80,
        position: 6,
      }),
    ]),
  )
  const capture = await run(
    Storage.use.capturePageBaselines(
      [
        {
          cluster: "",
          keyword: "widget",
          targetUrl: "/widgets",
          intent: "",
          whyOpportunity: "",
          priority: "P1",
          publishedAt: "2024-02-01",
          baselineDate: "2024-02-01",
          status: "",
        },
      ],
      "2024-03-10",
    ),
  )
  expect(capture.targets).toBe(1)
  expect(capture.windowEnd).toBe("2024-03-07")
  expect(capture.windowStart).toBe("2024-02-09")

  const progress = await run(
    Storage.use.registryProgress([
      {
        cluster: "",
        keyword: "widget",
        targetUrl: "/widgets",
        intent: "",
        whyOpportunity: "",
        priority: "P1",
        publishedAt: "2024-02-01",
        baselineDate: "2024-02-01",
        status: "",
      },
    ]),
  )
  expect(progress).toHaveLength(1)
  expect(progress[0]?.state).toBe("measuring")
  expect(progress[0]?.baseline).not.toBeNull()
  expect(progress[0]?.target.impressions).toBe(80)
})

test("finalizationCutoff is today − 3 (UTC)", async () => {
  const expected = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z")
  expected.setUTCDate(expected.getUTCDate() - 3)
  expect(await run(Storage.use.finalizationCutoff())).toBe(
    expected.toISOString().slice(0, 10),
  )
})

test("saveSnapshots rolls back the delete-then-insert atomically on failure", async () => {
  await run(
    Storage.use.saveSnapshots([snapshot({ date: "2024-02-01", clicks: 5 })]),
  )
  expect((await run(Storage.use.snapshotSummary())).rows).toBe(1)

  // A NOT NULL violation mid-transaction: the date's rows were deleted first,
  // then the insert fails — the transaction must roll back and restore them.
  const bad = [
    {
      date: "2024-02-01",
      query: "widget",
      page: "https://example.com/widgets",
      device: "DESKTOP",
      country: "usa",
      clicks: null as unknown as number,
      impressions: 100,
      ctr: 0.05,
      position: 8,
    },
  ]
  const exit = await runtime.runPromiseExit(
    Storage.use.saveSnapshots(bad, ["2024-02-01"]),
  )
  expect(Exit.isFailure(exit)).toBe(true)

  // Original row survived the rolled-back delete.
  expect((await run(Storage.use.snapshotSummary())).rows).toBe(1)
  expect(await run(Storage.use.latestSnapshotDate())).toBe("2024-02-01")
})

// --- visits: the analytics provider's canonical rows ------------------------

const visitsFor = (dates: ReadonlyArray<string>, pages: ReadonlyArray<string> = ["/a"]): VisitsDays => ({
  site: dates.map((date) => ({ date, pageviews: 10, visits: 6, visitors: 5 })),
  pages: dates.flatMap((date) =>
    pages.map((page) => ({ date, page, pageviews: 4, visits: 3 })),
  ),
  events: dates.map((date) => ({ date, name: "purchase", count: 1 })),
})

test("saveVisits round-trips the rows and stamps every fetched date", async () => {
  // Three dates fetched, the provider answered for two: the third is stored as
  // a day of zero visits so it never reads as missing again.
  await run(
    Storage.use.saveVisits(
      visitsFor(["2024-01-10", "2024-01-11"]),
      ["2024-01-10", "2024-01-11", "2024-01-12"],
      "fake",
    ),
  )

  expect(await run(Storage.use.visitsSummary())).toEqual({
    days: 3,
    firstDate: "2024-01-10",
    lastDate: "2024-01-12",
    source: "fake",
  })
  const history = await run(Storage.use.visitsHistory())
  expect(history.map((day) => day.pageviews)).toEqual([10, 10, 0])
  expect(await run(Storage.use.missingVisitDates(["2024-01-09", "2024-01-10"]))).toEqual([
    "2024-01-09",
  ])
  expect(
    await run(Storage.use.recentlySyncedVisitDates(["2024-01-10", "2024-01-13"], 1)),
  ).toEqual(["2024-01-10"])
  expect(await run(Storage.use.latestVisitsSyncedAt())).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  )
})

test("a day's rows and hours read back as written, and the day knows when it was synced", async () => {
  await run(Storage.use.saveVisits(visitsFor(["2024-01-10"], ["/a", "/b"]), ["2024-01-10"], "fake"))
  await run(
    Storage.use.saveHours(
      "2024-01-10",
      [
        { hour: 9, pageviews: 4, visits: 3, visitors: 2 },
        { hour: 7, pageviews: 1, visits: 1, visitors: 1 },
      ],
      "fake",
    ),
  )

  const day = await run(Storage.use.visitsOfDay("2024-01-10"))
  expect(day.site).toEqual([{ date: "2024-01-10", pageviews: 10, visits: 6, visitors: 5 }])
  expect(day.pages.map((row) => row.page)).toEqual(["/a", "/b"])
  expect(day.events).toEqual([{ date: "2024-01-10", name: "purchase", count: 1 }])
  // Hour ascending, whatever order they were written in.
  expect((await run(Storage.use.hoursOfDay("2024-01-10"))).map((row) => row.hour)).toEqual([7, 9])
  expect(await run(Storage.use.visitsSyncedAt("2024-01-10"))).toMatch(/^\d{4}-\d{2}-\d{2}T/)

  // A second write replaces the day's hours rather than adding to them.
  await run(Storage.use.saveHours("2024-01-10", [{ hour: 10, pageviews: 1, visits: 1, visitors: 1 }], "fake"))
  expect((await run(Storage.use.hoursOfDay("2024-01-10"))).map((row) => row.hour)).toEqual([10])

  // A day never synced is empty, not an error.
  expect(await run(Storage.use.visitsOfDay("2024-01-11"))).toEqual({ site: [], pages: [], events: [] })
  expect(await run(Storage.use.hoursOfDay("2024-01-11"))).toEqual([])
  expect(await run(Storage.use.visitsSyncedAt("2024-01-11"))).toBeNull()
})

test("revenue rows read back as written, quiet fetched days as zeros, unsynced days absent", async () => {
  const days = [
    { date: "2024-02-02", orders: 2, revenue: 3998, net: 3998, currency: "USD" },
    { date: "2024-02-01", orders: 1, revenue: 1999, net: 0, currency: "USD" },
  ]
  // Three days fetched, two with sales: the third is a quiet day, not a gap.
  await run(Storage.use.saveRevenue(days, ["2024-02-01", "2024-02-02", "2024-02-03"], "fake"))

  expect(await run(Storage.use.revenueDays("2024-01-31", "2024-02-04"))).toEqual([
    { date: "2024-02-01", orders: 1, revenue: 1999, net: 0, currency: "USD" },
    { date: "2024-02-02", orders: 2, revenue: 3998, net: 3998, currency: "USD" },
    { date: "2024-02-03", orders: 0, revenue: 0, net: 0, currency: "USD" },
  ])
  expect(await run(Storage.use.missingRevenueDates(["2024-02-03", "2024-02-04"]))).toEqual([
    "2024-02-04",
  ])
  expect(
    await run(Storage.use.recentlySyncedRevenueDates(["2024-02-01", "2024-02-04"], 1)),
  ).toEqual(["2024-02-01"])
  expect(await run(Storage.use.revenueSummary())).toEqual({
    days: 3,
    firstDate: "2024-02-01",
    lastDate: "2024-02-03",
    source: "fake",
  })
  expect(await run(Storage.use.latestRevenueSyncedAt())).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  // Per day, as the visits twin does: a fetched quiet day has an instant, a
  // day never fetched has none.
  expect(await run(Storage.use.revenueSyncedAt("2024-02-03"))).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(await run(Storage.use.revenueSyncedAt("2024-02-04"))).toBeNull()

  // A refund lands days later: the reconcile overwrites the row.
  await run(
    Storage.use.saveRevenue(
      [{ date: "2024-02-02", orders: 2, revenue: 3998, net: 1999, currency: "USD" }],
      ["2024-02-02"],
      "fake",
    ),
  )
  expect(await run(Storage.use.revenueDays("2024-02-02", "2024-02-02"))).toEqual([
    { date: "2024-02-02", orders: 2, revenue: 3998, net: 1999, currency: "USD" },
  ])
})

test("pageVisitsOverview and eventWindow anchor on the end date given", async () => {
  const days = ["2024-01-10", "2024-01-11", "2024-01-12", "2024-01-13"]
  await run(Storage.use.saveVisits(visitsFor(days, ["/a", "/b"]), days, "fake"))

  // A two-day window ending on the 13th: current = 12th+13th, previous = 10th+11th.
  const overview = await run(Storage.use.pageVisitsOverview(2, "2024-01-13"))
  expect(overview.currentStart).toBe("2024-01-12")
  expect(overview.previousStart).toBe("2024-01-10")
  expect(overview.previousEnd).toBe("2024-01-11")
  expect(overview.rows).toEqual([
    { page: "/a", current: { pageviews: 8, visits: 6 }, previous: { pageviews: 8, visits: 6 } },
    { page: "/b", current: { pageviews: 8, visits: 6 }, previous: { pageviews: 8, visits: 6 } },
  ])
  expect(await run(Storage.use.eventWindow(2, "2024-01-13"))).toEqual([
    { name: "purchase", current: 2, previous: 2 },
  ])

  // Without an end date the window ends on the newest visits day.
  const latest = await run(Storage.use.pageVisitsOverview(2))
  expect(latest.latestDate).toBe("2024-01-13")
})

test("re-fetching a day replaces its page and event rows", async () => {
  await run(Storage.use.saveVisits(visitsFor(["2024-01-10"], ["/a", "/b"]), ["2024-01-10"], "fake"))
  await run(Storage.use.saveVisits(visitsFor(["2024-01-10"], ["/a"]), ["2024-01-10"], "other"))

  const overview = await run(Storage.use.pageVisitsOverview(1, "2024-01-10"))
  expect(overview.rows.map((row) => row.page)).toEqual(["/a"])
  // The newest fetch names the provider that wrote it.
  expect((await run(Storage.use.visitsSummary())).source).toBe("other")
})

test("visits reads are empty, not failures, for a site with no visits", async () => {
  expect(await run(Storage.use.visitsSummary())).toEqual({
    days: 0,
    firstDate: null,
    lastDate: null,
    source: null,
  })
  expect(await run(Storage.use.visitsHistory())).toEqual([])
  expect((await run(Storage.use.pageVisitsOverview())).latestDate).toBeNull()
  expect(await run(Storage.use.eventWindow())).toEqual([])
  expect(await run(Storage.use.latestVisitsSyncedAt())).toBeNull()
})

// --- brand filtering: every configured brand term, not just the first ------

test("Non-brand and the Opportunity digest rule out every configured brand term", async () => {
  // A Site whose settings list three brand terms: the canonical name, a
  // misspelling, and a product name. A Query matching the second or third term
  // is a Brand query just as much as one matching the first, so it must stay
  // out of Non-brand metrics and must not surface as a new-demand Opportunity.
  const multiBrandSite = {
    ...site,
    brandTerms: ["brandy", "brandi", "zephyr"],
  } satisfies Site
  const brandDir = mkdtempSync(join(tmpdir(), "rp-storage-brand-"))
  const brandRuntime = ManagedRuntime.make(
    Storage.layer.pipe(
      Layer.provide(
        currentSiteLayer(
          brandDir,
          join(brandDir, "search-console.sqlite"),
          multiBrandSite,
        ),
      ),
    ),
  )
  const runBrand = <A, E>(effect: Effect.Effect<A, E, Storage.Service>) =>
    brandRuntime.runPromise(effect)

  try {
    await runBrand(
      Storage.use.saveSnapshots([
        snapshot({ query: "widget", clicks: 5, impressions: 100, position: 8 }),
        // Brand query on the first term.
        snapshot({ query: "brandy", clicks: 30, impressions: 60, position: 1 }),
        // Brand query on the second term — the misspelling.
        snapshot({ query: "brandi shoes", clicks: 20, impressions: 50, position: 2 }),
        // Brand query on the third term — the product name.
        snapshot({ query: "zephyr case review", clicks: 10, impressions: 40, position: 3 }),
      ]),
    )

    // topQueries defaults to Non-brand: only the one genuinely non-brand Query
    // survives, while includeBrand still reports all four.
    const nonBrand = await runBrand(Storage.use.topQueries())
    expect(nonBrand.rows.map((row) => row.query)).toEqual(["widget"])
    const allQueries = await runBrand(Storage.use.topQueries({ includeBrand: true }))
    expect(allQueries.rows.map((row) => row.query).sort()).toEqual([
      "brandi shoes",
      "brandy",
      "widget",
      "zephyr case review",
    ])

    // Non-brand impressions count the non-brand Query alone; all-queries counts
    // every stored row. Filtering on the first term only would have left the
    // misspelling and the product name in the non-brand figure (100 + 90).
    const overview = await runBrand(Storage.use.pagesWindowOverview())
    const page = overview.rows.find(
      (candidate) => candidate.page === "https://example.com/widgets",
    )
    expect(page?.nonBrand.current.impressions).toBe(100)
    expect(page?.nonBrand.current.clicks).toBe(5)
    expect(page?.allQueries.current.impressions).toBe(250)

    // No Brand query reaches the digest, so none of them can be read as
    // new-demand. The non-brand Query still does, which proves the filter
    // narrows rather than blanks the window.
    const digest = await runBrand(Storage.use.opportunityDigest([]))
    const newDemand = digest.signals.filter((signal) => signal.kind === "new-demand")
    expect(newDemand.map((signal) => signal.query)).toEqual(["widget"])
    expect(digest.signals.map((signal) => signal.query)).not.toContain("brandi shoes")
    expect(digest.signals.map((signal) => signal.query)).not.toContain(
      "zephyr case review",
    )
  } finally {
    await brandRuntime.dispose()
    rmSync(brandDir, { recursive: true, force: true })
  }
})

test("a Site with no brand terms filters no Query out of Non-brand", async () => {
  // The empty-list case: with nothing configured as a brand term, every Query
  // is Non-brand. The filter must pass everything rather than nothing.
  const noBrandSite = { ...site, brandTerms: [] } satisfies Site
  const noBrandDir = mkdtempSync(join(tmpdir(), "rp-storage-no-brand-"))
  const noBrandRuntime = ManagedRuntime.make(
    Storage.layer.pipe(
      Layer.provide(
        currentSiteLayer(
          noBrandDir,
          join(noBrandDir, "search-console.sqlite"),
          noBrandSite,
        ),
      ),
    ),
  )

  try {
    await noBrandRuntime.runPromise(
      Storage.use.saveSnapshots([
        snapshot({ query: "widget", impressions: 100 }),
        snapshot({ query: "brandy", impressions: 60 }),
      ]),
    )
    const rows = await noBrandRuntime.runPromise(Storage.use.topQueries())
    expect(rows.rows.map((row) => row.query).sort()).toEqual(["brandy", "widget"])
  } finally {
    await noBrandRuntime.dispose()
    rmSync(noBrandDir, { recursive: true, force: true })
  }
})

// --- Operator queries: out of Opportunity detection, still in the metrics ---

// Observed twice on the shadertown site, with real impressions. Search Console
// reports a site: search as an ordinary Query row.
const operatorQuery = "(shadertown.com) (site:sleevy.app or site:www.shadertown.com)"

test("the observed Operator query does not become a new-demand Opportunity", async () => {
  await run(
    Storage.use.saveSnapshots([
      snapshot({ query: "widget", clicks: 5, impressions: 100, position: 8 }),
      snapshot({ query: operatorQuery, clicks: 0, impressions: 40, position: 15 }),
    ]),
  )

  // Both rows clear the new-demand floor of 20 impressions and neither has a
  // Registry row, so without the filter the operator expression would be read
  // as fresh demand to plan a page for.
  const digest = await run(Storage.use.opportunityDigest([]))
  const newDemand = digest.signals.filter((signal) => signal.kind === "new-demand")
  expect(newDemand.map((signal) => signal.query)).toEqual(["widget"])
  expect(digest.signals.map((signal) => signal.query)).not.toContain(operatorQuery)
})

test("an Operator query reaches none of the four Opportunity kinds", async () => {
  // "widget frame" and the Operator query carry identical figures on identical
  // pages, so the control proves the fixture really does cross every threshold
  // and the Operator query is absent because it was filtered, not because its
  // numbers were too small. The alpha/beta/gamma rows set the 6-10 position
  // band's CTR benchmark high enough for the ctr kind to fire.
  const widgets = "https://example.com/widgets"
  const frames = "https://example.com/frames"
  await run(
    Storage.use.saveSnapshots([
      snapshot({
        query: "alpha widget",
        page: widgets,
        clicks: 10,
        impressions: 100,
        position: 7,
      }),
      snapshot({
        query: "beta widget",
        page: widgets,
        clicks: 12,
        impressions: 100,
        position: 8,
      }),
      snapshot({
        query: "gamma widget",
        page: widgets,
        clicks: 11,
        impressions: 100,
        position: 9,
      }),
      snapshot({
        query: "widget frame",
        page: widgets,
        clicks: 1,
        impressions: 60,
        position: 6,
      }),
      snapshot({
        query: "widget frame",
        page: frames,
        clicks: 1,
        impressions: 60,
        position: 6,
      }),
      snapshot({
        query: operatorQuery,
        page: widgets,
        clicks: 1,
        impressions: 60,
        position: 6,
      }),
      snapshot({
        query: operatorQuery,
        page: frames,
        clicks: 1,
        impressions: 60,
        position: 6,
      }),
    ]),
  )

  const digest = await run(Storage.use.opportunityDigest([]))
  const kindsOf = (query: string) =>
    [
      ...new Set(
        digest.signals
          .filter((signal) => signal.query === query)
          .map((signal) => signal.kind),
      ),
    ].sort()

  expect(kindsOf("widget frame")).toEqual([
    "cannibalization",
    "ctr",
    "new-demand",
    "striking-distance",
  ])
  expect(kindsOf(operatorQuery)).toEqual([])
  // Nor may it ride along as another signal's label.
  expect(digest.signals.map((signal) => signal.label)).not.toContain(operatorQuery)
})

test("all-queries and non-brand totals are unchanged by the Operator query filter", async () => {
  await run(
    Storage.use.saveSnapshots([
      snapshot({ query: "widget", clicks: 5, impressions: 100, position: 8 }),
      snapshot({ query: operatorQuery, clicks: 0, impressions: 40, position: 15 }),
    ]),
  )

  // all-queries is a mechanical sum over the stored per-query rows, and
  // non-brand is that sum with Brand queries taken out. Neither drops an
  // Operator query, so both still count all 140 impressions.
  const overview = await run(Storage.use.pagesWindowOverview())
  const page = overview.rows.find(
    (candidate) => candidate.page === "https://example.com/widgets",
  )
  expect(page?.allQueries.current.impressions).toBe(140)
  expect(page?.nonBrand.current.impressions).toBe(140)

  const between = await run(
    Storage.use.metricsBetween("/widgets", "2024-01-10", "2024-01-10", true),
  )
  expect(between.impressions).toBe(140)

  // And the Query list still shows the row Search Console reported.
  const listed = await run(Storage.use.topQueries({ includeBrand: true }))
  expect(listed.rows.map((row) => row.query)).toContain(operatorQuery)
})

test("natural Queries survive the Operator query filter, colons included", async () => {
  // A colon alone is not an operator: a natural phrase may hold one, a Query
  // may be a pasted URL, and "opposite:" holds the letters "site:" without
  // starting the token. "define:" is left off the token list on purpose.
  const natural = [
    "widget frame",
    "sleevy: the sleeve tool",
    "define:widget",
    "https://example.com/widgets",
    "opposite: which widget to buy",
    "widget site plan",
  ]
  await run(
    Storage.use.saveSnapshots([
      ...natural.map((query) =>
        snapshot({ query, clicks: 0, impressions: 40, position: 15 }),
      ),
      snapshot({ query: operatorQuery, clicks: 0, impressions: 40, position: 15 }),
    ]),
  )

  const digest = await run(Storage.use.opportunityDigest([]))
  const newDemand = digest.signals
    .filter((signal) => signal.kind === "new-demand")
    .map((signal) => signal.query)
    .sort()
  expect(newDemand).toEqual([...natural].sort())
})

test("isOperatorQuery matches the listed tokens and nothing else", () => {
  for (const query of [
    "site:example.com",
    "SITE:Example.com",
    operatorQuery,
    "-site:example.com",
    "inurl:widgets",
    "intitle:widget review",
    "intext:widget",
    "allintitle:widget review",
    "allinurl:widgets",
    "allintext:widget",
    "cache:example.com",
    "related:example.com",
    "filetype:pdf widget guide",
  ])
    expect(Storage.isOperatorQuery(query)).toBe(true)

  for (const query of [
    "widget frame",
    "define:widget",
    "before:2024 widget",
    "after:2024 widget",
    "https://example.com/widgets",
    "opposite: which widget to buy",
    "widget site plan",
    "on site widget repair",
    "sleevy: the sleeve tool",
  ])
    expect(Storage.isOperatorQuery(query)).toBe(false)
})

test("Keyword metrics round-trip through the store, monthly searches included", async () => {
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      {
        keyword: "wow mount tracker",
        locationCode: 2840,
        languageCode: "en",
        searchVolume: 480,
        difficulty: 17,
        costPerClick: 1.25,
        competition: 0.42,
        intent: "informational",
        monthlySearches: [
          { year: 2026, month: 8, searchVolume: 480 },
          { year: 2026, month: 7, searchVolume: 390 },
        ],
        fetchedAt: "2026-09-08T00:00:00.000Z",
      },
    ]),
  )

  const rows = await runtime.runPromise(Storage.use.keywordMetrics(2840, "en"))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.searchVolume).toBe(480)
  expect(rows[0]!.difficulty).toBe(17)
  expect(rows[0]!.costPerClick).toBe(1.25)
  expect(rows[0]!.competition).toBe(0.42)
  expect(rows[0]!.intent).toBe("informational")
  // The scalar read does NOT carry the series. DataForSEO sends about 94 months
  // a keyword and the Opportunity digest reads every row on every dashboard
  // load, so decoding it here would parse megabytes nothing asked for.
  expect(rows[0]).not.toHaveProperty("monthlySearches")

  // It is stored, and read by the call that wants it.
  const series = await runtime.runPromise(
    Storage.use.keywordMonthlySearches(2840, "en"),
  )
  expect(series.get("wow mount tracker")).toEqual([
    { year: 2026, month: 8, searchVolume: 480 },
    { year: 2026, month: 7, searchVolume: 390 },
  ])
})

test("a long monthly series survives the round trip whole", async () => {
  // The live vendor returns about 94 months, not the twelve the comments here
  // used to claim — every other test runs against fakes that returned two,
  // because that is what they were written to return. This one holds the real
  // shape, so a future truncation on the way in cannot pass unnoticed.
  // The exact span the live call returned: 94 months, newest first, from
  // 2026-07 back to 2018-10. It does not start on a year boundary, which is why
  // it touches nine calendar years.
  const months = Array.from({ length: 94 }, (_, index) => {
    const monthsBack = 7 - 1 - index
    return {
      year: 2026 + Math.floor(monthsBack / 12),
      month: ((((monthsBack % 12) + 12) % 12) + 1),
      searchVolume: 1_000 + index,
    }
  })
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      {
        keyword: "seo tools",
        locationCode: 2840,
        languageCode: "en",
        searchVolume: 110_000,
        difficulty: 66,
        costPerClick: 18.4,
        competition: 0.02,
        intent: "commercial",
        monthlySearches: months,
        fetchedAt: "2026-09-08T00:00:00.000Z",
      },
    ]),
  )

  const series = await runtime.runPromise(
    Storage.use.keywordMonthlySearches(2840, "en"),
  )
  expect(series.get("seo tools")).toHaveLength(94)
  expect(series.get("seo tools")?.[0]).toEqual({
    year: 2026,
    month: 7,
    searchVolume: 1_000,
  })
  expect(series.get("seo tools")?.at(-1)).toEqual({
    year: 2018,
    month: 10,
    searchVolume: 1_093,
  })
  // Eight years is the point: trend is unanswerable without it, and the
  // headline volume is only the newest twelve months averaged.
  expect(
    new Set(series.get("seo tools")?.map((month) => month.year)).size,
  ).toBe(9)
})

test("a Keyword metric is keyed by Market, so a second Market is a second row", async () => {
  const shared = {
    keyword: "kado",
    searchVolume: 100,
    difficulty: 5,
    costPerClick: null,
    competition: null,
    intent: null,
    monthlySearches: [],
    fetchedAt: "2026-09-08T00:00:00.000Z",
  }
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      { ...shared, locationCode: 2528, languageCode: "nl" },
      { ...shared, locationCode: 2056, languageCode: "nl", searchVolume: 40 },
    ]),
  )

  // A site that changes Market keeps both answers and reads only the one it is
  // in, so switching back does not have to be paid for twice.
  expect(
    (await runtime.runPromise(Storage.use.keywordMetrics(2528, "nl")))[0]!.searchVolume,
  ).toBe(100)
  expect(
    (await runtime.runPromise(Storage.use.keywordMetrics(2056, "nl")))[0]!.searchVolume,
  ).toBe(40)
  // And a Market nobody has asked about yet simply has no rows.
  expect(await runtime.runPromise(Storage.use.keywordMetrics(2840, "en"))).toEqual([])
})

test("a second answer for the same Keyword replaces the first", async () => {
  const shared = {
    keyword: "wow mount tracker",
    locationCode: 2840,
    languageCode: "en",
    difficulty: null,
    costPerClick: null,
    competition: null,
    intent: null,
    monthlySearches: [],
  }
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      { ...shared, searchVolume: 100, fetchedAt: "2026-08-01T00:00:00.000Z" },
    ]),
  )
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      { ...shared, searchVolume: 480, fetchedAt: "2026-09-08T00:00:00.000Z" },
    ]),
  )

  // This is a cache, not a ledger: search volume is an average of the newest
  // twelve months, so the older row is stale rather than historical and must
  // not survive beside the new one.
  const rows = await runtime.runPromise(Storage.use.keywordMetrics(2840, "en"))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.searchVolume).toBe(480)
  expect(rows[0]!.fetchedAt).toBe("2026-09-08T00:00:00.000Z")
})

test("an absent vendor number stays null rather than becoming a zero", async () => {
  // A Google-Ads Market reports no difficulty and no intent, and a keyword too
  // rare to report has no volume. "Nobody searches this" and "we were not
  // told" lead to opposite decisions about a Keyword, so they must not collapse
  // into the same stored value.
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      {
        keyword: "obscure long tail thing",
        locationCode: 2020,
        languageCode: "ca",
        searchVolume: null,
        difficulty: null,
        costPerClick: null,
        competition: null,
        intent: null,
        monthlySearches: [],
        fetchedAt: "2026-09-08T00:00:00.000Z",
      },
    ]),
  )

  const rows = await runtime.runPromise(Storage.use.keywordMetrics(2020, "ca"))
  expect(rows[0]!.searchVolume).toBeNull()
  expect(rows[0]!.difficulty).toBeNull()
  expect(rows[0]!.competition).toBeNull()
  expect(rows[0]!.intent).toBeNull()
  const series = await runtime.runPromise(
    Storage.use.keywordMonthlySearches(2020, "ca"),
  )
  expect(series.get("obscure long tail thing")).toEqual([])
})

test("an unreadable monthly-searches value costs the series, not the volume", async () => {
  // The column is written by this domain and always holds a JSON array, so a
  // value that cannot be parsed is a hand-edited or truncated row. The honest
  // answer for it is "no history", not a failed read of the volume beside it.
  await runtime.runPromise(
    Storage.use.saveKeywordMetrics([
      {
        keyword: "wow mount tracker",
        locationCode: 2840,
        languageCode: "en",
        searchVolume: 480,
        difficulty: 17,
        costPerClick: null,
        competition: null,
        intent: null,
        monthlySearches: [],
        fetchedAt: "2026-09-08T00:00:00.000Z",
      },
    ]),
  )
  const db = new Database(dbPath)
  db.run("update keyword_metric set monthly_searches = 'not json'")
  db.close()

  const rows = await runtime.runPromise(Storage.use.keywordMetrics(2840, "en"))
  expect(rows[0]!.searchVolume).toBe(480)
  const series = await runtime.runPromise(
    Storage.use.keywordMonthlySearches(2840, "en"),
  )
  expect(series.get("wow mount tracker")).toEqual([])
})

// --- Opportunity ranking by demand ------------------------------------------

// A Site in one Market, so the digest has somewhere to look up volume.
const marketSite = {
  ...site,
  market: {
    locationCode: 2840,
    languageCode: "en",
    label: "United States",
    provider: "labs" as const,
  },
} satisfies Site

// Two striking-distance rows that rank in the opposite order under the two
// weightings. `deep term` sits on the second page, where almost nobody looks,
// so it draws few impressions however much demand is behind it. `shallow term`
// sits at position 5 and catches most of its own small demand.
const strikingRows = [
  snapshot({ query: "deep term", clicks: 0, impressions: 25, position: 18 }),
  snapshot({ query: "shallow term", clicks: 5, impressions: 200, position: 5 }),
]

const withMarketStorage = async <A>(
  fn: (
    run: <B, E>(effect: Effect.Effect<B, E, Storage.Service>) => Promise<B>,
  ) => Promise<A>,
): Promise<A> => {
  const ownDir = mkdtempSync(join(tmpdir(), "rp-storage-market-"))
  const own = ManagedRuntime.make(
    Storage.layer.pipe(
      Layer.provide(
        currentSiteLayer(ownDir, join(ownDir, "search-console.sqlite"), marketSite),
      ),
    ),
  )
  try {
    return await fn((effect) => own.runPromise(effect))
  } finally {
    await own.dispose()
    rmSync(ownDir, { recursive: true, force: true })
  }
}

const metric = (keyword: string, searchVolume: number | null) => ({
  keyword,
  locationCode: 2840,
  languageCode: "en",
  searchVolume,
  difficulty: 22,
  costPerClick: null,
  competition: null,
  intent: "informational",
  monthlySearches: [],
  fetchedAt: "2026-09-08T00:00:00.000Z",
})

test("without Keyword metrics, striking-distance still ranks by impressions", () =>
  withMarketStorage(async (run) => {
    // The behaviour before any volume is fetched, and the behaviour a site with
    // no DataForSEO key keeps: `shallow term` wins on its 200 impressions even
    // though it is the smaller prize.
    await run(Storage.use.saveSnapshots(strikingRows))
    const digest = await run(Storage.use.opportunityDigest([]))
    const striking = digest.signals.filter(
      (signal) => signal.kind === "striking-distance",
    )
    expect(striking.map((signal) => signal.query)).toEqual([
      "shallow term",
      "deep term",
    ])
    // And no signal claims a demand it does not have.
    expect(striking[0]!.demand).toBeUndefined()
  }))

test("search volume promotes the under-observed striking-distance term", () =>
  withMarketStorage(async (run) => {
    await run(Storage.use.saveSnapshots(strikingRows))
    await run(
      Storage.use.saveKeywordMetrics([
        // Real demand, buried at position 18.
        metric("deep term", 10_000),
        // A small term the site already catches most of.
        metric("shallow term", 250),
      ]),
    )

    const digest = await run(Storage.use.opportunityDigest([]))
    const striking = digest.signals.filter(
      (signal) => signal.kind === "striking-distance",
    )
    // The order is reversed: this is the defect the weighting exists to fix.
    expect(striking.map((signal) => signal.query)).toEqual([
      "deep term",
      "shallow term",
    ])
    // 10,000 demand at position 18 → 10,000 × (21 − 18).
    expect(striking[0]!.score).toBe(30_000)
    // The metric travels with the signal, difficulty included, so a reader can
    // weigh it against the site's Domain Rating.
    expect(striking[0]!.demand).toEqual({
      searchVolume: 10_000,
      difficulty: 22,
      intent: "informational",
    })
  }))

test("learning a volume never demotes a well-observed term", () =>
  withMarketStorage(async (run) => {
    // Volume is scoped to one Market while impressions are counted worldwide,
    // so a site can honestly draw more impressions than its Market's volume.
    // The larger of the two is taken, which makes fetching a keyword's volume
    // a strictly promoting change: it can raise an under-observed term but
    // cannot bury a well-observed one.
    await run(Storage.use.saveSnapshots(strikingRows))
    const before = await run(Storage.use.opportunityDigest([]))
    const scoreBefore = before.signals.find(
      (signal) => signal.query === "shallow term" && signal.kind === "striking-distance",
    )!.score

    await run(Storage.use.saveKeywordMetrics([metric("shallow term", 3)]))

    const after = await run(Storage.use.opportunityDigest([]))
    const signal = after.signals.find(
      (candidate) =>
        candidate.query === "shallow term" && candidate.kind === "striking-distance",
    )!
    expect(signal.score).toBe(scoreBefore)
    // The metric is still reported — the volume is simply not what ranks it.
    expect(signal.demand?.searchVolume).toBe(3)
  }))

test("a Query with no stored metric keeps its impression-only score", () =>
  withMarketStorage(async (run) => {
    // A partially-fetched store must not distort the terms it does not cover.
    await run(Storage.use.saveSnapshots(strikingRows))
    await run(Storage.use.saveKeywordMetrics([metric("deep term", 10_000)]))

    const digest = await run(Storage.use.opportunityDigest([]))
    const shallow = digest.signals.find(
      (signal) => signal.query === "shallow term" && signal.kind === "striking-distance",
    )!
    expect(shallow.score).toBe(200 * (21 - 5))
    expect(shallow.demand).toBeUndefined()
  }))

test("a null search volume is not read as no demand", () =>
  withMarketStorage(async (run) => {
    // DataForSEO answers null when a term is too rare to report, which is not
    // the same as zero searches. A null must leave the impression weighting
    // alone rather than zeroing the score.
    await run(Storage.use.saveSnapshots(strikingRows))
    await run(Storage.use.saveKeywordMetrics([metric("deep term", null)]))

    const digest = await run(Storage.use.opportunityDigest([]))
    const deep = digest.signals.find(
      (signal) => signal.query === "deep term" && signal.kind === "striking-distance",
    )!
    expect(deep.score).toBe(25 * (21 - 18))
    expect(deep.demand?.searchVolume).toBeNull()
  }))

test("a CTR Opportunity stays weighted by impressions", () =>
  withMarketStorage(async (run) => {
    // This kind estimates clicks lost on appearances the site already has, and
    // every row in it ranks in the top ten — so the observed impressions are
    // the right number and volume must not touch the score.
    await run(
      Storage.use.saveSnapshots([
        // Three top-ten rows set the band benchmark, and the fourth
        // under-performs it.
        snapshot({ query: "band one", page: "https://example.com/a", clicks: 20, impressions: 100, position: 2 }),
        snapshot({ query: "band two", page: "https://example.com/b", clicks: 22, impressions: 100, position: 2 }),
        snapshot({ query: "band three", page: "https://example.com/c", clicks: 18, impressions: 100, position: 3 }),
        snapshot({ query: "laggard", page: "https://example.com/d", clicks: 2, impressions: 100, position: 2 }),
      ]),
    )
    const before = await run(Storage.use.opportunityDigest([]))
    const scoreBefore = before.signals.find(
      (signal) => signal.kind === "ctr" && signal.query === "laggard",
    )!.score

    await run(Storage.use.saveKeywordMetrics([metric("laggard", 50_000)]))

    const after = await run(Storage.use.opportunityDigest([]))
    const ctr = after.signals.find(
      (signal) => signal.kind === "ctr" && signal.query === "laggard",
    )!
    expect(ctr.score).toBe(scoreBefore)
    // It still carries the metric, so a reader sees the demand behind it.
    expect(ctr.demand?.searchVolume).toBe(50_000)
  }))

test("new-demand and cannibalization are weighted by demand too", () =>
  withMarketStorage(async (run) => {
    await run(
      Storage.use.saveSnapshots([
        // One phrase split across two pages: a cannibalization signal.
        snapshot({ query: "split term", page: "https://example.com/a", clicks: 1, impressions: 30, position: 9 }),
        snapshot({ query: "split term", page: "https://example.com/b", clicks: 1, impressions: 30, position: 12 }),
      ]),
    )
    await run(Storage.use.saveKeywordMetrics([metric("split term", 5_000)]))

    const digest = await run(Storage.use.opportunityDigest([]))
    // Nothing in the Registry, so the phrase is new demand as well.
    const newDemand = digest.signals.find((signal) => signal.kind === "new-demand")!
    expect(newDemand.score).toBe(5_000)
    expect(newDemand.demand?.searchVolume).toBe(5_000)
    // Two pages splitting a high-demand term is a worse problem than two pages
    // splitting a rare one: 5,000 × 2 pages.
    const cannibalization = digest.signals.find(
      (signal) => signal.kind === "cannibalization",
    )!
    expect(cannibalization.score).toBe(10_000)
  }))

test("a Site with no Market reads no metrics and scores as it always did", async () => {
  // The `site` fixture has no market. A Keyword metric written under some other
  // Market must not leak into its digest.
  await runtime.runPromise(Storage.use.saveSnapshots(strikingRows))
  await runtime.runPromise(Storage.use.saveKeywordMetrics([metric("deep term", 10_000)]))

  const digest = await runtime.runPromise(Storage.use.opportunityDigest([]))
  const striking = digest.signals.filter(
    (signal) => signal.kind === "striking-distance",
  )
  expect(striking.map((signal) => signal.query)).toEqual([
    "shallow term",
    "deep term",
  ])
  expect(striking[0]!.demand).toBeUndefined()
})

test("keyword proposals round-trip, ordered by demand", async () => {
  const proposal = (keyword: string, volume: number | null) => ({
    keyword,
    seed: "mount tracker",
    source: "suggestions" as const,
    locationCode: 2840,
    languageCode: "en",
    searchVolume: volume,
    difficulty: 20,
    costPerClick: 0.8,
    competition: 0.3,
    intent: "informational",
    status: "proposed" as const,
    discoveredAt: "2026-09-08T00:00:00.000Z",
  })

  await run(
    Storage.use.saveKeywordProposals([
      proposal("mount tracker app", 90),
      proposal("mount tracker addon", 480),
      // Another Market: keyed separately, and never read by this one.
      { ...proposal("bergwandelen", 300), locationCode: 2528, languageCode: "nl" },
    ]),
  )

  const rows = await run(Storage.use.keywordProposals(2840, "en"))
  // Strongest demand first, which is the order a reader reads.
  expect(rows.map((row) => row.keyword)).toEqual([
    "mount tracker addon",
    "mount tracker app",
  ])
  expect(rows[0]).toEqual(proposal("mount tracker addon", 480))
})

test("a dismissal survives the same keyword being discovered again", async () => {
  // The one thing this table must not do: a run that finds a keyword the
  // reader has already set aside must not put it back in front of them, and a
  // run is the thing most likely to find it again.
  const proposal = {
    keyword: "mount tracker app",
    seed: "mount tracker",
    source: "suggestions" as const,
    locationCode: 2840,
    languageCode: "en",
    searchVolume: 90,
    difficulty: 20,
    costPerClick: 0.8,
    competition: 0.3,
    intent: "informational",
    status: "proposed" as const,
    discoveredAt: "2026-09-08T00:00:00.000Z",
  }

  await run(Storage.use.saveKeywordProposals([proposal]))
  expect(await run(Storage.use.dismissKeywordProposals(["mount tracker app"], 2840, "en"))).toBe(1)

  // Found again a month later, with a fresher number.
  await run(
    Storage.use.saveKeywordProposals([
      { ...proposal, searchVolume: 140, discoveredAt: "2026-10-08T00:00:00.000Z" },
    ]),
  )

  const rows = await run(Storage.use.keywordProposals(2840, "en"))
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe("dismissed")
  // The rest of the row did update: the reader's decision is preserved, not the
  // vendor's stale numbers.
  expect(rows[0]!.searchVolume).toBe(140)
})

test("dismissing counts rows changed, not keywords named", async () => {
  await run(
    Storage.use.saveKeywordProposals([
      {
        keyword: "mount tracker app",
        seed: "mount tracker",
        source: "suggestions" as const,
        locationCode: 2840,
        languageCode: "en",
        searchVolume: 90,
        difficulty: null,
        costPerClick: null,
        competition: null,
        intent: null,
        status: "proposed" as const,
        discoveredAt: "2026-09-08T00:00:00.000Z",
      },
    ]),
  )

  // One known keyword, one never proposed, and then the same one twice.
  expect(
    await run(
      Storage.use.dismissKeywordProposals(["mount tracker app", "never seen"], 2840, "en"),
    ),
  ).toBe(1)
  expect(
    await run(Storage.use.dismissKeywordProposals(["mount tracker app"], 2840, "en")),
  ).toBe(0)
})
