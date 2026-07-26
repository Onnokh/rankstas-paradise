// Frozen data shapes for the Reports domain — the DTOs the CLI, HTTP server,
// and TUI render. These mirror the exact return shapes of the legacy service.ts
// and are the contract downstream frontends and the HTTP server code against.
import { Schema } from "effect"

import {
  HistoryDay,
  IndexStatus,
  LogEntry,
  Metrics,
  OpportunityDigest,
  OpportunityKind,
  ProgressState,
  RegistryPerformance,
  RegistryTargetProgress,
} from "../storage/schema.ts"
import { RegistryEntry, RegistryPatch } from "../registry/schema.ts"
import { SitemapPage } from "../sitemap/schema.ts"

// Metrics after `tidy()`: ctr/position rounded for display. Same shape as Metrics.
export const TidyMetrics = Schema.Struct({
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "TidyMetrics" })
export interface TidyMetrics extends Schema.Schema.Type<typeof TidyMetrics> {}

// A current-vs-previous window with the impression/click deltas (tidyWindow()).
export const TidyWindow = Schema.Struct({
  current: TidyMetrics,
  previous: TidyMetrics,
  deltaImpressions: Schema.Number,
  deltaClicks: Schema.Number,
}).annotate({ identifier: "TidyWindow" })
export interface TidyWindow extends Schema.Schema.Type<typeof TidyWindow> {}

// A registry entry summarized for display (entrySummary()).
export const EntrySummary = Schema.Struct({
  keyword: Schema.String,
  cluster: Schema.String,
  intent: Schema.String,
  country: Schema.String,
  priority: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  baselineDate: Schema.NullOr(Schema.String),
  status: Schema.String,
  whyOpportunity: Schema.String,
}).annotate({ identifier: "EntrySummary" })
export interface EntrySummary extends Schema.Schema.Type<typeof EntrySummary> {}

// An opportunity signal summarized for display (signalSummary()).
export const SignalSummary = Schema.Struct({
  kind: OpportunityKind,
  query: Schema.NullOr(Schema.String),
  page: Schema.String,
  pages: Schema.Array(Schema.String),
  mapped: Schema.Boolean,
  current: TidyMetrics,
  previous: Schema.NullOr(TidyMetrics),
  recommendation: Schema.String,
  score: Schema.Number,
  launch: Schema.optional(
    Schema.Struct({
      daysSinceLaunch: Schema.Number,
      day28: TidyMetrics,
      day56: TidyMetrics,
      day84: TidyMetrics,
    }),
  ),
}).annotate({ identifier: "SignalSummary" })
export interface SignalSummary
  extends Schema.Schema.Type<typeof SignalSummary> {}

// --- FROZEN named types called out by the ticket ---

export const verdictKinds = [
  "awaiting-launch",
  "no-visibility",
  "needs-optimization",
  "needs-attention",
  "new-visibility",
  "improving",
  "declining",
  "steady",
] as const
export const Verdict = Schema.Struct({
  verdict: Schema.Literals(verdictKinds),
  reasons: Schema.Array(Schema.String),
}).annotate({ identifier: "Verdict" })
export interface Verdict extends Schema.Schema.Type<typeof Verdict> {}

// A log entry's before/after readout: "none" for Notes, "window" for Actions on
// a mapped target with data, "unavailable" otherwise.
export const LogReadout = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
  Schema.Struct({
    state: Schema.Literal("window"),
    scope: Schema.Literals(["non-brand", "all-queries"]),
    before: Metrics,
    after: Metrics,
    afterComplete: Schema.Boolean,
  }),
]).annotate({ identifier: "LogReadout" })
export type LogReadout = Schema.Schema.Type<typeof LogReadout>

export const LogFeedEntry = Schema.Struct({
  ...LogEntry.fields,
  isAction: Schema.Boolean,
  readout: LogReadout,
}).annotate({ identifier: "LogFeedEntry" })
export interface LogFeedEntry
  extends Schema.Schema.Type<typeof LogFeedEntry> {}

export const QueriesOptions = Schema.Struct({
  page: Schema.optional(Schema.String),
  windowDays: Schema.optional(Schema.Number),
  minImpressions: Schema.optional(Schema.Number),
  includeBrand: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "QueriesOptions" })
export interface QueriesOptions
  extends Schema.Schema.Type<typeof QueriesOptions> {}

export const RegistryAddInput = Schema.Struct({
  target: Schema.String,
  keyword: Schema.optional(Schema.String),
  cluster: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  why: Schema.optional(Schema.String),
  publishedAt: Schema.optional(Schema.String),
  baselineDate: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
}).annotate({ identifier: "RegistryAddInput" })
export interface RegistryAddInput
  extends Schema.Schema.Type<typeof RegistryAddInput> {}

export const LogAddInput = Schema.Struct({
  path: Schema.String,
  // Validated against the LogKind set at runtime; loose string at the boundary.
  kind: Schema.String,
  date: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}).annotate({ identifier: "LogAddInput" })
export interface LogAddInput extends Schema.Schema.Type<typeof LogAddInput> {}

export const EngineWindowTotals = Schema.Struct({
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  daysCollected: Schema.Number,
  windowDays: Schema.Number,
}).annotate({ identifier: "EngineWindowTotals" })
export interface EngineWindowTotals
  extends Schema.Schema.Type<typeof EngineWindowTotals> {}

export const EnginePairTotals = Schema.Struct({
  d28: EngineWindowTotals,
  d7: EngineWindowTotals,
}).annotate({ identifier: "EnginePairTotals" })
export interface EnginePairTotals
  extends Schema.Schema.Type<typeof EnginePairTotals> {}

export const EngineTotals = Schema.Struct({
  google: EnginePairTotals,
  bing: EnginePairTotals,
}).annotate({ identifier: "EngineTotals" })
export interface EngineTotals extends Schema.Schema.Type<typeof EngineTotals> {}

export const KeywordEngineWindow = Schema.Struct({
  keyword: Schema.String,
  targetUrl: Schema.String,
  google7d: TidyMetrics,
  bing7d: Schema.NullOr(TidyMetrics),
}).annotate({ identifier: "KeywordEngineWindow" })
export interface KeywordEngineWindow
  extends Schema.Schema.Type<typeof KeywordEngineWindow> {}

export const DashboardSnapshot = Schema.Struct({
  summary: Schema.Struct({ rows: Schema.Number, dates: Schema.Number }),
  registry: Schema.Array(RegistryEntry),
  sitemapGaps: Schema.Array(SitemapPage),
  sitemapPageCount: Schema.Number,
  digest: OpportunityDigest,
  registryTargets: Schema.Array(RegistryTargetProgress),
  logEntries: Schema.Array(LogFeedEntry),
  history: Schema.Array(HistoryDay),
  recentActions: Schema.Array(LogEntry),
  performances: Schema.Array(
    Schema.Struct({
      targetUrl: Schema.String,
      performance: RegistryPerformance,
    }),
  ),
  engineTotals: EngineTotals,
  keywordWindows: Schema.Array(KeywordEngineWindow),
}).annotate({ identifier: "DashboardSnapshot" })
export interface DashboardSnapshot
  extends Schema.Schema.Type<typeof DashboardSnapshot> {}

// --- report return shapes ---

export const StatusReport = Schema.Struct({
  data: Schema.Struct({
    firstDate: Schema.NullOr(Schema.String),
    lastDate: Schema.NullOr(Schema.String),
    syncedDays: Schema.Number,
    snapshotRows: Schema.Number,
    dailyTotalsDays: Schema.Number,
    note: Schema.String,
  }),
  registry: Schema.Struct({
    targets: Schema.Number,
    keywords: Schema.Number,
    clusters: Schema.Number,
  }),
  sitemap: Schema.Struct({
    pages: Schema.Number,
    unmapped: Schema.Array(Schema.String),
  }),
  actions: Schema.Number,
  bing: Schema.NullOr(
    Schema.Struct({
      firstDate: Schema.NullOr(Schema.String),
      lastDate: Schema.NullOr(Schema.String),
      collectedDays: Schema.Number,
      missingDates: Schema.Array(Schema.String),
      syncedWithinHours: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "StatusReport" })
export interface StatusReport extends Schema.Schema.Type<typeof StatusReport> {}

const ReportWindow = Schema.Struct({
  currentStart: Schema.NullOr(Schema.String),
  currentEnd: Schema.NullOr(Schema.String),
  previousStart: Schema.NullOr(Schema.String),
  previousEnd: Schema.NullOr(Schema.String),
})

export const PageReportRow = Schema.Struct({
  path: Schema.String,
  mapped: Schema.Boolean,
  phase: Schema.String,
  priority: Schema.NullOr(Schema.String),
  intent: Schema.NullOr(Schema.String),
  clusters: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  indexed: IndexStatus,
  whyOpportunity: Schema.NullOr(Schema.String),
  nonBrand: Schema.NullOr(TidyWindow),
  allQueries: Schema.NullOr(TidyWindow),
  trueTotals: Schema.NullOr(TidyWindow),
  baseline: Schema.NullOr(TidyMetrics),
  signals: Schema.Array(OpportunityKind),
  verdict: Verdict.fields.verdict,
  reasons: Verdict.fields.reasons,
}).annotate({ identifier: "PageReportRow" })
export interface PageReportRow
  extends Schema.Schema.Type<typeof PageReportRow> {}

export const PagesReport = Schema.Struct({
  window: Schema.Struct({
    days: Schema.Number,
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  note: Schema.String,
  pages: Schema.Array(PageReportRow),
}).annotate({ identifier: "PagesReport" })
export interface PagesReport extends Schema.Schema.Type<typeof PagesReport> {}

export const PageReport = Schema.Struct({
  path: Schema.String,
  mapped: Schema.Boolean,
  phase: Schema.String,
  state: Schema.NullOr(ProgressState),
  indexed: IndexStatus,
  coverageState: Schema.NullOr(Schema.String),
  inspectedAt: Schema.NullOr(Schema.String),
  bingInIndex: Schema.NullOr(Schema.Boolean),
  bingDiscoveredAt: Schema.NullOr(Schema.String),
  bingLastCrawledAt: Schema.NullOr(Schema.String),
  bingInspectedAt: Schema.NullOr(Schema.String),
  measuredFrom: Schema.NullOr(Schema.String),
  plan: Schema.Array(EntrySummary),
  verdict: Verdict.fields.verdict,
  reasons: Verdict.fields.reasons,
  performance: Schema.Struct({
    windowStart: Schema.NullOr(Schema.String),
    windowEnd: Schema.NullOr(Schema.String),
    scope: Schema.Literals(["all-queries", "non-brand"]),
    total: TidyMetrics,
    last7: TidyMetrics,
    previous7: TidyMetrics,
    days: Schema.Array(
      Schema.Struct({
        date: Schema.String,
        impressions: Schema.Number,
        clicks: Schema.Number,
        ctr: Schema.Number,
        position: Schema.Number,
      }),
    ),
  }),
  trueTotals: Schema.NullOr(TidyWindow),
  baseline: Schema.NullOr(TidyMetrics),
  topQueries: Schema.Array(
    Schema.Struct({
      query: Schema.String,
      brand: Schema.Boolean,
      mapped: Schema.Boolean,
      current: TidyMetrics,
      previous: Schema.NullOr(TidyMetrics),
    }),
  ),
  signals: Schema.Array(SignalSummary),
  actions: Schema.Array(LogEntry),
}).annotate({ identifier: "PageReport" })
export interface PageReport extends Schema.Schema.Type<typeof PageReport> {}

export const QueriesReport = Schema.Struct({
  window: Schema.Struct({
    currentStart: Schema.NullOr(Schema.String),
    currentEnd: Schema.NullOr(Schema.String),
    previousStart: Schema.NullOr(Schema.String),
    previousEnd: Schema.NullOr(Schema.String),
  }),
  queries: Schema.Array(
    Schema.Struct({
      query: Schema.String,
      page: Schema.String,
      brand: Schema.Boolean,
      mappedTarget: Schema.NullOr(Schema.String),
      current: TidyMetrics,
      previous: Schema.NullOr(TidyMetrics),
    }),
  ),
}).annotate({ identifier: "QueriesReport" })
export interface QueriesReport
  extends Schema.Schema.Type<typeof QueriesReport> {}

export const OpportunitiesReport = Schema.Struct({
  window: ReportWindow,
  signals: Schema.Array(
    Schema.Struct({
      ...SignalSummary.fields,
      registry: Schema.NullOr(
        Schema.Struct({
          targetUrl: Schema.String,
          priority: Schema.String,
          intent: Schema.String,
          cluster: Schema.String,
        }),
      ),
    }),
  ),
}).annotate({ identifier: "OpportunitiesReport" })
export interface OpportunitiesReport
  extends Schema.Schema.Type<typeof OpportunitiesReport> {}

export const RegistryListReport = Schema.Struct({
  targets: Schema.Array(
    Schema.Struct({
      targetUrl: Schema.String,
      phase: Schema.String,
      state: ProgressState,
      indexed: IndexStatus,
      coverageState: Schema.NullOr(Schema.String),
      inspectedAt: Schema.NullOr(Schema.String),
      bingInIndex: Schema.NullOr(Schema.Boolean),
      bingDiscoveredAt: Schema.NullOr(Schema.String),
      bingLastCrawledAt: Schema.NullOr(Schema.String),
      bingInspectedAt: Schema.NullOr(Schema.String),
      priority: Schema.NullOr(Schema.String),
      intent: Schema.String,
      publishedAt: Schema.NullOr(Schema.String),
      baselineDate: Schema.NullOr(Schema.String),
      status: Schema.String,
      whyOpportunity: Schema.NullOr(Schema.String),
      measuredFrom: Schema.NullOr(Schema.String),
      window: TidyMetrics,
      baseline: Schema.NullOr(TidyMetrics),
      keywords: Schema.Array(
        Schema.Struct({
          keyword: Schema.String,
          cluster: Schema.String,
          intent: Schema.String,
          country: Schema.String,
          google7d: TidyMetrics,
          bing7d: Schema.NullOr(TidyMetrics),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "RegistryListReport" })
export interface RegistryListReport
  extends Schema.Schema.Type<typeof RegistryListReport> {}

export const RegistryAddResult = Schema.Struct({
  added: EntrySummary,
  targetUrl: Schema.String,
}).annotate({ identifier: "RegistryAddResult" })
export interface RegistryAddResult
  extends Schema.Schema.Type<typeof RegistryAddResult> {}

export const RegistrySetResult = Schema.Struct({
  targetUrl: Schema.String,
  keyword: Schema.NullOr(Schema.String),
  updatedRows: Schema.Number,
  patch: RegistryPatch,
}).annotate({ identifier: "RegistrySetResult" })
export interface RegistrySetResult
  extends Schema.Schema.Type<typeof RegistrySetResult> {}

export const LogAddResult = Schema.Struct({
  logged: LogEntry,
}).annotate({ identifier: "LogAddResult" })
export interface LogAddResult
  extends Schema.Schema.Type<typeof LogAddResult> {}

export const LogListResult = Schema.Struct({
  actions: Schema.Array(LogEntry),
}).annotate({ identifier: "LogListResult" })
export interface LogListResult
  extends Schema.Schema.Type<typeof LogListResult> {}

export const HistoryReport = Schema.Struct({
  days: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      // True daily total from site_daily. `provisional` marks a day Google is
      // still revising (within the finalization window), for UI dimming.
      provisional: Schema.Boolean,
      impressions: Schema.Number,
      clicks: Schema.Number,
      ctr: Schema.Number,
      position: Schema.Number,
    }),
  ),
  engineTotals: EngineTotals,
}).annotate({ identifier: "HistoryReport" })
export interface HistoryReport
  extends Schema.Schema.Type<typeof HistoryReport> {}

// Raised when a report cannot be produced (wraps an underlying Storage /
// Registry / Sitemap failure, or an invalid argument such as a bad path/kind).
export class ReportsError extends Schema.TaggedErrorClass<ReportsError>()(
  "ReportsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as ReportsSchema from "./schema"
