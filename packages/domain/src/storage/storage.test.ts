// Storage service tests: seed a temp-file SQLite database via a test
// CurrentSite layer, then exercise representative reads/writes plus one
// transaction-rollback case. The DDL + backfill run once on layer acquisition.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Exit, Layer, ManagedRuntime } from "effect"

import { CurrentSite } from "../sites/current-site.ts"
import { type Site } from "../sites/schema.ts"
import { type StorageError } from "./schema.ts"
import { Storage } from "./storage.ts"

const site: Site = {
  id: "test" as Site["id"],
  name: "Test",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: ["brandy"],
} satisfies Site

const currentSiteLayer = (dir: string, dbPath: string) =>
  Layer.succeed(CurrentSite.Service, {
    current: () => Effect.succeed(site),
    dataDirectory: () => Effect.succeed(dir),
    databasePath: () => Effect.succeed(dbPath),
    registryPath: () => Effect.succeed(join(dir, "keyword-registry.csv")),
    sitemapPath: () => Effect.succeed(join(dir, "sitemap.json")),
  } satisfies CurrentSite.Interface)

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<Storage.Service, StorageError>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-storage-"))
  const dbPath = join(dir, "search-console.sqlite")
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
  expect(await run(Storage.use.historyWithPending())).toEqual([])
  expect(await run(Storage.use.snapshotDateRange())).toEqual({
    first: null,
    last: null,
  })
  expect(await run(Storage.use.bingSiteDailyDateRange())).toEqual({
    first: null,
    last: null,
    count: 0,
  })
  expect(await run(Storage.use.bingSyncedWithinHours(24))).toBe(false)
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

test("topQueries excludes every configured brand term, not just the first", async () => {
  const multiBrandSite: Site = {
    ...site,
    brandTerms: ["brandy", "acme"],
  }
  const multiBrandDir = mkdtempSync(join(tmpdir(), "rp-storage-multibrand-"))
  const multiBrandDbPath = join(multiBrandDir, "search-console.sqlite")
  const multiBrandRuntime = ManagedRuntime.make(
    Storage.layer.pipe(
      Layer.provide(
        Layer.succeed(CurrentSite.Service, {
          current: () => Effect.succeed(multiBrandSite),
          dataDirectory: () => Effect.succeed(multiBrandDir),
          databasePath: () => Effect.succeed(multiBrandDbPath),
          registryPath: () => Effect.succeed(join(multiBrandDir, "keyword-registry.csv")),
          sitemapPath: () => Effect.succeed(join(multiBrandDir, "sitemap.json")),
        } satisfies CurrentSite.Interface),
      ),
    ),
  )

  try {
    await multiBrandRuntime.runPromise(
      Storage.use.saveSnapshots([
        snapshot({ query: "widget", clicks: 5, impressions: 100, position: 8 }),
        snapshot({
          query: "brandy shoes",
          clicks: 2,
          impressions: 10,
          ctr: 0.2,
          position: 3,
        }),
        snapshot({
          query: "acme widgets",
          clicks: 3,
          impressions: 20,
          ctr: 0.15,
          position: 4,
        }),
      ]),
    )

    const top = await multiBrandRuntime.runPromise(Storage.use.topQueries())
    expect(top.rows.map((row) => row.query)).toEqual(["widget"])
  } finally {
    await multiBrandRuntime.dispose()
    rmSync(multiBrandDir, { recursive: true, force: true })
  }
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
          country: "",
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
        country: "",
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

test("saveBingSiteDaily tracks coverage, freshness, and missing dates", async () => {
  await run(
    Storage.use.saveBingSiteDaily([
      { date: "2024-01-10", clicks: 1, impressions: 10 },
      { date: "2024-01-11", clicks: 2, impressions: 20 },
    ]),
  )
  expect(await run(Storage.use.bingSiteDailyDateRange())).toEqual({
    first: "2024-01-10",
    last: "2024-01-11",
    count: 2,
  })
  expect(
    await run(
      Storage.use.missingBingSiteDailyDates([
        "2024-01-10",
        "2024-01-11",
        "2024-01-12",
      ]),
    ),
  ).toEqual(["2024-01-12"])
  expect(await run(Storage.use.bingSyncedWithinHours(24))).toBe(true)
})

test("saveBingUrlInfos upserts crawl status and respects freshness", async () => {
  await run(
    Storage.use.saveBingUrlInfos([
      {
        targetUrl: "https://example.com/widgets",
        discoveredAt: "2024-03-01",
        lastCrawledAt: "2024-06-15",
        anchorCount: 2,
        documentSize: 2048,
        inIndex: true,
      },
    ]),
  )
  expect(
    await run(
      Storage.use.recentlyInspectedBingUrls(
        ["https://example.com/widgets"],
        24,
      ),
    ),
  ).toEqual(["https://example.com/widgets"])
  await run(
    Storage.use.saveBingUrlInfos([
      {
        targetUrl: "https://example.com/widgets",
        discoveredAt: null,
        lastCrawledAt: null,
        anchorCount: 0,
        documentSize: 0,
        inIndex: false,
      },
    ]),
  )
  const progress = await run(
    Storage.use.registryTargetProgress([
      {
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
      },
    ]),
  )
  expect(progress[0]?.bingInIndex).toBe(false)
  expect(progress[0]?.bingDiscoveredAt).toBeNull()
  expect(await run(Storage.use.pruneBingUrlInfos([]))).toBe(1)
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
