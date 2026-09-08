// Reports service: report shaping over Storage/Registry/Sitemap. The CLI, HTTP
// server, and TUI are thin shells over this — none of them reach into Storage
// for report shaping themselves. Site-scoped (CurrentSite for origin/brand).
//
// Pure presentation helpers and shared copy live at the bottom as plain
// exported functions/constants (no service, no site) so both frontends format
// identically.
import { Context, Effect, Layer } from "effect"

import { Analytics, normaliseHours } from "../analytics/analytics.ts"
import { type AnalyticsError, type AnalyticsStatus } from "../analytics/schema.ts"
import { Revenue } from "../revenue/revenue.ts"
import { type RevenueDay } from "../revenue/schema.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { DomainRating } from "../domain-rating/domain-rating.ts"
import { KeywordDiscovery } from "../keyword-discovery/keyword-discovery.ts"
import { KeywordDiscoveryError } from "../keyword-discovery/schema.ts"
import { KeywordMetrics } from "../keyword-metrics/keyword-metrics.ts"
import {
  foldKeyword,
  type KeywordMetricSummary,
  type MonthlySearch,
} from "../keyword-metrics/schema.ts"
import { type RegistryEntry, type RegistryPatch } from "../registry/schema.ts"
import { type RegistryError } from "../registry/schema.ts"
import { Registry } from "../registry/registry.ts"
import { serviceUse } from "../service-use.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { Storage } from "../storage/storage.ts"
import {
  type ActionKind,
  type LogEntry,
  type LogKind,
  logKinds,
  type Metrics,
  type OpportunityKind,
  type OpportunitySignal,
  type PageVisitsRow,
  type RegistryTargetProgress,
  type StorageError,
  type Visits,
} from "../storage/schema.ts"
import {
  type DashboardSnapshot,
  type DemandReport,
  type EntrySummary,
  type HistoryReport,
  type EventsReport,
  type RevenueReport,
  type RevenueTotals,
  type LiveEventsReport,
  LiveReport,
  type TodayReport,
  type LogAddInput,
  type LogAddResult,
  type LogFeedEntry,
  type LogListResult,
  type LogReadout,
  type OpportunitiesReport,
  type PageReport,
  type PagesReport,
  type QueriesOptions,
  type QueriesReport,
  type RegistryAddInput,
  type RegistryAddResult,
  type KeywordDismissResult,
  type KeywordProposalsReport,
  type RegistryHealthReport,
  type KeywordHealthVerdict,
  type RegistryListReport,
  type RegistrySetResult,
  ReportsError,
  type SignalSummary,
  type StatusReport,
  type TidyMetrics,
  type TidyWindow,
  type Verdict,
  type VisitsWindowReport,
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
    limit?: number,
  ) => Effect.Effect<OpportunitiesReport, ReportsError>
  readonly registryList: () => Effect.Effect<RegistryListReport, ReportsError>
  // The Registry judged on demand: which planned Keywords have searches behind
  // them and which do not. Reads the store only, so a site with no DataForSEO
  // key gets the shape with every row "unmeasured" rather than an error.
  readonly registryHealth: () => Effect.Effect<
    RegistryHealthReport,
    ReportsError
  >
  // Keyword Proposals waiting on a decision. Reads the store only: discovery
  // spends money and is asked for over MCP, so nothing an HTTP read does can
  // start a paid run.
  readonly proposedKeywords: () => Effect.Effect<
    KeywordProposalsReport,
    ReportsError
  >
  // Set Proposals aside. A write, and the only one this feature offers over
  // HTTP — accepting one is `registryAdd`, which already exists and is the same
  // call whether a person or an agent makes it.
  readonly dismissProposals: (
    keywords: ReadonlyArray<string>,
  ) => Effect.Effect<KeywordDismissResult, ReportsError>
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
  // The visitors active right now. Reaches the analytics provider (through a
  // 30-second memo); every other read here is served from the ledger.
  readonly liveReport: () => Effect.Effect<LiveReport, ReportsError>
  // The live feed, newer than `since` when given. Reaches the provider like
  // liveReport, memoised for a few seconds.
  readonly liveEventsReport: (
    since?: string,
  ) => Effect.Effect<LiveEventsReport, ReportsError>
  readonly eventsReport: (
    windowDays?: number,
  ) => Effect.Effect<EventsReport, ReportsError>
  readonly todayReport: () => Effect.Effect<TodayReport, ReportsError>
  // The site's sales over a window against the one before, from the ledger.
  readonly revenueReport: (
    windowDays?: number,
  ) => Effect.Effect<RevenueReport, ReportsError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Reports",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const registry = yield* Registry.Service
    const sitemap = yield* Sitemap.Service
    const domainRatingService = yield* DomainRating.Service
    const keywordMetrics = yield* KeywordMetrics.Service
    const discovery = yield* KeywordDiscovery.Service
    const analytics = yield* Analytics.Service
    const revenue = yield* Revenue.Service
    const site = yield* CurrentSite.Service
    const resolved = yield* site.current()
    const origin = resolved.origin
    const brandTerms = resolved.brandTerms

    // Whether per-page visits mean anything yet. A provider that is configured
    // but has synced nothing shows null, not a column of zeros pretending to be
    // a measurement. Once a day is synced, zeros ARE the measurement: a site
    // whose pages saw nobody still gets rows of zeros, as its Visits total
    // does — the test is a synced day, not a page with visits.
    const hasSyncedVisits = (analyticsStatus: AnalyticsStatus | null) =>
      analyticsStatus
        ? storage.visitsSummary().pipe(Effect.map((summary) => summary.days > 0))
        : Effect.succeed(false)

    // Map the dependencies' typed errors to a ReportsError; the guard failures
    // raised inside the report gens are already ReportsError and pass through.
    const wrap = <A>(
      effect: Effect.Effect<
        A,
        | StorageError
        | RegistryError
        | AnalyticsError
        | ReportsError
        | KeywordDiscoveryError
      >,
    ): Effect.Effect<A, ReportsError> =>
      effect.pipe(
        Effect.catchTags({
          StorageError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
          RegistryError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
          AnalyticsError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
          KeywordDiscoveryError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
        }),
      )

    // A log entry's before/after readout (see LogReadout). Windows are symmetric
    // 28/28 around the action date; the after window shrinks to available data
    // and is marked incomplete when fewer than 28 days have finalized since.
    const readoutFor = (
      entry: LogEntry,
      entries: ReadonlyArray<RegistryEntry>,
      latestDate: string | null,
    ): Effect.Effect<LogReadout, StorageError> =>
      Effect.gen(function* () {
        if (entry.kind === "note") return { state: "none" } as const
        const matches = entries.filter(
          (mapped) => mapped.targetUrl === entry.path,
        )
        if (matches.length === 0 || !latestDate)
          return { state: "unavailable" } as const
        const inventoryOnly = matches.every((mapped) => !mapped.keyword.trim())
        const scope = inventoryOnly
          ? ("all-queries" as const)
          : ("non-brand" as const)
        const beforeStart = dateDaysBefore(entry.date, 28)
        const beforeEnd = dateDaysBefore(entry.date, 1)
        const afterEndFull = dateDaysBefore(entry.date, -27)
        const afterEnd = afterEndFull <= latestDate ? afterEndFull : latestDate
        const before = yield* storage.metricsBetween(
          entry.path,
          beforeStart,
          beforeEnd,
          inventoryOnly,
        )
        const after =
          afterEnd >= entry.date
            ? yield* storage.metricsBetween(
                entry.path,
                entry.date,
                afterEnd,
                inventoryOnly,
              )
            : zeroMetrics
        if (before.impressions === 0 && after.impressions === 0)
          return { state: "unavailable" } as const
        return {
          state: "window",
          scope,
          before,
          after,
          afterComplete: afterEndFull <= latestDate,
        } as const
      })

    const enrichLog = (
      entries: ReadonlyArray<LogEntry>,
      registryEntries: ReadonlyArray<RegistryEntry>,
    ): Effect.Effect<ReadonlyArray<LogFeedEntry>, StorageError> =>
      Effect.gen(function* () {
        const latestDate = yield* storage.latestSnapshotDate()
        return yield* Effect.forEach(entries, (entry) =>
          readoutFor(entry, registryEntries, latestDate).pipe(
            Effect.map((readout) => ({
              ...entry,
              isAction: entry.kind !== "note",
              readout,
            })),
          ),
        )
      })

    return {
      statusReport: () =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const sitemapPages = yield* sitemap.loadCachedSitemapPages()
            const summary = yield* storage.snapshotSummary()
            const range = yield* storage.snapshotDateRange()
            const lastSyncedAt = yield* storage.latestSyncedAt()
            const lastCheckedAt = yield* storage.latestCheckedAt()
            const overview = yield* storage.pagesWindowOverview()
            const unmapped = yield* sitemap.unmappedSitemapPages(
              sitemapPages,
              entries,
            )
            const actions = yield* storage.listLog()
            const keywords = entries.filter((entry) => entry.keyword.trim())
            // Served from the ledger: the provider is never asked on a read.
            const analyticsStatus = yield* analytics.status()
            const visitsSummary = analyticsStatus
              ? yield* storage.visitsSummary()
              : null
            const visitsSyncedAt = analyticsStatus
              ? yield* storage.latestVisitsSyncedAt()
              : null
            const revenueStatus = yield* revenue.status()
            const revenueSummary = revenueStatus
              ? yield* storage.revenueSummary()
              : null
            const revenueSyncedAt = revenueStatus
              ? yield* storage.latestRevenueSyncedAt()
              : null
            return {
              data: {
                firstDate: range.first,
                lastDate: range.last,
                syncedDays: summary.dates,
                snapshotRows: summary.rows,
                dailyTotalsDays: overview.totalsCoverage.siteDays,
                lastSyncedAt,
                lastCheckedAt,
                note: "Snapshot rows exclude anonymized long-tail queries; daily totals are the true numbers.",
              },
              registry: {
                targets: new Set(entries.map((entry) => entry.targetUrl)).size,
                keywords: keywords.length,
                clusters: new Set(keywords.map((entry) => entry.cluster)).size,
              },
              sitemap: {
                pages: sitemapPages.length,
                unmapped: unmapped.map((page) => page.path),
              },
              actions: actions.length,
              analytics:
                analyticsStatus && visitsSummary
                  ? {
                      ...analyticsStatus,
                      days: visitsSummary.days,
                      firstDate: visitsSummary.firstDate,
                      lastDate: visitsSummary.lastDate,
                      lastSyncedAt: visitsSyncedAt,
                    }
                  : null,
              revenue:
                revenueStatus && revenueSummary
                  ? {
                      ...revenueStatus,
                      days: revenueSummary.days,
                      firstDate: revenueSummary.firstDate,
                      lastDate: revenueSummary.lastDate,
                      lastSyncedAt: revenueSyncedAt,
                    }
                  : null,
            }
          }),
        ),

      pagesReport: (windowDays = 28) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const overview = yield* storage.pagesWindowOverview(windowDays)
            // Visits over the SAME two windows, anchored on the Search Console
            // latest date, so clicks and visits on a row describe the same days.
            const analyticsStatus = yield* analytics.status()
            const visitsOverview = analyticsStatus
              ? yield* storage.pageVisitsOverview(
                  windowDays,
                  overview.latestDate ?? undefined,
                )
              : null
            const visitsByPath = new Map(
              (visitsOverview?.rows ?? []).map((row) => [row.page, row]),
            )
            const hasVisits = yield* hasSyncedVisits(analyticsStatus)
            const digest = yield* storage.opportunityDigest(entries)
            const progressList =
              yield* storage.registryTargetProgress(entries)
            const targets = new Map(
              progressList.map((progress) => [progress.targetUrl, progress]),
            )
            const paths = [
              ...new Set([
                ...overview.rows.map((row) => pathOf(row.page, origin)),
                ...targets.keys(),
                ...visitsByPath.keys(),
              ]),
            ]
            const overviewByPath = new Map(
              overview.rows.map((row) => [pathOf(row.page, origin), row]),
            )
            const pages = paths
              .map((path) => {
                const row = overviewByPath.get(path)
                const progress = targets.get(path)
                const targetEntries = progress?.entries ?? []
                const keywordEntries = targetEntries.filter((entry) =>
                  entry.keyword.trim(),
                )
                const phase = progress ? phaseFor(progress) : "UNMAPPED"
                const pageSignals = digest.signals.filter((signal) =>
                  signal.pages.some((page) => pathOf(page, origin) === path),
                )
                const judged =
                  keywordEntries.length > 0 ? row?.nonBrand : row?.allQueries
                const verdict = verdictFor(
                  phase,
                  judged ?? { current: zeroMetrics, previous: zeroMetrics },
                  pageSignals,
                  origin,
                )
                const first = targetEntries[0]
                return {
                  path,
                  mapped: targetEntries.length > 0,
                  phase,
                  priority: first?.priority ?? null,
                  intent: first?.intent ?? null,
                  clusters: [
                    ...new Set(keywordEntries.map((entry) => entry.cluster)),
                  ],
                  keywords: keywordEntries.map((entry) => entry.keyword),
                  publishedAt: first?.publishedAt || null,
                  status: first?.status ?? null,
                  indexed: progress?.indexStatus ?? "unknown",
                  whyOpportunity: first?.whyOpportunity || null,
                  nonBrand: row ? tidyWindow(row.nonBrand) : null,
                  allQueries: row ? tidyWindow(row.allQueries) : null,
                  trueTotals: row?.trueTotals
                    ? tidyWindow(row.trueTotals)
                    : null,
                  baseline: progress?.baseline ? tidy(progress.baseline) : null,
                  signals: pageSignals.map((signal) => signal.kind),
                  ...verdict,
                  visits: hasVisits
                    ? visitsWindow(visitsByPath.get(path))
                    : null,
                }
              })
              .sort(
                (left, right) =>
                  (right.allQueries?.current.impressions ?? 0) -
                  (left.allQueries?.current.impressions ?? 0),
              )
            return {
              window: {
                days: windowDays,
                currentStart: overview.currentStart,
                currentEnd: overview.latestDate,
                previousStart: overview.previousStart,
                previousEnd: overview.previousEnd,
              },
              note: "nonBrand/allQueries come from stored query rows (anonymized long tail excluded); trueTotals come from query-less daily totals and are the real numbers. Keyword targets are judged on nonBrand, inventory pages on allQueries.",
              pages,
            }
          }),
        ),

      pageReport: (path) =>
        wrap(
          Effect.gen(function* () {
            if (!path.startsWith("/")) {
              return yield* Effect.fail(
                new ReportsError({
                  message: `Page path must start with "/", got: ${path}`,
                }),
              )
            }
            const entries = yield* registry.loadRegistry()
            const pageEntries = entries.filter(
              (entry) => entry.targetUrl === path,
            )
            const keywordEntries = pageEntries.filter((entry) =>
              entry.keyword.trim(),
            )
            const inventoryOnly =
              pageEntries.length > 0 && keywordEntries.length === 0
            const progressList = yield* storage.registryTargetProgress(entries)
            const progress = progressList.find(
              (target) => target.targetUrl === path,
            )
            const performance = yield* storage.targetPerformance(
              path,
              inventoryOnly || pageEntries.length === 0,
            )
            const digest = yield* storage.opportunityDigest(entries)
            const pageSignals = digest.signals.filter((signal) =>
              signal.pages.some((page) => pathOf(page, origin) === path),
            )
            const overview = yield* storage.pagesWindowOverview()
            const overviewRow = overview.rows.find(
              (row) => pathOf(row.page, origin) === path,
            )
            const analyticsStatus = yield* analytics.status()
            const visitsOverview = analyticsStatus
              ? yield* storage.pageVisitsOverview(
                  28,
                  overview.latestDate ?? undefined,
                )
              : null
            const visits = (yield* hasSyncedVisits(analyticsStatus))
              ? visitsWindow(
                  visitsOverview?.rows.find((row) => row.page === path),
                )
              : null
            const queries = yield* storage.topQueries({
              page: `${origin}${path}`,
              includeBrand: true,
              limit: 25,
            })
            const phase = progress ? phaseFor(progress) : "UNMAPPED"
            const judged =
              keywordEntries.length > 0
                ? overviewRow?.nonBrand
                : overviewRow?.allQueries
            const verdict = verdictFor(
              phase,
              judged ?? { current: performance.total, previous: zeroMetrics },
              pageSignals,
              origin,
            )
            const actions = yield* storage.listLog(path)
            return {
              path,
              mapped: pageEntries.length > 0,
              phase,
              state: progress?.state ?? null,
              indexed: progress?.indexStatus ?? "unknown",
              coverageState: progress?.coverageState ?? null,
              inspectedAt: progress?.inspectedAt ?? null,
              measuredFrom: progress?.measuredFrom ?? null,
              plan: pageEntries.map(entrySummary),
              ...verdict,
              performance: {
                windowStart: performance.days[0]?.date ?? null,
                windowEnd: performance.days.at(-1)?.date ?? null,
                scope:
                  inventoryOnly || pageEntries.length === 0
                    ? "all-queries"
                    : "non-brand",
                total: tidy(performance.total),
                last7: tidy(performance.last7),
                previous7: tidy(performance.previous7),
                days: performance.days.map((day) => ({
                  date: day.date,
                  ...tidy(day),
                })),
              },
              trueTotals: overviewRow?.trueTotals
                ? tidyWindow(overviewRow.trueTotals)
                : null,
              baseline: progress?.baseline ? tidy(progress.baseline) : null,
              topQueries: queries.rows.map((row) => ({
                query: row.query,
                brand: isBrandQuery(row.query, brandTerms),
                mapped: entries.some(
                  (entry) =>
                    entry.keyword.toLowerCase() === row.query.toLowerCase(),
                ),
                current: tidy(row.current),
                previous: row.previous ? tidy(row.previous) : null,
              })),
              signals: pageSignals.map((signal) => signalSummary(signal, origin)),
              actions,
              visits,
            }
          }),
        ),

      queriesReport: (options = {}) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            // From the store only: a Queries read must not block on DataForSEO,
            // and it must not *ask* it either — every term here would be a
            // billed row, and the sync already decides what is worth paying for.
            const demand = yield* keywordMetrics.cached()
            const demandFor = (query: string) => {
              const metric = demand.get(foldKeyword(query))
              return metric ? { demand: demandReport(metric) } : {}
            }
            const result = yield* storage.topQueries({
              page: options.page ? `${origin}${options.page}` : undefined,
              windowDays: options.windowDays ?? 28,
              minImpressions: options.minImpressions ?? 0,
              includeBrand: options.includeBrand === true,
              limit: options.limit ?? 50,
            })
            const keywordTargets = new Map(
              entries
                .filter((entry) => entry.keyword.trim())
                .map((entry) => [
                  entry.keyword.toLowerCase(),
                  entry.targetUrl,
                ]),
            )
            return {
              window: {
                currentStart: result.currentStart,
                currentEnd: result.latestDate,
                previousStart: result.previousStart,
                previousEnd: result.previousEnd,
              },
              queries: result.rows.map((row) => ({
                query: row.query,
                page: pathOf(row.page, origin),
                brand: isBrandQuery(row.query, brandTerms),
                mappedTarget:
                  keywordTargets.get(row.query.toLowerCase()) ?? null,
                current: tidy(row.current),
                previous: row.previous ? tidy(row.previous) : null,
                ...demandFor(row.query),
              })),
              ...(resolved.market ? { market: resolved.market } : {}),
            }
          }),
        ),

      opportunitiesReport: (kind, limit) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const digest = yield* storage.opportunityDigest(entries)
            const matching = digest.signals.filter(
              (signal) => !kind || signal.kind === kind,
            )
            // The digest is score-sorted, so a limit keeps the strongest signals.
            const signals =
              limit !== undefined ? matching.slice(0, limit) : matching
            const registryForSignal = (signal: OpportunitySignal) => {
              const byKeyword = signal.query
                ? entries.find(
                    (entry) =>
                      entry.keyword.toLowerCase() ===
                      signal.query!.toLowerCase(),
                  )
                : undefined
              return (
                byKeyword ??
                entries.find(
                  (entry) => entry.targetUrl === pathOf(signal.page, origin),
                )
              )
            }
            return {
              window: {
                currentStart: digest.currentStart,
                currentEnd: digest.latestDate,
                previousStart: digest.previousStart,
                previousEnd: digest.previousEnd,
              },
              totalSignals: matching.length,
              signals: signals.map((signal) => {
                const mapping = registryForSignal(signal)
                return {
                  ...signalSummary(signal, origin),
                  registry: mapping
                    ? {
                        targetUrl: mapping.targetUrl,
                        priority: mapping.priority,
                        intent: mapping.intent,
                        cluster: mapping.cluster,
                      }
                    : null,
                }
              }),
            }
          }),
        ),

      registryList: () =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            // Read from the store, never from DataForSEO: a Registry view must
            // not block on a third party, and `cached` cannot fail.
            const demand = yield* keywordMetrics.cached()
            const targets = yield* storage.registryTargetProgress(entries)
            // Visits over the same 28 days a target's window covers, anchored
            // on the Search Console latest date like the target itself.
            const analyticsStatus = yield* analytics.status()
            const visitsOverview = analyticsStatus
              ? yield* storage.pageVisitsOverview(
                  28,
                  (yield* storage.latestSnapshotDate()) ?? undefined,
                )
              : null
            const visitsByPath = new Map(
              (visitsOverview?.rows ?? []).map((row) => [row.page, row]),
            )
            const hasVisits = yield* hasSyncedVisits(analyticsStatus)
            return {
              ...(resolved.market ? { market: resolved.market } : {}),
              targets: targets.map((progress) => {
                const first = progress.entries[0]!
                return {
                  targetUrl: progress.targetUrl,
                  phase: phaseFor(progress),
                  state: progress.state,
                  indexed: progress.indexStatus,
                  coverageState: progress.coverageState,
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
                  visits: hasVisits
                    ? visitsWindow(visitsByPath.get(progress.targetUrl))
                    : null,
                  keywords: progress.entries
                    .filter((entry) => entry.keyword.trim())
                    .map((entry) => {
                      const metric = demand.get(foldKeyword(entry.keyword))
                      return {
                        keyword: entry.keyword,
                        cluster: entry.cluster,
                        intent: entry.intent,
                        ...(metric ? { demand: demandReport(metric) } : {}),
                      }
                    }),
                }
              }),
            }
          }),
        ),

      proposedKeywords: () =>
        wrap(
          Effect.gen(function* () {
            const proposals = yield* discovery.proposed()
            return {
              // `resolved.market` is the Site's own, and every proposal is keyed
              // by the Market it was found in — so naming it here cannot label
              // one Market's numbers with another's.
              ...(resolved.market ? { market: resolved.market } : {}),
              totals: {
                proposals: proposals.length,
                monthlyVolume: proposals.reduce(
                  (total, proposal) => total + (proposal.searchVolume ?? 0),
                  0,
                ),
              },
              proposals,
            }
          }),
        ),

      dismissProposals: (keywords) =>
        wrap(
          Effect.map(discovery.dismiss(keywords), (dismissed) => ({ dismissed })),
        ),

      registryHealth: () =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const demand = yield* keywordMetrics.cached()
            // The one read in this domain that wants the eight-year series,
            // which is why it is a separate call — see
            // Storage.keywordMonthlySearches. Only this report pays for it, and
            // an unreadable store costs the peak months rather than the report.
            const series = resolved.market
              ? yield* storage
                  .keywordMonthlySearches(
                    resolved.market.locationCode,
                    resolved.market.languageCode,
                  )
                  .pipe(
                    Effect.catchCause(() =>
                      Effect.succeed(
                        new Map() as ReadonlyMap<
                          string,
                          ReadonlyArray<MonthlySearch>
                        >,
                      ),
                    ),
                  )
              : new Map<string, ReadonlyArray<MonthlySearch>>()
            // Supplementary, and `cached` cannot fail: a site with no stored
            // rating gets a null gap rather than no report.
            const rating = yield* domainRatingService.cached()
            const domainRating = rating?.rating ?? null

            const keywords = entries
              // Inventory-only rows have no keyword to judge. They are pages
              // the sitemap contributed, not claims about demand.
              .filter((entry) => entry.keyword.trim())
              .map((entry) => {
                const metric = demand.get(foldKeyword(entry.keyword))
                const difficulty = metric?.difficulty ?? null
                return {
                  keyword: entry.keyword,
                  targetUrl: entry.targetUrl,
                  cluster: entry.cluster,
                  priority: entry.priority,
                  intent: entry.intent,
                  verdict: keywordVerdict(metric),
                  searchVolume: metric?.searchVolume ?? null,
                  difficulty,
                  difficultyGap:
                    difficulty !== null && domainRating !== null
                      ? Math.round((difficulty - domainRating) * 10) / 10
                      : null,
                  costPerClick: metric?.costPerClick ?? null,
                  reportedIntent: metric?.intent ?? null,
                  ...seasonalityOf(series.get(foldKeyword(entry.keyword)) ?? []),
                }
              })
              .sort((left, right) => {
                const byVerdict =
                  healthRank[left.verdict] - healthRank[right.verdict]
                if (byVerdict !== 0) return byVerdict
                // Within a verdict: the biggest demand first, and where there
                // is none to compare, the plan's own order.
                return (right.searchVolume ?? 0) - (left.searchVolume ?? 0)
              })

            const count = (verdict: KeywordHealthVerdict) =>
              keywords.filter((row) => row.verdict === verdict).length

            return {
              ...(resolved.market ? { market: resolved.market } : {}),
              domainRating,
              totals: {
                keywords: keywords.length,
                unmeasured: count("unmeasured"),
                unreported: count("unreported"),
                noDemand: count("no-demand"),
                hasDemand: count("has-demand"),
                monthlyVolume: keywords.reduce(
                  (total, row) =>
                    row.verdict === "has-demand"
                      ? total + (row.searchVolume ?? 0)
                      : total,
                  0,
                ),
              },
              keywords,
            }
          }),
        ),

      registryAdd: (input) =>
        wrap(
          Effect.gen(function* () {
            if (!input.target)
              return yield* Effect.fail(
                new ReportsError({
                  message: "registry add requires a target path",
                }),
              )
            const keyword = input.keyword ?? ""
            if (keyword && (!input.cluster || !input.intent || !input.priority)) {
              return yield* Effect.fail(
                new ReportsError({
                  message: "Keyword rows require cluster, intent, and priority.",
                }),
              )
            }
            const entry: RegistryEntry = {
              cluster: input.cluster ?? "Site inventory",
              keyword,
              targetUrl: input.target,
              intent: input.intent ?? "site-inventory",
              whyOpportunity: input.why ?? "",
              priority: input.priority ?? "",
              publishedAt: input.publishedAt ?? "",
              baselineDate: input.baselineDate ?? "",
              status: input.status ?? (keyword ? "Planned" : "Inventory"),
            }
            yield* registry.appendRegistryEntry(entry)
            return { added: entrySummary(entry), targetUrl: input.target }
          }),
        ),

      registrySet: (target, keyword, patch) =>
        wrap(
          Effect.gen(function* () {
            if (!target)
              return yield* Effect.fail(
                new ReportsError({
                  message: "registry set requires a target path",
                }),
              )
            if (Object.values(patch).every((value) => value === undefined)) {
              return yield* Effect.fail(
                new ReportsError({
                  message: "registry set requires at least one field to change",
                }),
              )
            }
            const updated = yield* registry.updateRegistryRows(
              target,
              keyword,
              patch,
            )
            const applied = Object.fromEntries(
              Object.entries(patch).filter(([, value]) => value !== undefined),
            ) as RegistryPatch
            return {
              targetUrl: target,
              keyword: keyword ?? null,
              updatedRows: updated,
              patch: applied,
            }
          }),
        ),

      logAdd: (input) =>
        wrap(
          Effect.gen(function* () {
            if (!input.path || !input.path.startsWith("/"))
              return yield* Effect.fail(
                new ReportsError({
                  message: "log add requires a path starting with /",
                }),
              )
            if (!logKinds.includes(input.kind as LogKind))
              return yield* Effect.fail(
                new ReportsError({
                  message: `log kind must be one of: ${logKinds.join(", ")}`,
                }),
              )
            const date = input.date ?? new Date().toISOString().slice(0, 10)
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
              return yield* Effect.fail(
                new ReportsError({ message: `date must use YYYY-MM-DD: ${date}` }),
              )
            const logged = yield* storage.addLogEntry({
              date,
              path: input.path,
              kind: input.kind as LogKind,
              note: input.note ?? "",
            })
            return { logged }
          }),
        ),

      logList: (path) =>
        wrap(
          Effect.gen(function* () {
            const actions = yield* storage.listLog(path)
            return { actions }
          }),
        ),

      logFeed: (path) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const log = yield* storage.listLog(path)
            return yield* enrichLog(log, entries)
          }),
        ),

      recentActions: (limit = 3) =>
        wrap(
          Effect.gen(function* () {
            const actions = yield* storage.listLog()
            return actions
              .filter((entry) => entry.kind !== "note")
              .slice(0, limit)
          }),
        ),

      historyReport: (limit = 28) =>
        wrap(
          Effect.gen(function* () {
            const days = yield* storage.historyWithPending(limit)
            const analyticsStatus = yield* analytics.status()
            const visitDays = analyticsStatus
              ? yield* storage.visitsHistory(limit)
              : []
            const visitsByDate = new Map(
              visitDays.map((day) => [
                day.date,
                {
                  pageviews: day.pageviews,
                  visits: day.visits,
                  visitors: day.visitors,
                },
              ]),
            )
            return {
              days: days.map((day) => ({
                date: day.date,
                provisional: day.provisional ?? false,
                ...tidy(day),
                visits: visitsByDate.get(day.date) ?? null,
              })),
            }
          }),
        ),

      eventsReport: (windowDays = 28) =>
        wrap(
          Effect.gen(function* () {
            const analyticsStatus = yield* analytics.status()
            const empty = {
              currentStart: null,
              currentEnd: null,
              previousStart: null,
              previousEnd: null,
            }
            if (!analyticsStatus)
              return { analytics: null, windowDays, window: empty, events: [] }
            // Anchored on the newest finished day of visits: yesterday when the
            // today sync has run, else the newest synced day. Not on the Search
            // Console latest date, as the pages and registry windows are — no
            // clicks figure sits beside an event count, and that anchor lags
            // days and would hide the freshest events. Today's partial day is
            // left out so the window is whole days only; the Today period
            // shows it. A site with no visits synced at all falls back to the
            // Search Console date, which only matters for the empty window's
            // labels.
            const summary = yield* storage.visitsSummary()
            const local = yield* analytics.localDay()
            const finished =
              summary.lastDate && local && summary.lastDate >= local.date
                ? dateDaysBefore(local.date, 1)
                : summary.lastDate
            const anchor = finished ?? (yield* storage.latestSnapshotDate())
            if (!anchor)
              return { analytics: analyticsStatus, windowDays, window: empty, events: [] }
            const currentStart = dateDaysBefore(anchor, windowDays - 1)
            const previousEnd = dateDaysBefore(currentStart, 1)
            const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
            const rows = yield* storage.eventWindow(windowDays, anchor)
            return {
              analytics: analyticsStatus,
              windowDays,
              window: { currentStart, currentEnd: anchor, previousStart, previousEnd },
              events: rows.map((row) => ({
                name: row.name,
                current: row.current,
                previous: row.previous,
                delta: row.current - row.previous,
              })),
            }
          }),
        ),

      todayReport: () =>
        wrap(
          Effect.gen(function* () {
            const analyticsStatus = yield* analytics.status()
            const local = yield* analytics.localDay()
            if (!analyticsStatus || !local)
              return { analytics: analyticsStatus, today: null }
            // Served from the ledger, as every other read is; the today sync
            // keeps these rows a few minutes old. Before its first run the day
            // reads as zeros with a null syncedAt, not as an error.
            const day = yield* storage.visitsOfDay(local.date)
            const hours = yield* storage.hoursOfDay(local.date)
            const syncedAt = yield* storage.visitsSyncedAt(local.date)
            return {
              analytics: analyticsStatus,
              today: {
                date: local.date,
                timeZone: local.timeZone,
                hoursElapsed: local.hour + 1,
                site: day.site.find((row) => row.date === local.date) ?? null,
                hours: normaliseHours(hours),
                pages: day.pages,
                events: day.events,
                syncedAt,
              },
            }
          }),
        ),

      revenueReport: (windowDays = 28) =>
        wrap(
          Effect.gen(function* () {
            const revenueStatus = yield* revenue.status()
            const empty = {
              currentStart: null,
              currentEnd: null,
              previousStart: null,
              previousEnd: null,
            }
            const zero: RevenueTotals = { orders: 0, revenue: 0, net: 0 }
            const nothing = (status: typeof revenueStatus): RevenueReport => ({
              revenue: status,
              windowDays,
              window: empty,
              currency: null,
              days: [],
              current: zero,
              previous: zero,
              delta: zero,
            })
            if (!revenueStatus) return nothing(null)
            // Anchored as the events report is: on the newest finished day,
            // which is yesterday once the today sync has written today's row,
            // else the newest synced day. Today's partial day stays out so the
            // window is whole days only.
            const summary = yield* storage.revenueSummary()
            const local = yield* revenue.localDay()
            const anchor =
              summary.lastDate && local && summary.lastDate >= local.date
                ? dateDaysBefore(local.date, 1)
                : summary.lastDate
            if (!anchor) return nothing(revenueStatus)
            const currentStart = dateDaysBefore(anchor, windowDays - 1)
            const previousEnd = dateDaysBefore(currentStart, 1)
            const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
            const [days, previousDays] = yield* Effect.all([
              storage.revenueDays(currentStart, anchor),
              storage.revenueDays(previousStart, previousEnd),
            ])
            const current = sumRevenue(days)
            const previous = sumRevenue(previousDays)
            return {
              revenue: revenueStatus,
              windowDays,
              window: { currentStart, currentEnd: anchor, previousStart, previousEnd },
              currency: days[0]?.currency ?? previousDays[0]?.currency ?? null,
              days,
              current,
              previous,
              delta: {
                orders: current.orders - previous.orders,
                revenue: current.revenue - previous.revenue,
                net: current.net - previous.net,
              },
            }
          }),
        ),

      liveReport: () =>
        wrap(
          Effect.gen(function* () {
            const analyticsStatus = yield* analytics.status()
            // A configured-but-not-ready provider fails the fetch with its
            // reason; that reason is already on the status, so the report
            // carries the status and a null count instead of an error.
            const live = analyticsStatus?.ready
              ? yield* analytics.liveVisitors()
              : null
            return { analytics: analyticsStatus, live }
          }),
        ),

      liveEventsReport: (since) =>
        wrap(
          Effect.gen(function* () {
            const analyticsStatus = yield* analytics.status()
            const events = analyticsStatus?.ready
              ? yield* analytics.liveEvents(since)
              : null
            return { analytics: analyticsStatus, events }
          }),
        ),

      dashboardSnapshot: () =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const sitemapPages = yield* sitemap.loadCachedSitemapPages()
            const rawLog = yield* storage.listLog()
            const logEntries = yield* enrichLog(rawLog, entries)
            const registryTargets =
              yield* storage.registryTargetProgress(entries)
            const summary = yield* storage.snapshotSummary()
            const sitemapGaps = yield* sitemap.unmappedSitemapPages(
              sitemapPages,
              entries,
            )
            const digest = yield* storage.opportunityDigest(entries)
            const history = yield* storage.historyWithPending()
            // Read from the volume, never from Ahrefs: Sync owns the refresh.
            const domainRating = yield* domainRatingService.cached()
            const domainRatingHistory = yield* storage.domainRatingHistory()
            const analyticsStatus = yield* analytics.status()
            const visitsHistory = analyticsStatus
              ? yield* storage.visitsHistory()
              : []
            const events = analyticsStatus
              ? yield* storage.eventWindow(28, digest.latestDate ?? undefined)
              : []
            const recentActions = rawLog
              .filter((entry) => entry.kind !== "note")
              .slice(0, 3)
            const performances = yield* Effect.forEach(
              registryTargets,
              (target) =>
                storage
                  .targetPerformance(
                    target.targetUrl,
                    target.entries.every((entry) => !entry.keyword.trim()),
                  )
                  .pipe(
                    Effect.map((performance) => ({
                      targetUrl: target.targetUrl,
                      performance,
                    })),
                  ),
            )
            return {
              summary,
              registry: entries,
              sitemapGaps,
              sitemapPageCount: sitemapPages.length,
              digest,
              registryTargets,
              logEntries,
              history,
              recentActions,
              performances,
              domainRating,
              domainRatingHistory,
              analytics: analyticsStatus,
              visitsHistory,
              events,
            }
          }),
        ),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(DomainRating.defaultLayer),
  Layer.provide(KeywordMetrics.defaultLayer),
  Layer.provide(KeywordDiscovery.defaultLayer),
  Layer.provide(Analytics.defaultLayer),
  Layer.provide(Revenue.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(Sitemap.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

// --- pure presentation helpers (no service, no site) ---

const zeroMetrics: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

const zeroVisits: Visits = { pageviews: 0, visits: 0 }

// Orders and amounts summed over a run of days; amounts stay in minor units.
const sumRevenue = (days: ReadonlyArray<RevenueDay>): RevenueTotals =>
  days.reduce(
    (total, day) => ({
      orders: total.orders + day.orders,
      revenue: total.revenue + day.revenue,
      net: total.net + day.net,
    }),
    { orders: 0, revenue: 0, net: 0 },
  )

// The visits twin of tidyWindow(): a current/previous pair with its deltas. A
// page the provider has no row for, in a site that does have visits, is zero.
const visitsWindow = (row: PageVisitsRow | undefined): VisitsWindowReport => {
  const current = row?.current ?? zeroVisits
  const previous = row?.previous ?? zeroVisits
  return {
    current,
    previous,
    deltaPageviews: current.pageviews - previous.pageviews,
    deltaVisits: current.visits - previous.visits,
  }
}

// Subtract `days` (UTC) from an ISO date; negative days move forward.
const dateDaysBefore = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

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

// Reduce a full-URL page to a site-relative path when it is on the active site.
export const pathOf = (page: string, origin: string): string =>
  page.startsWith(origin) ? new URL(page).pathname : page

// A target's lifecycle phase for display (PAGE/LIVE/NONE/PRE/NEW).
export const phaseFor = (progress: RegistryTargetProgress): string => {
  const keywordCount = progress.entries.filter((entry) =>
    entry.keyword.trim(),
  ).length
  if (keywordCount === 0) return "PAGE"
  if (progress.target.impressions > 0) return "LIVE"
  if (progress.state === "measuring") return "NONE"
  if (progress.state === "awaiting-post-baseline") return "PRE"
  return "NEW"
}

// A registry entry summarized for display.
export const entrySummary = (entry: RegistryEntry): EntrySummary => ({
  keyword: entry.keyword,
  cluster: entry.cluster,
  intent: entry.intent,
  priority: entry.priority,
  publishedAt: entry.publishedAt || null,
  baselineDate: entry.baselineDate || null,
  status: entry.status,
  whyOpportunity: entry.whyOpportunity,
})

// An opportunity signal summarized for display.
// What a stored metric says about a planned Keyword, or "unmeasured" when there
// is none. See KeywordHealthVerdict for why a null volume and a zero one are
// kept apart: both mean "expect no traffic here", but only one of them is the
// vendor saying so.
export const keywordVerdict = (
  metric: KeywordMetricSummary | undefined,
): KeywordHealthVerdict => {
  if (!metric) return "unmeasured"
  if (metric.searchVolume === null) return "unreported"
  return metric.searchVolume > 0 ? "has-demand" : "no-demand"
}

// The calendar month a keyword's demand peaks in, and how pronounced that peak
// is, worked out from the stored monthly series.
//
// The naive version of this — average each calendar month over the whole series
// and take the highest — is wrong, and wrong in the worst direction: it cannot
// tell seasonality from trend. A term whose demand has tripled over eight years
// has its highest raw months at the end of the series, so the "peak" would be
// whichever calendar month the data happens to stop on. That is exactly
// backwards for planning, because a growing term is the one most worth planning
// around.
//
// So each month is divided by its own year's mean before anything is averaged.
// What is left is a seasonal index — how a month does relative to its year —
// which a trend cannot move, because the trend is inside the divisor.
//
// Only complete calendar years count. DataForSEO's series starts and ends
// mid-year (2018-10 to 2026-07 on one live call), and a partial year's mean is
// biased by whichever months it happens to contain: an October-to-December stub
// would make Q4 look merely average and drag every other month's index up
// against it.
export const seasonalityOf = (
  months: ReadonlyArray<MonthlySearch>,
): { readonly peakMonth: number | null; readonly seasonality: number | null } => {
  const none = { peakMonth: null, seasonality: null }

  const byYear = new Map<number, Array<MonthlySearch>>()
  for (const month of months) {
    if (month.month < 1 || month.month > 12) continue
    byYear.set(month.year, [...(byYear.get(month.year) ?? []), month])
  }

  // Two complete years is the floor: one observation of a calendar month is
  // that month, not an average of it.
  const complete = [...byYear.values()].filter((year) => year.length === 12)
  if (complete.length < 2) return none

  const index = new Map<number, Array<number>>()
  for (const year of complete) {
    const mean = year.reduce((total, month) => total + month.searchVolume, 0) / 12
    // A year nobody searched in has no shape to read. Skipped rather than
    // divided by, which would be an infinity.
    if (mean <= 0) continue
    for (const month of year)
      index.set(month.month, [
        ...(index.get(month.month) ?? []),
        month.searchVolume / mean,
      ])
  }
  if (index.size < 12) return none

  const means = [...index].map(
    ([month, ratios]) =>
      [
        month,
        ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length,
      ] as const,
  )
  const peak = means.reduce((best, current) => (current[1] > best[1] ? current : best))
  return { peakMonth: peak[0], seasonality: Math.round(peak[1] * 100) / 100 }
}

// The order the health report lists keywords in. Demand first and strongest
// first, because that is where the plan's weight actually is; then the rows the
// reader has to decide about, with the measured-and-empty ones ahead of the
// unmeasured, because those are a decision and these are just a gap in the data.
const healthRank: Record<KeywordHealthVerdict, number> = {
  "has-demand": 0,
  "no-demand": 1,
  unreported: 2,
  unmeasured: 3,
}

// A stored Keyword metric as a report reports it.
//
// The monthly series was already left out of the wire shape, and this now takes
// the summary type that does not carry it at all — Storage does not read it on
// this path. The original comment here guessed "twelve numbers per keyword";
// the vendor actually sends about 94, so a Registry with forty keywords would
// have carried nearly four thousand of them into every read.
export const demandReport = (metric: KeywordMetricSummary): DemandReport => ({
  searchVolume: metric.searchVolume,
  difficulty: metric.difficulty,
  costPerClick: metric.costPerClick,
  competition: metric.competition,
  intent: metric.intent,
  fetchedAt: metric.fetchedAt,
})

export const signalSummary = (
  signal: OpportunitySignal,
  origin: string,
): SignalSummary => ({
  kind: signal.kind,
  query: signal.query,
  page: pathOf(signal.page, origin),
  pages: signal.pages.map((page) => pathOf(page, origin)),
  mapped: signal.mapped,
  current: tidy(signal.current),
  previous: signal.previous ? tidy(signal.previous) : null,
  recommendation: signal.recommendation,
  score: Math.round(signal.score),
  ...(signal.demand ? { demand: signal.demand } : {}),
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

// The narrative verdict + reasons for a page/target, from its phase, window
// metrics, and matched opportunity signals.
export const verdictFor = (
  phase: string,
  metrics: { readonly current: Metrics; readonly previous: Metrics },
  signals: ReadonlyArray<OpportunitySignal>,
  origin: string,
): Verdict => {
  // A hub page can match dozens of signals (every cannibalization group it
  // appears in); narrate only the strongest few so the verdict stays readable.
  // The digest is score-sorted, so the first matches are the ones that matter.
  const maxNarratedSignals = 5
  const reasons: string[] = []
  for (const signal of signals.slice(0, maxNarratedSignals)) {
    if (signal.kind === "striking-distance")
      reasons.push(
        `"${signal.query}" ranks at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions — within striking distance of the top results.`,
      )
    if (signal.kind === "ctr")
      reasons.push(
        `"${signal.query}" ranks in the top 10 but earns fewer clicks than comparable results (${(signal.current.ctr * 100).toFixed(1)}% CTR).`,
      )
    if (signal.kind === "cannibalization")
      reasons.push(
        `"${signal.query}" is split across ${signal.pages.length} pages: ${signal.pages.map((page) => pathOf(page, origin)).join(", ")}.`,
      )
  }
  if (signals.length > maxNarratedSignals)
    reasons.push(
      `…and ${signals.length - maxNarratedSignals} more matched signals (see the opportunities report).`,
    )
  if (phase === "PRE")
    return {
      verdict: "awaiting-launch",
      reasons: [
        "Published or baseline date is in the future of the available data; waiting for post-launch observations.",
        ...reasons,
      ],
    }
  const { current, previous } = metrics
  if (current.impressions === 0 && previous.impressions === 0)
    return {
      verdict: "no-visibility",
      reasons: ["No impressions in the current or previous window.", ...reasons],
    }
  if (
    signals.some(
      (signal) => signal.kind === "striking-distance" || signal.kind === "ctr",
    )
  )
    return { verdict: "needs-optimization", reasons }
  if (signals.some((signal) => signal.kind === "cannibalization"))
    return { verdict: "needs-attention", reasons }
  if (previous.impressions === 0)
    return {
      verdict: "new-visibility",
      reasons: [
        `First impressions appeared in the current window (${current.impressions}).`,
        ...reasons,
      ],
    }
  const change = (current.impressions - previous.impressions) / previous.impressions
  if (change >= 0.2)
    return {
      verdict: "improving",
      reasons: [
        `Impressions up ${(change * 100).toFixed(0)}% versus the previous window.`,
        ...reasons,
      ],
    }
  if (change <= -0.2)
    return {
      verdict: "declining",
      reasons: [
        `Impressions down ${(Math.abs(change) * 100).toFixed(0)}% versus the previous window.`,
        ...reasons,
      ],
    }
  return {
    verdict: "steady",
    reasons: [
      `Impressions within ±20% of the previous window (${previous.impressions} → ${current.impressions}).`,
      ...reasons,
    ],
  }
}

// Whether a query contains any of the active site's brand terms.
export const isBrandQuery = (
  query: string,
  brandTerms: ReadonlyArray<string>,
): boolean =>
  brandTerms.some((term) => query.toLowerCase().includes(term.toLowerCase()))

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

export const shortAction: Record<OpportunityKind, string> = {
  "striking-distance":
    "Improve the existing ranking page first: strengthen intent match, content depth, and internal links before creating a new page.",
  ctr: "Test the title and description against the query intent; keep the page focused if its ranking is already strong.",
  "new-demand":
    "Check existing pages first. Map the keyword only when the intent fits; create a page only when no current page fits.",
  cannibalization:
    "Choose one primary page, then consolidate, redirect, or clarify the competing pages and their internal links.",
}

export const signalMeaning: Record<OpportunityKind, string> = {
  "striking-distance":
    "Current 28-day query row: 20+ impressions, position 4–20, and CTR under 10%. Brand queries are excluded.",
  ctr: "Current 28-day query row: 50+ impressions, position 1–10, and CTR below 80% of its benchmark. The benchmark is the same-band median when 3+ comparable rows exist; otherwise it is the site median.",
  "new-demand":
    "After grouping current 28-day rows by query: 20+ impressions and no exact case-insensitive registry keyword match. Brand queries are excluded.",
  cannibalization:
    "After grouping current 28-day rows by query: the query has rows for 2+ different page URLs. Brand queries are excluded.",
}

export const signalExplanation: Record<OpportunityKind, string> = {
  "striking-distance":
    "This page is already visible and close to the first page. Improving the page may produce more traffic faster than publishing a new page.",
  ctr: "This page already ranks well, but its search result earns fewer clicks than similar results. The title, description, or intent match may need work.",
  "new-demand":
    "People are searching for a phrase your plan does not cover. First decide whether an existing page satisfies that intent; only then create a new mapping or page.",
  cannibalization:
    "Google is dividing one query between multiple pages on this site. That can weaken both pages because neither has a clear primary target.",
}

export const signalReason = (
  signal: OpportunitySignal,
  origin: string,
): string => {
  const ctr = `${(signal.current.ctr * 100).toFixed(1)}%`
  if (signal.kind === "striking-distance")
    return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions and a ${ctr} CTR. It is visible, but there is room to earn more clicks.`
  if (signal.kind === "ctr")
    return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions, but its ${ctr} CTR is below the expected rate for this ranking range.`
  if (signal.kind === "new-demand")
    return `“${signal.label}” generated ${signal.current.impressions} impressions, but it is not mapped to a keyword in the selected site's registry.`
  if (signal.kind === "cannibalization")
    return `“${signal.label}” is receiving impressions for ${signal.pages.length} pages: ${signal.pages.map((page) => pathOf(page, origin)).join(", ")}.`
  return `“${signal.label}” matched the selected opportunity rule based on its current Search Console performance.`
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
