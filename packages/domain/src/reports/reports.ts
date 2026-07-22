// Reports service: report shaping over Storage/Registry/Sitemap. The CLI, HTTP
// server, and TUI are thin shells over this — none of them reach into Storage
// for report shaping themselves. Site-scoped (CurrentSite for origin/brand).
// FROZEN CONTRACT — stub only (methods die).
//
// Pure presentation helpers and shared copy live at the bottom as plain
// exported functions/constants (no service, no site) so both frontends format
// identically.
import { Context, Effect, Layer } from "effect"

import { CurrentSite } from "../sites/current-site.ts"
import { type RegistryPatch } from "../registry/schema.ts"
import { Registry } from "../registry/registry.ts"
import { serviceUse } from "../service-use.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { Storage } from "../storage/storage.ts"
import {
  type ActionKind,
  type LogEntry,
  type LogKind,
  type Metrics,
  type OpportunityKind,
} from "../storage/schema.ts"
import {
  type DashboardSnapshot,
  type EntrySummary,
  type HistoryReport,
  type LogAddInput,
  type LogAddResult,
  type LogFeedEntry,
  type LogListResult,
  type OpportunitiesReport,
  type PageReport,
  type PagesReport,
  type QueriesOptions,
  type QueriesReport,
  type RegistryAddInput,
  type RegistryAddResult,
  type RegistryListReport,
  type RegistrySetResult,
  ReportsError,
  type StatusReport,
  type TidyMetrics,
  type TidyWindow,
} from "./schema.ts"

export interface Interface {
  readonly statusReport: () => Effect.Effect<StatusReport, ReportsError>
  readonly pagesReport: (
    windowDays?: number,
  ) => Effect.Effect<PagesReport, ReportsError>
  readonly pageReport: (
    path: string,
  ) => Effect.Effect<PageReport, ReportsError>
  readonly queriesReport: (
    options?: QueriesOptions,
  ) => Effect.Effect<QueriesReport, ReportsError>
  readonly opportunitiesReport: (
    kind?: string,
  ) => Effect.Effect<OpportunitiesReport, ReportsError>
  readonly registryList: () => Effect.Effect<RegistryListReport, ReportsError>
  readonly registryAdd: (
    input: RegistryAddInput,
  ) => Effect.Effect<RegistryAddResult, ReportsError>
  readonly registrySet: (
    target: string,
    keyword: string | undefined,
    patch: RegistryPatch,
  ) => Effect.Effect<RegistrySetResult, ReportsError>
  readonly logAdd: (
    input: LogAddInput,
  ) => Effect.Effect<LogAddResult, ReportsError>
  readonly logList: (
    path?: string,
  ) => Effect.Effect<LogListResult, ReportsError>
  readonly logFeed: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<LogFeedEntry>, ReportsError>
  readonly recentActions: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, ReportsError>
  readonly historyReport: (
    limit?: number,
  ) => Effect.Effect<HistoryReport, ReportsError>
  readonly dashboardSnapshot: () => Effect.Effect<
    DashboardSnapshot,
    ReportsError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Reports",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Storage.Service
    yield* Registry.Service
    yield* Sitemap.Service
    yield* CurrentSite.Service
    return {
      statusReport: () => Effect.die("unimplemented: Reports.statusReport"),
      pagesReport: () => Effect.die("unimplemented: Reports.pagesReport"),
      pageReport: () => Effect.die("unimplemented: Reports.pageReport"),
      queriesReport: () => Effect.die("unimplemented: Reports.queriesReport"),
      opportunitiesReport: () =>
        Effect.die("unimplemented: Reports.opportunitiesReport"),
      registryList: () => Effect.die("unimplemented: Reports.registryList"),
      registryAdd: () => Effect.die("unimplemented: Reports.registryAdd"),
      registrySet: () => Effect.die("unimplemented: Reports.registrySet"),
      logAdd: () => Effect.die("unimplemented: Reports.logAdd"),
      logList: () => Effect.die("unimplemented: Reports.logList"),
      logFeed: () => Effect.die("unimplemented: Reports.logFeed"),
      recentActions: () => Effect.die("unimplemented: Reports.recentActions"),
      historyReport: () => Effect.die("unimplemented: Reports.historyReport"),
      dashboardSnapshot: () =>
        Effect.die("unimplemented: Reports.dashboardSnapshot"),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(Sitemap.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

// --- pure presentation helpers (no service, no site) ---

// Round a metric's ctr/position for display.
export const tidy = (metrics: Metrics): TidyMetrics => ({
  impressions: metrics.impressions,
  clicks: metrics.clicks,
  ctr: Number(metrics.ctr.toFixed(4)),
  position: Number(metrics.position.toFixed(1)),
})

export const tidyWindow = (window: {
  readonly current: Metrics
  readonly previous: Metrics
}): TidyWindow => ({
  current: tidy(window.current),
  previous: tidy(window.previous),
  deltaImpressions: window.current.impressions - window.previous.impressions,
  deltaClicks: window.current.clicks - window.previous.clicks,
})

// A unicode sparkline for a series; `lowerIsBetter` inverts (e.g. position).
export const sparkline = (
  values: ReadonlyArray<number>,
  lowerIsBetter = false,
): string => {
  const observed = values.filter((value) => value > 0)
  if (observed.length === 0) return "·".repeat(values.length)
  const minimum = Math.min(...observed)
  const maximum = Math.max(...observed)
  const glyphs = "▁▂▃▄▅▆▇█"
  if (minimum === maximum)
    return values.map((value) => (value > 0 ? "─" : "·")).join("")
  return values
    .map((value) => {
      if (value <= 0) return "·"
      const normalized = (value - minimum) / (maximum - minimum)
      const score = lowerIsBetter ? 1 - normalized : normalized
      return glyphs[Math.round(score * (glyphs.length - 1))]!
    })
    .join("")
}

// --- shared presentation copy for the interactive frontends ---

export const opportunityLabels: Record<OpportunityKind, string> = {
  "striking-distance": "Striking distance",
  ctr: "CTR opportunity",
  "new-demand": "New demand",
  cannibalization: "Cannibalization",
}

export const actionKindLabels: Record<ActionKind, string> = {
  publish: "Published",
  "content-update": "Content update",
  "title-change": "Title change",
  "internal-links": "Internal links",
  consolidation: "Consolidation",
}

export const logKindLabel = (kind: LogKind): string =>
  kind === "note" ? "Note" : actionKindLabels[kind]

export const readableIntent = (intent: string): string =>
  (
    {
      comparison: "Comparison / high consideration",
      "product-how-to": "Product / how-to",
      "product-solution": "Product / solution",
      "navigational-product": "Navigational / product",
      "developer-solution": "Developer / solution",
      "product-comparison": "Product comparison",
      exploratory: "Exploratory",
      "site-inventory": "Site inventory",
      "supporting-content": "Supporting content",
    } as Record<string, string>
  )[intent] ??
  intent.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())

// Re-exported for symmetry (a registry entry summarized for display is a pure
// projection; the concrete implementation lands with the service).
export type { EntrySummary }

export * as Reports from "./reports"
