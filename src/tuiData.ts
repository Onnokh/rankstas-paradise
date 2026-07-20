// Data-acquisition seam for the TUI (decision A1 in ADR 0001). The renderer in
// tui.ts reads everything it draws from an in-memory TuiData snapshot; this
// module is the only place that knows WHERE that snapshot comes from. Two
// implementations sit behind loadTuiData: a LOCAL one that reads SQLite/CSV
// directly (today's behaviour, unchanged) and a REMOTE one that fetches the
// same views over HTTP via the bearer'd apiClient. Pure presentation helpers
// (sparkline, labels, phaseFor, formatting) stay in tui.ts — only the fetching
// moves here.
//
// The snapshot is loaded up front (per site, on reload/switch) rather than
// per-view because the render loop is synchronous and reads across views on
// every keypress; a bundle keeps the remote round-trips out of the hot path.
import { createApiClient } from "./apiClient.ts"
import { loadRegistry, type RegistryEntry } from "./registry.ts"
import { logFeed, recentActions, type LogFeedEntry } from "./service.ts"
import { withSite, type Site } from "./site.ts"
import { loadCachedSitemapPages, unmappedSitemapPages, type SitemapPage } from "./sitemap.ts"
import {
  finalizationCutoff,
  historyWithPending,
  opportunityDigest,
  registryTargetProgress,
  snapshotSummary,
  targetPerformance,
  type HistoryDay,
  type LogEntry,
  type Metrics,
  type OpportunityDigest,
  type OpportunitySignal,
  type RegistryPerformance,
  type RegistryTargetProgress,
} from "./storage.ts"

// The exact shape the renderer consumes. Every field is what a TUI view draws;
// `performance` is a function because the registry detail needs a target's day
// series lazily (local reads SQLite on demand, remote serves a pre-fetched map).
export type TuiData = {
  readonly summary: { readonly rows: number; readonly dates: number }
  readonly registry: readonly RegistryEntry[]
  readonly sitemapGaps: readonly SitemapPage[]
  readonly sitemapPageCount: number
  readonly digest: OpportunityDigest
  readonly registryTargets: readonly RegistryTargetProgress[]
  readonly logEntries: readonly LogFeedEntry[]
  readonly history: readonly HistoryDay[]
  readonly recentActions: readonly LogEntry[]
  readonly performance: (targetUrl: string, inventoryOnly: boolean) => RegistryPerformance
}

const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

// LOCAL — the direct storage/registry/sitemap reads the TUI used before A1,
// gathered inside the site's context so every SQLite/CSV read hits the right
// site. Behaviour is identical to the old inline calls.
const localTuiData = (site: Site): Promise<TuiData> => withSite(site, async (): Promise<TuiData> => {
  const registry = await loadRegistry()
  const sitemapPages = await loadCachedSitemapPages()
  const logEntries = await logFeed()
  return {
    summary: snapshotSummary(),
    registry,
    sitemapGaps: unmappedSitemapPages(sitemapPages, registry),
    sitemapPageCount: sitemapPages.length,
    digest: opportunityDigest(registry),
    registryTargets: registryTargetProgress(registry),
    logEntries,
    history: historyWithPending(),
    recentActions: recentActions(3),
    // Re-enter the site context so a later (post-await) render reads the right
    // database regardless of the render loop's own withSite wrapping.
    performance: (targetUrl, inventoryOnly) => withSite(site, () => targetPerformance(targetUrl, inventoryOnly)),
  }
})

// REMOTE — the same views assembled from the HTTP reports. The service reports
// are lossier than the raw storage shapes, so a few fields are reconstructed or
// approximated (see the notes at each site and the ticket's gap list).
const remoteTuiData = async (site: Site): Promise<TuiData> => {
  const api = createApiClient()
  const [status, opportunities, registryReport, logReport, historyData] = await Promise.all([
    api.status(site.id),
    api.opportunities(undefined, site.id),
    api.registry(site.id),
    api.log(undefined, site.id),
    api.history(28, site.id),
  ])

  // Reports carry paths; the renderer builds `new URL(...)` from full URLs.
  const url = (path: string) => `${site.origin}${path}`

  // Rebuild registry rows from the registry report: one row per keyword, or a
  // single inventory-only row. Lossy (cluster/country are defaulted on the
  // inventory case) but carries what the registry and opportunity views read.
  const entriesFor = (target: (typeof registryReport.targets)[number]): RegistryEntry[] =>
    target.keywords.length > 0
      ? target.keywords.map((keyword) => ({
          cluster: keyword.cluster,
          keyword: keyword.keyword,
          targetUrl: target.targetUrl,
          intent: keyword.intent,
          whyOpportunity: target.whyOpportunity ?? "",
          country: keyword.country,
          priority: target.priority ?? "",
          publishedAt: target.publishedAt ?? "",
          baselineDate: target.baselineDate ?? "",
          status: target.status,
        }))
      : [{
          cluster: "Site inventory",
          keyword: "",
          targetUrl: target.targetUrl,
          intent: target.intent,
          whyOpportunity: target.whyOpportunity ?? "",
          country: "USA",
          priority: target.priority ?? "",
          publishedAt: target.publishedAt ?? "",
          baselineDate: target.baselineDate ?? "",
          status: target.status,
        }]

  // The registry report omits a per-target latest date; the site-wide latest
  // (from the opportunities window) stands in — it is the same value locally.
  const latestDate = opportunities.window.currentEnd

  const registryTargets: RegistryTargetProgress[] = registryReport.targets.map((target) => ({
    entries: entriesFor(target),
    targetUrl: target.targetUrl,
    latestDate,
    measuredFrom: target.measuredFrom,
    target: target.window,
    baseline: target.baseline,
    state: target.state,
    indexStatus: target.indexed,
    inspectedAt: target.inspectedAt,
  }))
  const registry: RegistryEntry[] = registryTargets.flatMap((target) => [...target.entries])

  const digest: OpportunityDigest = {
    latestDate,
    currentStart: opportunities.window.currentStart,
    previousStart: opportunities.window.previousStart,
    previousEnd: opportunities.window.previousEnd,
    signals: opportunities.signals.map((signal): OpportunitySignal => ({
      kind: signal.kind,
      // The report drops the display label; it equals the query for every kind
      // the digest emits, so recover it from there.
      label: signal.query ?? "",
      query: signal.query,
      page: url(signal.page),
      pages: signal.pages.map(url),
      current: signal.current,
      previous: signal.previous,
      mapped: signal.mapped,
      recommendation: signal.recommendation,
      score: signal.score,
      ...(signal.launch ? { launch: signal.launch } : {}),
    })),
  }

  const logEntries: LogFeedEntry[] = logReport.actions.map((entry) => ({
    ...entry,
    isAction: entry.kind !== "note",
    // GAP: the API exposes no before/after readout, so remote log detail and the
    // per-target activity glance show entries without a measured window.
    readout: entry.kind === "note" ? { state: "none" } : { state: "unavailable" },
  }))

  // The history report uses finalized query-row days only and carries no
  // provisional flag; recompute the flag from the shared cutoff so fresh days
  // still dim. GAP: totals-only days (site totals without a query breakdown)
  // are absent remotely.
  const cutoff = finalizationCutoff()
  const history: HistoryDay[] = historyData.days.map((day) => ({ ...day, provisional: day.date > cutoff }))

  // Registry detail's trend needs each target's day series, which only the page
  // report exposes. Fetch them all up front so the synchronous render loop can
  // read a target's performance without awaiting.
  const performances = await Promise.all(registryReport.targets.map((target) => api.page(target.targetUrl, site.id)))
  const performanceByUrl = new Map<string, RegistryPerformance>(
    performances.map((report) => [report.path, {
      days: report.performance.days,
      total: report.performance.total,
      last7: report.performance.last7,
      previous7: report.performance.previous7,
    }]),
  )
  const emptyPerformance: RegistryPerformance = { days: [], total: zero, last7: zero, previous7: zero }

  return {
    summary: { rows: status.data.snapshotRows, dates: status.data.syncedDays },
    registry,
    sitemapGaps: status.sitemap.unmapped.map((path) => ({ url: url(path), path, lastModified: null })),
    sitemapPageCount: status.sitemap.pages,
    digest,
    registryTargets,
    logEntries,
    history,
    recentActions: logReport.actions.filter((entry) => entry.kind !== "note").slice(0, 3),
    performance: (targetUrl) => performanceByUrl.get(targetUrl) ?? emptyPerformance,
  }
}

export const loadTuiData = (site: Site, remote: boolean): Promise<TuiData> =>
  remote ? remoteTuiData(site) : localTuiData(site)
