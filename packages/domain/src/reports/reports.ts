// Reports service: report shaping over Storage/Registry/Sitemap. The CLI, HTTP
// server, and TUI are thin shells over this — none of them reach into Storage
// for report shaping themselves. Site-scoped (CurrentSite for origin/brand).
//
// Pure presentation helpers and shared copy live at the bottom as plain
// exported functions/constants (no service, no site) so both frontends format
// identically.
import { Context, Effect, Layer } from "effect"

import { isBrandQuery } from "../brand.ts"
import { CurrentSite } from "../sites/current-site.ts"
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
  type RegistryTargetProgress,
  type StorageError,
} from "../storage/schema.ts"
import {
  type DashboardSnapshot,
  type EntrySummary,
  type EngineTotals,
  type EngineWindowTotals,
  type HistoryReport,
  type KeywordEngineWindow,
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
  type RegistryListReport,
  type RegistrySetResult,
  ReportsError,
  type SignalSummary,
  type StatusReport,
  type TidyMetrics,
  type TidyWindow,
  type Verdict,
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
    const storage = yield* Storage.Service
    const registry = yield* Registry.Service
    const sitemap = yield* Sitemap.Service
    const site = yield* CurrentSite.Service
    const resolved = yield* site.current()
    const origin = resolved.origin
    const brandTerms = resolved.brandTerms

    // Map the dependencies' typed errors to a ReportsError; the guard failures
    // raised inside the report gens are already ReportsError and pass through.
    const wrap = <A>(
      effect: Effect.Effect<A, StorageError | RegistryError | ReportsError>,
    ): Effect.Effect<A, ReportsError> =>
      effect.pipe(
        Effect.catchTags({
          StorageError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
          RegistryError: (cause) =>
            Effect.fail(new ReportsError({ message: cause.message, cause })),
        }),
      )

    const aggregateEngineWindow = (
      rows: ReadonlyArray<{
        readonly date: string
        readonly clicks: number
        readonly impressions: number
      }>,
      start: string,
      end: string,
      windowDays: number,
    ): EngineWindowTotals => {
      const inWindow = rows.filter(
        (row) => row.date >= start && row.date <= end,
      )
      const impressions = inWindow.reduce(
        (total, row) => total + row.impressions,
        0,
      )
      const clicks = inWindow.reduce((total, row) => total + row.clicks, 0)
      return {
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        daysCollected: inWindow.length,
        windowDays,
      }
    }

    const engineTotals = (): Effect.Effect<EngineTotals, StorageError> =>
      Effect.gen(function* () {
        const googleDays = yield* storage.historyWithPending(485)
        const latestDate =
          googleDays.at(-1)?.date ?? (yield* storage.finalizationCutoff())
        const start28 = dateDaysBefore(latestDate, 27)
        const start7 = dateDaysBefore(latestDate, 6)
        const bingRows = yield* storage.bingSiteDailyBetween(start28, latestDate)
        return {
          google: {
            d28: aggregateEngineWindow(googleDays, start28, latestDate, 28),
            d7: aggregateEngineWindow(googleDays, start7, latestDate, 7),
          },
          bing: {
            d28: aggregateEngineWindow(bingRows, start28, latestDate, 28),
            d7: aggregateEngineWindow(bingRows, start7, latestDate, 7),
          },
        }
      })

    const metricsFromBingRow = (row: {
      readonly clicks: number
      readonly impressions: number
      readonly position: number
    }): Metrics => ({
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
      position: row.position,
    })

    const keywordWindowsFor = (
      entries: ReadonlyArray<RegistryEntry>,
    ): Effect.Effect<ReadonlyArray<KeywordEngineWindow>, StorageError> =>
      Effect.gen(function* () {
        const latestDate = yield* storage.latestSnapshotDate()
        const bingCapture = yield* storage.bingQueryWindowLatest()
        const bingByQuery = new Map(
          bingCapture?.rows.map((row) => [row.query.toLowerCase(), row]) ?? [],
        )
        const keywordEntries = entries.filter((entry) => entry.keyword.trim())
        if (!latestDate) {
          return keywordEntries.map((entry) => ({
            keyword: entry.keyword,
            targetUrl: entry.targetUrl,
            google7d: tidy(zeroMetrics),
            bing7d: null,
          }))
        }
        const start7 = dateDaysBefore(latestDate, 6)
        return yield* Effect.forEach(keywordEntries, (entry) =>
          Effect.gen(function* () {
            const google7d = yield* storage.googleKeywordMetricsBetween(
              `${origin}${entry.targetUrl}`,
              entry.keyword,
              start7,
              latestDate,
            )
            const bingRow = bingCapture
              ? bingByQuery.get(entry.keyword.toLowerCase())
              : undefined
            return {
              keyword: entry.keyword,
              targetUrl: entry.targetUrl,
              google7d: tidy(google7d),
              bing7d: bingCapture
                ? tidy(bingRow ? metricsFromBingRow(bingRow) : zeroMetrics)
                : null,
            }
          }),
        )
      })

    const keywordWindowForEntry = (
      windows: ReadonlyArray<KeywordEngineWindow>,
      entry: RegistryEntry,
    ) =>
      windows.find(
        (window) =>
          window.targetUrl === entry.targetUrl &&
          window.keyword.toLowerCase() === entry.keyword.toLowerCase(),
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
            const overview = yield* storage.pagesWindowOverview()
            const unmapped = yield* sitemap.unmappedSitemapPages(
              sitemapPages,
              entries,
            )
            const actions = yield* storage.listLog()
            const keywords = entries.filter((entry) => entry.keyword.trim())
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
                targets: new Set(entries.map((entry) => entry.targetUrl)).size,
                keywords: keywords.length,
                clusters: new Set(keywords.map((entry) => entry.cluster)).size,
              },
              sitemap: {
                pages: sitemapPages.length,
                unmapped: unmapped.map((page) => page.path),
              },
              actions: actions.length,
            }
          }),
        ),

      pagesReport: (windowDays = 28) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const overview = yield* storage.pagesWindowOverview(windowDays)
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
              bingInIndex: progress?.bingInIndex ?? null,
              bingDiscoveredAt: progress?.bingDiscoveredAt ?? null,
              bingLastCrawledAt: progress?.bingLastCrawledAt ?? null,
              bingInspectedAt: progress?.bingInspectedAt ?? null,
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
            }
          }),
        ),

      queriesReport: (options = {}) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
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
              })),
            }
          }),
        ),

      opportunitiesReport: (kind) =>
        wrap(
          Effect.gen(function* () {
            const entries = yield* registry.loadRegistry()
            const digest = yield* storage.opportunityDigest(entries)
            const signals = digest.signals.filter(
              (signal) => !kind || signal.kind === kind,
            )
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
            const targets = yield* storage.registryTargetProgress(entries)
            const keywordWindows = yield* keywordWindowsFor(entries)
            return {
              targets: targets.map((progress) => {
                const first = progress.entries[0]!
                return {
                  targetUrl: progress.targetUrl,
                  phase: phaseFor(progress),
                  state: progress.state,
                  indexed: progress.indexStatus,
                  coverageState: progress.coverageState,
                  inspectedAt: progress.inspectedAt,
                  bingInIndex: progress.bingInIndex,
                  bingDiscoveredAt: progress.bingDiscoveredAt,
                  bingLastCrawledAt: progress.bingLastCrawledAt,
                  bingInspectedAt: progress.bingInspectedAt,
                  priority: first.priority || null,
                  intent: first.intent,
                  publishedAt: first.publishedAt || null,
                  baselineDate: first.baselineDate || null,
                  status: first.status,
                  whyOpportunity: first.whyOpportunity || null,
                  measuredFrom: progress.measuredFrom,
                  window: tidy(progress.target),
                  baseline: progress.baseline ? tidy(progress.baseline) : null,
                  keywords: progress.entries
                    .filter((entry) => entry.keyword.trim())
                    .map((entry) => {
                      const window = keywordWindowForEntry(keywordWindows, entry)
                      return {
                        keyword: entry.keyword,
                        cluster: entry.cluster,
                        intent: entry.intent,
                        country: entry.country,
                        google7d: window?.google7d ?? tidy(zeroMetrics),
                        bing7d: window?.bing7d ?? null,
                      }
                    }),
                }
              }),
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
              country: input.country ?? "USA",
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
            const totals = yield* engineTotals()
            return {
              days: days.map((day) => ({
                date: day.date,
                provisional: day.provisional ?? false,
                ...tidy(day),
              })),
              engineTotals: totals,
            }
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
            const totals = yield* engineTotals()
            const keywordWindows = yield* keywordWindowsFor(entries)
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
              engineTotals: totals,
              keywordWindows,
            }
          }),
        ),
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

const zeroMetrics: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

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

export const bingInventoryKeywordNote =
  "Bing has no page-level keyword data; figures cannot be attributed to inventory-only pages."

const formatEngine7d = (label: string, metrics: TidyMetrics) =>
  `${label}: ${metrics.impressions} impr · ${metrics.clicks} clk · pos ${label === "B" ? metrics.position.toFixed(0) : metrics.position.toFixed(1)}`

export const keywordEngineLine = (window: KeywordEngineWindow): string =>
  `${window.keyword} — ${formatEngine7d("G", window.google7d)} · ${
    window.bing7d ? formatEngine7d("B", window.bing7d) : "B: —"
  }`

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
  country: entry.country,
  priority: entry.priority,
  publishedAt: entry.publishedAt || null,
  baselineDate: entry.baselineDate || null,
  status: entry.status,
  whyOpportunity: entry.whyOpportunity,
})

// An opportunity signal summarized for display.
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
  const reasons: string[] = []
  for (const signal of signals) {
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
