// Render-shape types for the TUI, derived structurally from the wire contract
// the client decodes (`@rp/api-client/schema`). Deriving them here — instead of
// importing the domain schema — keeps `apps/tui` free of any `@rp/domain`
// dependency: the renderer only ever sees the shapes the server actually sends.
//
// The `DashboardSnapshot` is the whole dashboard model in one read; every list
// the renderer draws is an element of one of its arrays, so each type below is
// just an index into that snapshot (plus `Site` from the catalog response).
import type { DashboardSnapshot, QueriesReport, SitesResponse } from "@rp/api-client/schema"

export type { DashboardSnapshot }

// A fully-resolved site from the server-side catalog. `id` keeps its branded
// `SiteId` so it can be passed straight to the client's `?site=` methods.
export type Site = SitesResponse["sites"][number]
export type SiteId = Site["id"]

export type RegistryEntry = DashboardSnapshot["registry"][number]
export type RegistryTargetProgress = DashboardSnapshot["registryTargets"][number]
export type OpportunitySignal = DashboardSnapshot["digest"]["signals"][number]
export type OpportunityKind = OpportunitySignal["kind"]
export type HistoryDay = DashboardSnapshot["history"][number]
export type LogFeedEntry = DashboardSnapshot["logEntries"][number]
export type LogReadout = LogFeedEntry["readout"]
export type LogEntry = DashboardSnapshot["recentActions"][number]
export type LogKind = LogEntry["kind"]
export type ActionKind = Exclude<LogKind, "note">
export type Metrics = OpportunitySignal["current"]
export type RegistryPerformance =
  DashboardSnapshot["performances"][number]["performance"]
export type EngineTotals = DashboardSnapshot["engineTotals"]
export type EngineWindowTotals = EngineTotals["google"]["d28"]
export type KeywordEngineWindow = DashboardSnapshot["keywordWindows"][number]
export type TidyMetrics = KeywordEngineWindow["google7d"]
export type { QueriesReport }
export type QueriesRow = QueriesReport["queries"][number]
