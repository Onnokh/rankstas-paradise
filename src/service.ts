// Service layer: every read/write operation as a typed function returning
// plain DTOs. The CLI, the HTTP server, and the TUI are thin shells over
// this module — none of them should reach into storage.ts for report
// shaping themselves.
import { appendRegistryEntry, loadRegistry, updateRegistryRows, type RegistryEntry, type RegistryPatch } from "./registry.ts"
import { loadCachedSitemapPages, unmappedSitemapPages, type SitemapPage } from "./sitemap.ts"
import {
  actionKinds,
  addLogEntry,
  dateDaysBefore,
  history,
  historyWithPending,
  latestSnapshotDate,
  listLog,
  logKinds,
  metricsBetween,
  opportunityDigest,
  pagesWindowOverview,
  registryTargetProgress,
  snapshotDateRange,
  snapshotSummary,
  targetPerformance,
  topQueries,
  type ActionKind,
  type HistoryDay,
  type LogEntry,
  type LogKind,
  type Metrics,
  type OpportunityDigest,
  type OpportunityKind,
  type OpportunitySignal,
  type PageWindowRow,
  type RegistryPerformance,
  type RegistryTargetProgress,
} from "./storage.ts"
import { currentBrandTerms, currentSiteOrigin } from "./site.ts"

export const siteOrigin = "https://sleevy.app"

export const tidy = (metrics: Metrics) => ({
  impressions: metrics.impressions,
  clicks: metrics.clicks,
  ctr: Number(metrics.ctr.toFixed(4)),
  position: Number(metrics.position.toFixed(1)),
})

export const tidyWindow = (window: { readonly current: Metrics; readonly previous: Metrics }) => ({
  current: tidy(window.current),
  previous: tidy(window.previous),
  deltaImpressions: window.current.impressions - window.previous.impressions,
  deltaClicks: window.current.clicks - window.previous.clicks,
})

export const pathOf = (page: string, origin = currentSiteOrigin()) => page.startsWith(origin) ? new URL(page).pathname : page

export const phaseFor = (progress: RegistryTargetProgress) => {
  const keywordCount = progress.entries.filter((entry) => entry.keyword.trim()).length
  if (keywordCount === 0) return "PAGE"
  if (progress.target.impressions > 0) return "LIVE"
  if (progress.state === "measuring") return "NONE"
  if (progress.state === "awaiting-post-baseline") return "PRE"
  return "NEW"
}

export const entrySummary = (entry: RegistryEntry) => ({
  keyword: entry.keyword,
  cluster: entry.cluster,
  intent: entry.intent,
  country: entry.country,
  priority: entry.priority,
  publishedAt: entry.publishedAt || null,
  baselineDate: entry.baselineDate || null,
  status: entry.status,
  whyOpportunity: entry.whyOpportunity,
})

export const signalSummary = (signal: OpportunitySignal) => ({
  kind: signal.kind,
  query: signal.query,
  page: pathOf(signal.page),
  pages: signal.pages.map((page) => pathOf(page)),
  mapped: signal.mapped,
  current: tidy(signal.current),
  previous: signal.previous ? tidy(signal.previous) : null,
  recommendation: signal.recommendation,
  score: Math.round(signal.score),
  ...(signal.launch
    ? {
        launch: {
          daysSinceLaunch: signal.launch.daysSinceLaunch,
          day28: tidy(signal.launch.day28),
          day56: tidy(signal.launch.day56),
          day84: tidy(signal.launch.day84),
        },
      }
    : {}),
})

export type Verdict = {
  readonly verdict: "awaiting-launch" | "no-visibility" | "needs-optimization" | "needs-attention" | "new-visibility" | "improving" | "declining" | "steady"
  readonly reasons: readonly string[]
}

export const verdictFor = (
  phase: string,
  metrics: { readonly current: Metrics; readonly previous: Metrics },
  signals: readonly OpportunitySignal[],
): Verdict => {
  const reasons: string[] = []
  for (const signal of signals) {
    if (signal.kind === "striking-distance") reasons.push(`"${signal.query}" ranks at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions — within striking distance of the top results.`)
    if (signal.kind === "ctr") reasons.push(`"${signal.query}" ranks in the top 10 but earns fewer clicks than comparable results (${(signal.current.ctr * 100).toFixed(1)}% CTR).`)
    if (signal.kind === "cannibalization") reasons.push(`"${signal.query}" is split across ${signal.pages.length} pages: ${signal.pages.map((page) => pathOf(page)).join(", ")}.`)
  }
  if (phase === "PRE") return { verdict: "awaiting-launch", reasons: ["Published or baseline date is in the future of the available data; waiting for post-launch observations.", ...reasons] }
  const { current, previous } = metrics
  if (current.impressions === 0 && previous.impressions === 0) return { verdict: "no-visibility", reasons: ["No impressions in the current or previous window.", ...reasons] }
  if (signals.some((signal) => signal.kind === "striking-distance" || signal.kind === "ctr")) return { verdict: "needs-optimization", reasons }
  if (signals.some((signal) => signal.kind === "cannibalization")) return { verdict: "needs-attention", reasons }
  if (previous.impressions === 0) return { verdict: "new-visibility", reasons: [`First impressions appeared in the current window (${current.impressions}).`, ...reasons] }
  const change = (current.impressions - previous.impressions) / previous.impressions
  if (change >= 0.2) return { verdict: "improving", reasons: [`Impressions up ${(change * 100).toFixed(0)}% versus the previous window.`, ...reasons] }
  if (change <= -0.2) return { verdict: "declining", reasons: [`Impressions down ${(Math.abs(change) * 100).toFixed(0)}% versus the previous window.`, ...reasons] }
  return { verdict: "steady", reasons: [`Impressions within ±20% of the previous window (${previous.impressions} → ${current.impressions}).`, ...reasons] }
}

export const isBrandQuery = (query: string) => currentBrandTerms().some((term) => query.toLowerCase().includes(term.toLowerCase()))

// Shared presentation copy for the interactive frontends (TUI, native app).
export const opportunityLabels: Record<OpportunityKind, string> = {
  "striking-distance": "Striking distance",
  ctr: "CTR opportunity",
  "new-demand": "New demand",
  cannibalization: "Cannibalization",
}

export const shortAction: Record<OpportunityKind, string> = {
  "striking-distance": "Improve the existing ranking page first: strengthen intent match, content depth, and internal links before creating a new page.",
  ctr: "Test the title and description against the query intent; keep the page focused if its ranking is already strong.",
  "new-demand": "Check existing pages first. Map the keyword only when the intent fits; create a page only when no current page fits.",
  cannibalization: "Choose one primary page, then consolidate, redirect, or clarify the competing pages and their internal links.",
}

export const signalMeaning: Record<OpportunityKind, string> = {
  "striking-distance": "Current 28-day query row: 20+ impressions, position 4–20, and CTR under 10%. Brand queries are excluded.",
  ctr: "Current 28-day query row: 50+ impressions, position 1–10, and CTR below 80% of its benchmark. The benchmark is the same-band median when 3+ comparable rows exist; otherwise it is the site median.",
  "new-demand": "After grouping current 28-day rows by query: 20+ impressions and no exact case-insensitive registry keyword match. Brand queries are excluded.",
  cannibalization: "After grouping current 28-day rows by query: the query has rows for 2+ different page URLs. Brand queries are excluded.",
}

export const signalExplanation: Record<OpportunityKind, string> = {
  "striking-distance": "This page is already visible and close to the first page. Improving the page may produce more traffic faster than publishing a new page.",
  ctr: "This page already ranks well, but its search result earns fewer clicks than similar results. The title, description, or intent match may need work.",
  "new-demand": "People are searching for a phrase your plan does not cover. First decide whether an existing page satisfies that intent; only then create a new mapping or page.",
  cannibalization: "Google is dividing one query between multiple pages on this site. That can weaken both pages because neither has a clear primary target.",
}

export const signalReason = (signal: OpportunitySignal) => {
  const ctr = `${(signal.current.ctr * 100).toFixed(1)}%`
  if (signal.kind === "striking-distance") return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions and a ${ctr} CTR. It is visible, but there is room to earn more clicks.`
  if (signal.kind === "ctr") return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions, but its ${ctr} CTR is below the expected rate for this ranking range.`
  if (signal.kind === "new-demand") return `“${signal.label}” generated ${signal.current.impressions} impressions, but it is not mapped to a keyword in the selected site's registry.`
  if (signal.kind === "cannibalization") return `“${signal.label}” is receiving impressions for ${signal.pages.length} pages: ${signal.pages.map((page) => pathOf(page)).join(", ")}.`
  return `“${signal.label}” matched the selected opportunity rule based on its current Search Console performance.`
}

export const readableIntent = (intent: string) => ({
  comparison: "Comparison / high consideration",
  "product-how-to": "Product / how-to",
  "product-solution": "Product / solution",
  "navigational-product": "Navigational / product",
  "developer-solution": "Developer / solution",
  "product-comparison": "Product comparison",
  exploratory: "Exploratory",
  "site-inventory": "Site inventory",
  "supporting-content": "Supporting content",
})[intent] ?? intent.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())

export const statusReport = async () => {
  const registry = await loadRegistry()
  const sitemapPages = await loadCachedSitemapPages()
  const summary = snapshotSummary()
  const range = snapshotDateRange()
  const overview = pagesWindowOverview()
  const keywords = registry.filter((entry) => entry.keyword.trim())
  return {
    data: {
      firstDate: range.first,
      lastDate: range.last,
      syncedDays: summary.dates,
      snapshotRows: summary.rows,
      dailyTotalsDays: overview.totalsCoverage.siteDays,
      note: "Snapshot rows exclude anonymized long-tail queries; daily totals are the true numbers.",
    },
    registry: {
      targets: new Set(registry.map((entry) => entry.targetUrl)).size,
      keywords: keywords.length,
      clusters: new Set(keywords.map((entry) => entry.cluster)).size,
    },
    sitemap: {
      pages: sitemapPages.length,
      unmapped: unmappedSitemapPages(sitemapPages, registry).map((page) => page.path),
    },
    actions: listLog().length,
  }
}

export const pagesReport = async (windowDays = 28) => {
  const registry = await loadRegistry()
  const overview = pagesWindowOverview(windowDays)
  const digest = opportunityDigest(registry)
  const targets = new Map(registryTargetProgress(registry).map((progress) => [progress.targetUrl, progress]))
  const paths = [...new Set([...overview.rows.map((row) => pathOf(row.page)), ...targets.keys()])]
  const overviewByPath = new Map(overview.rows.map((row) => [pathOf(row.page), row]))
  const pages = paths.map((path) => {
    const row: PageWindowRow | undefined = overviewByPath.get(path)
    const progress = targets.get(path)
    const entries = progress?.entries ?? []
    const keywordEntries = entries.filter((entry) => entry.keyword.trim())
    const phase = progress ? phaseFor(progress) : "UNMAPPED"
    const pageSignals = digest.signals.filter((signal) => signal.pages.some((page) => pathOf(page) === path))
    const judged = keywordEntries.length > 0 ? row?.nonBrand : row?.allQueries
    const verdict = verdictFor(phase, judged ?? { current: { impressions: 0, clicks: 0, ctr: 0, position: 0 }, previous: { impressions: 0, clicks: 0, ctr: 0, position: 0 } }, pageSignals)
    const first = entries[0]
    return {
      path,
      mapped: entries.length > 0,
      phase,
      priority: first?.priority ?? null,
      intent: first?.intent ?? null,
      clusters: [...new Set(keywordEntries.map((entry) => entry.cluster))],
      keywords: keywordEntries.map((entry) => entry.keyword),
      publishedAt: first?.publishedAt || null,
      status: first?.status ?? null,
      indexed: progress?.indexStatus ?? "unknown",
      whyOpportunity: first?.whyOpportunity || null,
      nonBrand: row ? tidyWindow(row.nonBrand) : null,
      allQueries: row ? tidyWindow(row.allQueries) : null,
      trueTotals: row?.trueTotals ? tidyWindow(row.trueTotals) : null,
      baseline: progress?.baseline ? tidy(progress.baseline) : null,
      signals: pageSignals.map((signal) => signal.kind),
      ...verdict,
    }
  }).sort((left, right) => (right.allQueries?.current.impressions ?? 0) - (left.allQueries?.current.impressions ?? 0))
  return {
    window: { days: windowDays, currentStart: overview.currentStart, currentEnd: overview.latestDate, previousStart: overview.previousStart, previousEnd: overview.previousEnd },
    note: "nonBrand/allQueries come from stored query rows (anonymized long tail excluded); trueTotals come from query-less daily totals and are the real numbers. Keyword targets are judged on nonBrand, inventory pages on allQueries.",
    pages,
  }
}

export const pageReport = async (path: string) => {
  if (!path.startsWith("/")) throw new Error(`Page path must start with "/", got: ${path}`)
  const registry = await loadRegistry()
  const entries = registry.filter((entry) => entry.targetUrl === path)
  const keywordEntries = entries.filter((entry) => entry.keyword.trim())
  const inventoryOnly = entries.length > 0 && keywordEntries.length === 0
  const progress = registryTargetProgress(registry).find((target) => target.targetUrl === path)
  const performance = targetPerformance(path, inventoryOnly || entries.length === 0)
  const digest = opportunityDigest(registry)
  const pageSignals = digest.signals.filter((signal) => signal.pages.some((page) => pathOf(page) === path))
  const overviewRow = pagesWindowOverview().rows.find((row) => pathOf(row.page) === path)
  const queries = topQueries({ page: `${currentSiteOrigin()}${path}`, includeBrand: true, limit: 25 })
  const phase = progress ? phaseFor(progress) : "UNMAPPED"
  const judged = keywordEntries.length > 0 ? overviewRow?.nonBrand : overviewRow?.allQueries
  const verdict = verdictFor(phase, judged ?? { current: performance.total, previous: { impressions: 0, clicks: 0, ctr: 0, position: 0 } }, pageSignals)
  return {
    path,
    mapped: entries.length > 0,
    phase,
    state: progress?.state ?? null,
    indexed: progress?.indexStatus ?? "unknown",
    inspectedAt: progress?.inspectedAt ?? null,
    measuredFrom: progress?.measuredFrom ?? null,
    plan: entries.map(entrySummary),
    ...verdict,
    performance: {
      windowStart: performance.days[0]?.date ?? null,
      windowEnd: performance.days.at(-1)?.date ?? null,
      scope: inventoryOnly || entries.length === 0 ? "all-queries" : "non-brand",
      total: tidy(performance.total),
      last7: tidy(performance.last7),
      previous7: tidy(performance.previous7),
      days: performance.days.map((day) => ({ date: day.date, ...tidy(day) })),
    },
    trueTotals: overviewRow?.trueTotals ? tidyWindow(overviewRow.trueTotals) : null,
    baseline: progress?.baseline ? tidy(progress.baseline) : null,
    topQueries: queries.rows.map((row) => ({
      query: row.query,
      brand: isBrandQuery(row.query),
      mapped: registry.some((entry) => entry.keyword.toLowerCase() === row.query.toLowerCase()),
      current: tidy(row.current),
      previous: row.previous ? tidy(row.previous) : null,
    })),
    signals: pageSignals.map(signalSummary),
    actions: listLog(path),
  }
}

export type QueriesOptions = {
  readonly page?: string
  readonly windowDays?: number
  readonly minImpressions?: number
  readonly includeBrand?: boolean
  readonly limit?: number
}

export const queriesReport = async (options: QueriesOptions = {}) => {
  const registry = await loadRegistry()
  const result = topQueries({
    page: options.page ? `${currentSiteOrigin()}${options.page}` : undefined,
    windowDays: options.windowDays ?? 28,
    minImpressions: options.minImpressions ?? 0,
    includeBrand: options.includeBrand === true,
    limit: options.limit ?? 50,
  })
  const keywordTargets = new Map(registry.filter((entry) => entry.keyword.trim()).map((entry) => [entry.keyword.toLowerCase(), entry.targetUrl]))
  return {
    window: { currentStart: result.currentStart, currentEnd: result.latestDate, previousStart: result.previousStart, previousEnd: result.previousEnd },
    queries: result.rows.map((row) => ({
      query: row.query,
      page: pathOf(row.page),
      brand: isBrandQuery(row.query),
      mappedTarget: keywordTargets.get(row.query.toLowerCase()) ?? null,
      current: tidy(row.current),
      previous: row.previous ? tidy(row.previous) : null,
    })),
  }
}

export const opportunitiesReport = async (kind?: string) => {
  const registry = await loadRegistry()
  const digest = opportunityDigest(registry)
  const signals = digest.signals.filter((signal) => !kind || signal.kind === kind)
  const registryForSignal = (signal: OpportunitySignal) => {
    const byKeyword = signal.query ? registry.find((entry) => entry.keyword.toLowerCase() === signal.query!.toLowerCase()) : undefined
    return byKeyword ?? registry.find((entry) => entry.targetUrl === pathOf(signal.page))
  }
  return {
    window: { currentStart: digest.currentStart, currentEnd: digest.latestDate, previousStart: digest.previousStart, previousEnd: digest.previousEnd },
    signals: signals.map((signal) => {
      const mapping = registryForSignal(signal)
      return {
        ...signalSummary(signal),
        registry: mapping ? { targetUrl: mapping.targetUrl, priority: mapping.priority, intent: mapping.intent, cluster: mapping.cluster } : null,
      }
    }),
  }
}

export const registryList = async () => {
  const registry = await loadRegistry()
  const targets = registryTargetProgress(registry)
  return {
    targets: targets.map((progress) => {
      const first = progress.entries[0]!
      return {
        targetUrl: progress.targetUrl,
        phase: phaseFor(progress),
        state: progress.state,
        indexed: progress.indexStatus,
        inspectedAt: progress.inspectedAt,
        priority: first.priority || null,
        intent: first.intent,
        publishedAt: first.publishedAt || null,
        baselineDate: first.baselineDate || null,
        status: first.status,
        whyOpportunity: first.whyOpportunity || null,
        measuredFrom: progress.measuredFrom,
        window: tidy(progress.target),
        baseline: progress.baseline ? tidy(progress.baseline) : null,
        keywords: progress.entries.filter((entry) => entry.keyword.trim()).map((entry) => ({
          keyword: entry.keyword,
          cluster: entry.cluster,
          intent: entry.intent,
          country: entry.country,
        })),
      }
    }),
  }
}

export type RegistryAddInput = {
  readonly target: string
  readonly keyword?: string
  readonly cluster?: string
  readonly intent?: string
  readonly priority?: string
  readonly country?: string
  readonly why?: string
  readonly publishedAt?: string
  readonly baselineDate?: string
  readonly status?: string
}

export const registryAdd = async (input: RegistryAddInput) => {
  if (!input.target) throw new Error("registry add requires a target path")
  const keyword = input.keyword ?? ""
  if (keyword && (!input.cluster || !input.intent || !input.priority)) {
    throw new Error("Keyword rows require cluster, intent, and priority.")
  }
  const entry: RegistryEntry = {
    cluster: input.cluster ?? "Site inventory",
    keyword,
    targetUrl: input.target,
    intent: input.intent ?? "site-inventory",
    whyOpportunity: input.why ?? "",
    country: input.country ?? "USA",
    priority: input.priority ?? "",
    publishedAt: input.publishedAt ?? "",
    baselineDate: input.baselineDate ?? "",
    status: input.status ?? (keyword ? "Planned" : "Inventory"),
  }
  await appendRegistryEntry(entry)
  return { added: entrySummary(entry), targetUrl: input.target }
}

export const registrySet = async (target: string, keyword: string | undefined, patch: RegistryPatch) => {
  if (!target) throw new Error("registry set requires a target path")
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new Error("registry set requires at least one field to change")
  }
  const updated = await updateRegistryRows(target, keyword, patch)
  const applied = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  return { targetUrl: target, keyword: keyword ?? null, updatedRows: updated, patch: applied }
}

export type LogAddInput = {
  readonly path: string
  readonly kind: string
  readonly date?: string
  readonly note?: string
}

export const logAdd = (input: LogAddInput) => {
  if (!input.path || !input.path.startsWith("/")) throw new Error("log add requires a path starting with /")
  if (!logKinds.includes(input.kind as LogKind)) throw new Error(`log kind must be one of: ${logKinds.join(", ")}`)
  const date = input.date ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must use YYYY-MM-DD: ${date}`)
  return { logged: addLogEntry({ date, path: input.path, kind: input.kind as LogKind, note: input.note ?? "" }) }
}

export const logList = (path?: string) => ({ actions: listLog(path) })

// Human-readable label per log kind. Notes read as "Note"; actions read as a
// past-tense-ish phrase. Shared by both front-ends so the wording never drifts.
export const actionKindLabels: Record<ActionKind, string> = {
  publish: "Published",
  "content-update": "Content update",
  "title-change": "Title change",
  "internal-links": "Internal links",
  consolidation: "Consolidation",
}

export const logKindLabel = (kind: LogKind): string => kind === "note" ? "Note" : actionKindLabels[kind]

// A log entry's before/after readout: "none" for Notes (not a change), "window"
// for Actions on a mapped target with data, "unavailable" when the target is
// unmapped or no snapshot data brackets the action date. Windows are symmetric
// 28/28 around the action date; the after window shrinks to available data and
// is marked incomplete when fewer than 28 days have finalized since.
export type LogReadout =
  | { readonly state: "none" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "window"
      readonly scope: "non-brand" | "all-queries"
      readonly before: Metrics
      readonly after: Metrics
      readonly afterComplete: boolean
    }

export type LogFeedEntry = LogEntry & { readonly isAction: boolean; readonly readout: LogReadout }

const zeroMetrics: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

const readoutFor = (entry: LogEntry, registry: readonly RegistryEntry[], latestDate: string | null): LogReadout => {
  if (entry.kind === "note") return { state: "none" }
  const matches = registry.filter((mapped) => mapped.targetUrl === entry.path)
  if (matches.length === 0 || !latestDate) return { state: "unavailable" }
  const inventoryOnly = matches.every((mapped) => !mapped.keyword.trim())
  const scope = inventoryOnly ? "all-queries" as const : "non-brand" as const
  const beforeStart = dateDaysBefore(entry.date, 28)
  const beforeEnd = dateDaysBefore(entry.date, 1)
  const afterEndFull = dateDaysBefore(entry.date, -27)
  const afterEnd = afterEndFull <= latestDate ? afterEndFull : latestDate
  const before = metricsBetween(entry.path, beforeStart, beforeEnd, inventoryOnly)
  const after = afterEnd >= entry.date ? metricsBetween(entry.path, entry.date, afterEnd, inventoryOnly) : zeroMetrics
  if (before.impressions === 0 && after.impressions === 0) return { state: "unavailable" }
  return { state: "window", scope, before, after, afterComplete: afterEndFull <= latestDate }
}

const enrichLog = (entries: readonly LogEntry[], registry: readonly RegistryEntry[]): LogFeedEntry[] => {
  const latestDate = latestSnapshotDate()
  return entries.map((entry) => ({ ...entry, isAction: entry.kind !== "note", readout: readoutFor(entry, registry, latestDate) }))
}

// Site-wide log (path omitted) or a single target's log, newest-first, each
// entry enriched with its before/after readout. Both Actions and Notes.
export const logFeed = async (path?: string): Promise<LogFeedEntry[]> => {
  const registry = await loadRegistry()
  return enrichLog(listLog(path), registry)
}

// The latest N Actions (Notes excluded) across the site — the Home glance.
export const recentActions = (limit = 3): LogEntry[] =>
  listLog().filter((entry) => entry.kind !== "note").slice(0, limit)

export const sparkline = (values: readonly number[], lowerIsBetter = false) => {
  const observed = values.filter((value) => value > 0)
  if (observed.length === 0) return "·".repeat(values.length)
  const minimum = Math.min(...observed)
  const maximum = Math.max(...observed)
  const glyphs = "▁▂▃▄▅▆▇█"
  if (minimum === maximum) return values.map((value) => value > 0 ? "─" : "·").join("")
  return values.map((value) => {
    if (value <= 0) return "·"
    const normalized = (value - minimum) / (maximum - minimum)
    const score = lowerIsBetter ? 1 - normalized : normalized
    return glyphs[Math.round(score * (glyphs.length - 1))]!
  }).join("")
}

export const historyReport = (limit = 28) => {
  const days = history(limit)
  return {
    days: days.map((day) => ({ date: day.date, ...tidy(day) })),
  }
}

// Everything the interactive dashboards (TUI, and any JSON UI) draw for one
// site, in a single read. This is the source the TUI's data seam consumes both
// locally (calling this directly) and remotely (fetching /api/dashboard), so a
// remote TUI renders identically to a local one with nothing reconstructed
// client-side (ADR 0001). Unlike the /api/* reports it returns the RAW internal
// shapes (un-tidied metrics, full-URL pages, before/after log readouts, the
// provisional/totals-day history) — the frontends format them; the tidied
// reports stay for CLI/agent consumers. Every field here is JSON-safe.
export type DashboardSnapshot = {
  readonly summary: { readonly rows: number; readonly dates: number }
  readonly registry: readonly RegistryEntry[]
  readonly sitemapGaps: readonly SitemapPage[]
  readonly sitemapPageCount: number
  readonly digest: OpportunityDigest
  readonly registryTargets: readonly RegistryTargetProgress[]
  readonly logEntries: readonly LogFeedEntry[]
  readonly history: readonly HistoryDay[]
  readonly recentActions: readonly LogEntry[]
  // Per-target day series, precomputed for every registry target so a remote
  // client needs no follow-up round-trips. inventoryOnly (all-queries scope)
  // matches the TUI's own rule: the target has no keyword rows.
  readonly performances: readonly { readonly targetUrl: string; readonly performance: RegistryPerformance }[]
}

export const dashboardSnapshot = async (): Promise<DashboardSnapshot> => {
  const registry = await loadRegistry()
  const sitemapPages = await loadCachedSitemapPages()
  const logEntries = await logFeed()
  const registryTargets = registryTargetProgress(registry)
  return {
    summary: snapshotSummary(),
    registry,
    sitemapGaps: unmappedSitemapPages(sitemapPages, registry),
    sitemapPageCount: sitemapPages.length,
    digest: opportunityDigest(registry),
    registryTargets,
    logEntries,
    history: historyWithPending(),
    recentActions: recentActions(3),
    performances: registryTargets.map((target) => ({
      targetUrl: target.targetUrl,
      performance: targetPerformance(target.targetUrl, target.entries.every((entry) => !entry.keyword.trim())),
    })),
  }
}
