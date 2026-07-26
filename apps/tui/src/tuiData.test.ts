// Headless smoke test for the data seam: prove that the home-view payload is
// assembled from a mocked `ApiClient` (no server, no SQLite, no network) exactly
// as the renderer expects. The mock returns a fully-typed DashboardSnapshot;
// `toTuiData` performs the one transform the renderer relies on (`performances`
// array → `performance(targetUrl)` lookup).
import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"

import { ApiClient } from "@rp/api-client/client"
import { DashboardSnapshot } from "@rp/api-client/schema"

import { toTuiData } from "./tuiData.ts"

const zero = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

// A minimal but schema-valid home payload: one striking-distance signal, one
// registry target with a performance series, one log entry.
const snapshot = Schema.decodeUnknownSync(DashboardSnapshot)({
  summary: { rows: 42, dates: 7 },
  registry: [
    {
      cluster: "core",
      keyword: "widget guide",
      targetUrl: "/guide",
      intent: "product-how-to",
      whyOpportunity: "ranks close to the first page",
      country: "us",
      priority: "high",
      publishedAt: "2026-01-01",
      baselineDate: "2026-01-08",
      status: "live",
    },
  ],
  sitemapGaps: [],
  sitemapPageCount: 3,
  digest: {
    latestDate: "2026-07-20",
    currentStart: "2026-06-22",
    previousStart: "2026-05-25",
    previousEnd: "2026-06-21",
    signals: [
      {
        kind: "striking-distance",
        label: "widget guide",
        query: "widget guide",
        page: "https://example.com/guide",
        pages: ["https://example.com/guide"],
        current: { impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 },
        previous: null,
        mapped: true,
        recommendation: "improve the page",
        score: 87,
      },
    ],
  },
  registryTargets: [
    {
      entries: [
        {
          cluster: "core",
          keyword: "widget guide",
          targetUrl: "/guide",
          intent: "product-how-to",
          whyOpportunity: "",
          country: "us",
          priority: "high",
          publishedAt: "2026-01-01",
          baselineDate: "2026-01-08",
          status: "live",
        },
      ],
      targetUrl: "/guide",
      latestDate: "2026-07-20",
      measuredFrom: "2026-01-08",
      target: { impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 },
      baseline: null,
      state: "measuring",
      indexStatus: "indexed",
      coverageState: "Submitted and indexed",
      inspectedAt: "2026-07-19",
    },
  ],
  logEntries: [
    {
      id: 1,
      date: "2026-07-01",
      path: "/guide",
      kind: "publish",
      note: "shipped",
      createdAt: "2026-07-01T00:00:00.000Z",
      isAction: true,
      readout: { state: "unavailable" },
    },
  ],
  history: [{ date: "2026-07-20", impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 }],
  recentActions: [
    {
      id: 1,
      date: "2026-07-01",
      path: "/guide",
      kind: "publish",
      note: "shipped",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  performances: [
    {
      targetUrl: "/guide",
      performance: {
        days: [{ date: "2026-07-20", impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 }],
        total: { impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 },
        last7: { impressions: 120, clicks: 4, ctr: 0.033, position: 8.2 },
        previous7: zero,
      },
    },
  ],
  engineTotals: {
    google: {
      d28: { impressions: 120, clicks: 4, ctr: 0.033, daysCollected: 28, windowDays: 28 },
      d7: { impressions: 40, clicks: 2, ctr: 0.05, daysCollected: 7, windowDays: 7 },
    },
    bing: {
      d28: { impressions: 70, clicks: 4, ctr: 4 / 70, daysCollected: 8, windowDays: 28 },
      d7: { impressions: 18, clicks: 1, ctr: 1 / 18, daysCollected: 7, windowDays: 7 },
    },
  },
})

const mockLayer = Layer.mock(ApiClient.Service, {
  dashboard: () => Effect.succeed(snapshot),
})

test("tuiData assembles the home payload from a mocked ApiClient", async () => {
  const runtime = ManagedRuntime.make(mockLayer)
  const raw = await runtime.runPromise(ApiClient.use.dashboard())
  const data = toTuiData(raw)

  // Home view reads these directly.
  expect(data.summary.rows).toBe(42)
  expect(data.digest.signals).toHaveLength(1)
  expect(data.digest.signals[0]!.kind).toBe("striking-distance")
  expect(data.registryTargets).toHaveLength(1)
  expect(data.logEntries[0]!.kind).toBe("publish")

  // The array→lookup transform: a mapped target resolves, an unknown one falls
  // back to the empty performance so the renderer never sees undefined.
  expect(data.performance("/guide", false).total.impressions).toBe(120)
  expect(data.performance("/missing", false).days).toEqual([])

  await runtime.dispose()
})
