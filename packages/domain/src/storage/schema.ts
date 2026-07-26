// Frozen data shapes and errors for the Storage domain — the per-site SQLite
// ledger of Search Console snapshots, daily totals, baselines, index statuses,
// and the action log. Every report shape the frontends render is rooted here.
// Downstream tickets code against these exact types.
import { Schema } from "effect"

import { RegistryEntry } from "../registry/schema.ts"

// The four Search Console metrics, summed/weighted over some window.
export const Metrics = Schema.Struct({
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "Metrics" })
export interface Metrics extends Schema.Schema.Type<typeof Metrics> {}

// One day of site-wide totals. `provisional` marks a day whose per-query
// breakdown Google has not finalized yet (shown but dimmed by the UI).
export const HistoryDay = Schema.Struct({
  date: Schema.String,
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
  provisional: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "HistoryDay" })
export interface HistoryDay extends Schema.Schema.Type<typeof HistoryDay> {}

// A single query/page row aggregated over a window (internal analysis shape).
export const Opportunity = Schema.Struct({
  query: Schema.String,
  page: Schema.String,
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "Opportunity" })
export interface Opportunity extends Schema.Schema.Type<typeof Opportunity> {}

export const opportunityKinds = [
  "striking-distance",
  "ctr",
  "new-demand",
  "cannibalization",
] as const
export const OpportunityKind = Schema.Literals(opportunityKinds)
export type OpportunityKind = typeof OpportunityKind.Type

export const OpportunitySignal = Schema.Struct({
  kind: OpportunityKind,
  label: Schema.String,
  query: Schema.NullOr(Schema.String),
  page: Schema.String,
  pages: Schema.Array(Schema.String),
  current: Metrics,
  previous: Schema.NullOr(Metrics),
  mapped: Schema.Boolean,
  recommendation: Schema.String,
  score: Schema.Number,
  launch: Schema.optional(
    Schema.Struct({
      daysSinceLaunch: Schema.Number,
      day28: Metrics,
      day56: Metrics,
      day84: Metrics,
    }),
  ),
}).annotate({ identifier: "OpportunitySignal" })
export interface OpportunitySignal
  extends Schema.Schema.Type<typeof OpportunitySignal> {}

export const OpportunityDigest = Schema.Struct({
  latestDate: Schema.NullOr(Schema.String),
  currentStart: Schema.NullOr(Schema.String),
  previousStart: Schema.NullOr(Schema.String),
  previousEnd: Schema.NullOr(Schema.String),
  signals: Schema.Array(OpportunitySignal),
}).annotate({ identifier: "OpportunityDigest" })
export interface OpportunityDigest
  extends Schema.Schema.Type<typeof OpportunityDigest> {}

export const progressStates = [
  "awaiting-data",
  "awaiting-post-baseline",
  "measuring",
] as const
export const ProgressState = Schema.Literals(progressStates)
export type ProgressState = typeof ProgressState.Type

export const indexStatuses = ["indexed", "not-indexed", "unknown"] as const
export const IndexStatus = Schema.Literals(indexStatuses)
export type IndexStatus = typeof IndexStatus.Type

export const RegistryProgress = Schema.Struct({
  entry: RegistryEntry,
  latestDate: Schema.NullOr(Schema.String),
  measuredFrom: Schema.NullOr(Schema.String),
  target: Metrics,
  keyword: Metrics,
  baseline: Schema.NullOr(Metrics),
  state: ProgressState,
}).annotate({ identifier: "RegistryProgress" })
export interface RegistryProgress
  extends Schema.Schema.Type<typeof RegistryProgress> {}

// Registry progress grouped by target URL (dropping the per-entry `entry`/
// `keyword` fields, adding the entry list and the target's index status).
export const RegistryTargetProgress = Schema.Struct({
  entries: Schema.Array(RegistryEntry),
  targetUrl: Schema.String,
  latestDate: Schema.NullOr(Schema.String),
  measuredFrom: Schema.NullOr(Schema.String),
  target: Metrics,
  baseline: Schema.NullOr(Metrics),
  state: ProgressState,
  indexStatus: IndexStatus,
  coverageState: Schema.NullOr(Schema.String),
  inspectedAt: Schema.NullOr(Schema.String),
  bingInIndex: Schema.NullOr(Schema.Boolean),
  bingDiscoveredAt: Schema.NullOr(Schema.String),
  bingLastCrawledAt: Schema.NullOr(Schema.String),
  bingInspectedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RegistryTargetProgress" })
export interface RegistryTargetProgress
  extends Schema.Schema.Type<typeof RegistryTargetProgress> {}

// One day in a target's 28-day performance series (Metrics + date).
export const RegistryDay = Schema.Struct({
  date: Schema.String,
  impressions: Schema.Number,
  clicks: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "RegistryDay" })
export interface RegistryDay extends Schema.Schema.Type<typeof RegistryDay> {}

export const RegistryPerformance = Schema.Struct({
  days: Schema.Array(RegistryDay),
  total: Metrics,
  last7: Metrics,
  previous7: Metrics,
}).annotate({ identifier: "RegistryPerformance" })
export interface RegistryPerformance
  extends Schema.Schema.Type<typeof RegistryPerformance> {}

const MetricsWindow = Schema.Struct({
  current: Metrics,
  previous: Metrics,
})

export const PageWindowRow = Schema.Struct({
  page: Schema.String,
  // Query-row sums excluding brand queries.
  nonBrand: MetricsWindow,
  // Query-row sums including brand queries (anonymized long tail still excluded).
  allQueries: MetricsWindow,
  // Query-less daily totals — the true numbers — or null when unavailable.
  trueTotals: Schema.NullOr(MetricsWindow),
}).annotate({ identifier: "PageWindowRow" })
export interface PageWindowRow
  extends Schema.Schema.Type<typeof PageWindowRow> {}

export const PagesWindowOverview = Schema.Struct({
  latestDate: Schema.NullOr(Schema.String),
  currentStart: Schema.NullOr(Schema.String),
  previousStart: Schema.NullOr(Schema.String),
  previousEnd: Schema.NullOr(Schema.String),
  totalsCoverage: Schema.Struct({
    siteDays: Schema.Number,
    pageDays: Schema.Number,
  }),
  rows: Schema.Array(PageWindowRow),
}).annotate({ identifier: "PagesWindowOverview" })
export interface PagesWindowOverview
  extends Schema.Schema.Type<typeof PagesWindowOverview> {}

export const QueryWindowRow = Schema.Struct({
  query: Schema.String,
  page: Schema.String,
  current: Metrics,
  previous: Schema.NullOr(Metrics),
}).annotate({ identifier: "QueryWindowRow" })
export interface QueryWindowRow
  extends Schema.Schema.Type<typeof QueryWindowRow> {}

export const TopQueriesOptions = Schema.Struct({
  page: Schema.optional(Schema.String),
  windowDays: Schema.optional(Schema.Number),
  minImpressions: Schema.optional(Schema.Number),
  includeBrand: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "TopQueriesOptions" })
export interface TopQueriesOptions
  extends Schema.Schema.Type<typeof TopQueriesOptions> {}

export const TopQueriesResult = Schema.Struct({
  latestDate: Schema.NullOr(Schema.String),
  currentStart: Schema.NullOr(Schema.String),
  previousStart: Schema.NullOr(Schema.String),
  previousEnd: Schema.NullOr(Schema.String),
  rows: Schema.Array(QueryWindowRow),
}).annotate({ identifier: "TopQueriesResult" })
export interface TopQueriesResult
  extends Schema.Schema.Type<typeof TopQueriesResult> {}

// An Action is a concrete change to a page; a Note is a free-form annotation
// (not a change). Both live in the same log, distinguished by kind. Note is a
// LogKind, not an ActionKind.
export const actionKinds = [
  "publish",
  "content-update",
  "title-change",
  "internal-links",
  "consolidation",
] as const
export const ActionKind = Schema.Literals(actionKinds)
export type ActionKind = typeof ActionKind.Type

export const logKinds = [...actionKinds, "note"] as const
export const LogKind = Schema.Literals(logKinds)
export type LogKind = typeof LogKind.Type

export const LogEntry = Schema.Struct({
  id: Schema.Number,
  date: Schema.String,
  path: Schema.String,
  kind: LogKind,
  note: Schema.String,
  createdAt: Schema.String,
}).annotate({ identifier: "LogEntry" })
export interface LogEntry extends Schema.Schema.Type<typeof LogEntry> {}

// The fields required to append a log entry (id/createdAt are assigned by the store).
export const LogEntryInput = Schema.Struct({
  date: Schema.String,
  path: Schema.String,
  kind: LogKind,
  note: Schema.String,
}).annotate({ identifier: "LogEntryInput" })
export interface LogEntryInput
  extends Schema.Schema.Type<typeof LogEntryInput> {}

export const SnapshotSummary = Schema.Struct({
  rows: Schema.Number,
  dates: Schema.Number,
}).annotate({ identifier: "SnapshotSummary" })
export interface SnapshotSummary
  extends Schema.Schema.Type<typeof SnapshotSummary> {}

export const SnapshotDateRange = Schema.Struct({
  first: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SnapshotDateRange" })
export interface SnapshotDateRange
  extends Schema.Schema.Type<typeof SnapshotDateRange> {}

export const BaselineCapture = Schema.Struct({
  targets: Schema.Number,
  windowStart: Schema.String,
  windowEnd: Schema.String,
}).annotate({ identifier: "BaselineCapture" })
export interface BaselineCapture
  extends Schema.Schema.Type<typeof BaselineCapture> {}

// Raised for any failure reading from or writing to the per-site database.
export class StorageError extends Schema.TaggedErrorClass<StorageError>()(
  "StorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as StorageSchema from "./schema"
