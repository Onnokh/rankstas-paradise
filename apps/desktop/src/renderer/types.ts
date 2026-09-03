// Render-shape types for the desktop renderer, derived structurally from the
// wire contract (`@rp/api-client/schema`) exactly as `apps/tui/src/types.ts`
// does — the renderer only ever sees the shapes the server actually sends, and a
// change to the dashboard contract breaks both front-ends in the same place.
import type { DashboardSnapshot, HistoryReport, SitesResponse } from "@rp/api-client/schema"

export type { DashboardSnapshot }

export type Site = SitesResponse["sites"][number]
export type SiteId = Site["id"]

export type RegistryEntry = DashboardSnapshot["registry"][number]
export type RegistryTargetProgress = DashboardSnapshot["registryTargets"][number]
export type OpportunitySignal = DashboardSnapshot["digest"]["signals"][number]
export type OpportunityKind = OpportunitySignal["kind"]
export type HistoryDay = DashboardSnapshot["history"][number]
// The longer daily series read separately from `/api/history`, so the overview
// can set one period against the one before it. Structurally the same day as
// `HistoryDay`, except `provisional` is always present.
export type TrendDay = HistoryReport["days"][number]
export type LogFeedEntry = DashboardSnapshot["logEntries"][number]
export type LogReadout = LogFeedEntry["readout"]
export type LogEntry = DashboardSnapshot["recentActions"][number]
export type LogKind = LogEntry["kind"]
export type Metrics = OpportunitySignal["current"]
export type RegistryPerformance = DashboardSnapshot["performances"][number]["performance"]

// The exact shape the views consume — the snapshot with `performances` (an
// array over the wire) turned into the lookup the registry detail wants. Same
// transform as `apps/tui/src/tuiData.ts`.
export type Dashboard = Omit<DashboardSnapshot, "performances"> & {
  readonly performance: (targetUrl: string) => RegistryPerformance
}

const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }
const emptyPerformance: RegistryPerformance = {
  days: [],
  total: zero,
  last7: zero,
  previous7: zero,
}

export const toDashboard = (snapshot: DashboardSnapshot): Dashboard => {
  const { performances, ...rest } = snapshot
  const byUrl = new Map(performances.map((entry) => [entry.targetUrl, entry.performance]))
  return { ...rest, performance: (targetUrl) => byUrl.get(targetUrl) ?? emptyPerformance }
}

export type View = "home" | "opportunities" | "history" | "registry" | "log"
export type HomeCategory = OpportunityKind | "sitemap-coverage" | "recent-activity"

export const views: readonly { readonly view: View; readonly label: string }[] = [
  { view: "home", label: "Home" },
  { view: "opportunities", label: "Opportunities" },
  { view: "history", label: "History" },
  { view: "registry", label: "Registry" },
  { view: "log", label: "Log" },
]

export const opportunityKinds: readonly OpportunityKind[] = [
  "striking-distance",
  "ctr",
  "new-demand",
  "cannibalization",
]

export const homeCategories: readonly HomeCategory[] = [
  ...opportunityKinds,
  "sitemap-coverage",
  "recent-activity",
]
