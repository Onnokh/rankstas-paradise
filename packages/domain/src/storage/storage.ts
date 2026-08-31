// Storage service: the per-site SQLite ledger. Site-scoped — it reads the
// active site (and thus its database path, origin, and brand terms) from
// CurrentSite; no method takes a site parameter. Backed by
// @effect/sql-sqlite-bun's SqliteClient, opened once as a scoped resource on
// layer acquisition (keyed off CurrentSite's databasePath) and closed on
// release. All `create table if not exists` DDL and the `synced_day` backfill
// run once at acquisition. Ports the legacy `src/storage.ts` behaviour exactly.
import { mkdirSync } from "node:fs"

import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import { type SqlError } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"

import { CurrentSite } from "../sites/current-site.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexStatus,
} from "../search-console/schema.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { serviceUse } from "../service-use.ts"
import {
  type BaselineCapture,
  type HistoryDay,
  type LogEntry,
  type LogEntryInput,
  type Metrics,
  type Opportunity,
  type OpportunityDigest,
  type OpportunitySignal,
  type PagesWindowOverview,
  type RegistryDay,
  type RegistryPerformance,
  type RegistryProgress,
  type RegistryTargetProgress,
  StorageError,
  type SnapshotDateRange,
  type SnapshotSummary,
  type TopQueriesOptions,
  type TopQueriesResult,
} from "./schema.ts"

export interface Interface {
  // --- writes ---
  readonly saveSnapshots: (
    snapshots: ReadonlyArray<DailySnapshot>,
    fetchedDates?: ReadonlyArray<string>,
  ) => Effect.Effect<void, StorageError>
  readonly saveDailyTotals: (
    totals: DailyTotals,
    fetchedDates: ReadonlyArray<string>,
  ) => Effect.Effect<void, StorageError>
  readonly savePageIndexStatuses: (
    statuses: ReadonlyArray<PageIndexStatus>,
  ) => Effect.Effect<void, StorageError>
  readonly pruneIndexStatuses: (
    targetUrls: ReadonlyArray<string>,
  ) => Effect.Effect<number, StorageError>
  readonly addLogEntry: (
    entry: LogEntryInput,
  ) => Effect.Effect<LogEntry, StorageError>
  readonly capturePageBaselines: (
    entries: ReadonlyArray<RegistryEntry>,
    baselineDate: string,
  ) => Effect.Effect<BaselineCapture, StorageError>
  // Stamp that a sync run completed for this site. Every completed run stamps,
  // including one that fetched nothing — that run is exactly the one no other
  // table records, because `synced_day` only gains a row when a day is fetched.
  readonly recordSyncCheck: () => Effect.Effect<void, StorageError>

  // --- freshness / coverage queries ---
  readonly missingDailyTotalDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly missingSnapshotDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly recentlySyncedDates: (
    dates: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly syncedWithinHours: (
    maxAgeHours: number,
  ) => Effect.Effect<boolean, StorageError>
  readonly recentlyInspectedUrls: (
    targetUrls: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly snapshotDateRange: () => Effect.Effect<
    SnapshotDateRange,
    StorageError
  >
  readonly snapshotSummary: () => Effect.Effect<SnapshotSummary, StorageError>
  readonly latestSnapshotDate: () => Effect.Effect<string | null, StorageError>
  // The newest `synced_day.fetched_at` as an ISO 8601 instant: when Search
  // Console data last arrived for this site. Null when nothing is synced yet.
  readonly latestSyncedAt: () => Effect.Effect<string | null, StorageError>
  // The `sync_run.checked_at` stamp as an ISO 8601 instant: when a sync run for
  // this site last completed. Null until one has. Moves on every completed run,
  // where latestSyncedAt moves only on a run that fetched a day.
  readonly latestCheckedAt: () => Effect.Effect<string | null, StorageError>
  // The last date whose numbers are trusted as final (today − 3, UTC). Pure.
  readonly finalizationCutoff: () => Effect.Effect<string>

  // --- reads / analysis ---
  readonly historyWithPending: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<HistoryDay>, StorageError>
  readonly opportunityDigest: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<OpportunityDigest, StorageError>
  readonly targetPerformance: (
    targetUrl: string,
    inventoryTotal?: boolean,
  ) => Effect.Effect<RegistryPerformance, StorageError>
  readonly registryProgress: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<ReadonlyArray<RegistryProgress>, StorageError>
  readonly registryTargetProgress: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<ReadonlyArray<RegistryTargetProgress>, StorageError>
  readonly pagesWindowOverview: (
    windowDays?: number,
  ) => Effect.Effect<PagesWindowOverview, StorageError>
  readonly topQueries: (
    options?: TopQueriesOptions,
  ) => Effect.Effect<TopQueriesResult, StorageError>
  readonly listLog: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, StorageError>
  readonly metricsBetween: (
    targetUrl: string,
    start: string,
    end: string,
    includeBrand?: boolean,
  ) => Effect.Effect<Metrics, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Storage",
) {}

export const use = serviceUse(Service)

// --- pure helpers (ported verbatim from the legacy source) ---

const zeroMetrics: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

const dateDaysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

// The last date whose numbers we trust as final: today − 3 (UTC).
const finalizationCutoffValue = () =>
  dateDaysBefore(new Date().toISOString().slice(0, 10), 3)

const summariseMetrics = (days: ReadonlyArray<RegistryDay>): Metrics => {
  const impressions = days.reduce((total, day) => total + day.impressions, 0)
  const clicks = days.reduce((total, day) => total + day.clicks, 0)
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position:
      impressions > 0
        ? days.reduce((total, day) => total + day.position * day.impressions, 0) /
          impressions
        : 0,
  }
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

const positionBand = (position: number) =>
  position <= 3 ? "1–3" : position <= 5 ? "4–5" : "6–10"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const site = yield* CurrentSite.Service
    const resolved = yield* site.current()
    const databasePath = yield* site.databasePath()
    const origin = resolved.origin
    const brandPattern = `%${resolved.brandTerms[0]!.toLowerCase()}%`

    yield* Effect.sync(() =>
      mkdirSync(databasePath.slice(0, databasePath.lastIndexOf("/")), {
        recursive: true,
      }),
    )

    const sql = yield* SqliteClient.make({ filename: databasePath }).pipe(
      Effect.provide(Reactivity.layer),
    )

    const storageError =
      (operation: string) => (cause: SqlError.SqlError) =>
        new StorageError({ message: `Storage.${operation} failed`, cause })
    const mapErr =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
        Effect.mapError(effect, storageError(operation))

    // --- schema: run every `create table if not exists` + the synced_day
    // backfill once, on acquisition. ---
    const ddl = [
      `create table if not exists search_snapshot (
        date text not null,
        query text not null,
        page text not null,
        device text not null,
        country text not null,
        clicks integer not null,
        impressions integer not null,
        ctr real not null,
        position real not null,
        collected_at text not null default current_timestamp,
        primary key (date, query, page, device, country)
      )`,
      `create table if not exists page_baseline (
        target_url text primary key,
        baseline_date text not null,
        window_start text not null,
        window_end text not null,
        clicks integer not null,
        impressions integer not null,
        ctr real not null,
        position real not null,
        captured_at text not null default current_timestamp
      )`,
      `create table if not exists synced_day (
        date text primary key,
        rows integer not null,
        fetched_at text not null default current_timestamp
      )`,
      `create table if not exists site_daily (
        date text primary key,
        clicks integer not null,
        impressions integer not null,
        ctr real not null,
        position real not null,
        collected_at text not null default current_timestamp
      )`,
      `create table if not exists page_daily (
        date text not null,
        page text not null,
        clicks integer not null,
        impressions integer not null,
        ctr real not null,
        position real not null,
        collected_at text not null default current_timestamp,
        primary key (date, page)
      )`,
      `create table if not exists action_log (
        id integer primary key autoincrement,
        date text not null,
        path text not null,
        kind text not null,
        note text not null default '',
        created_at text not null default current_timestamp
      )`,
      `create table if not exists page_index_status (
        target_url text primary key,
        status text not null,
        verdict text not null,
        coverage_state text not null default '',
        inspected_at text not null default current_timestamp
      )`,
      // One row, pinned to id 1: this is a single per-site scalar, not a series,
      // and a run that fetched nothing has no day to hang its instant off — so
      // unlike latestSyncedAt it cannot be derived from `synced_day`. It lives in
      // the ledger rather than in a process variable because the hosted server
      // restarts on every deploy, and an in-memory stamp would come back reading
      // "never checked" over a site that has been checked all along.
      `create table if not exists sync_run (
        id integer primary key check (id = 1),
        checked_at text not null default current_timestamp
      )`,
    ]
    yield* Effect.forEach(ddl, (statement) => sql.unsafe(statement)).pipe(
      mapErr("initialize"),
    )
    yield* sql
      .unsafe(
        `insert into synced_day (date, rows)
         select date, count(*) from search_snapshot group by date
         on conflict(date) do nothing`,
      )
      .pipe(mapErr("initialize"))

    // --- internal implementations (fail with SqlError; wrapped at the
    // boundary below). ---

    const latestSnapshotDateI = Effect.gen(function* () {
      const rows = yield* sql<{ date: string | null }>`
        select max(date) as date from search_snapshot`
      return rows[0]?.date ?? null
    })

    // Daily history for the dashboard, read from the query-less site totals
    // (site_daily) so the numbers match Search Console's headline figures
    // exactly. Summing query-level rows (search_snapshot) under-reports the true
    // daily total because Google withholds its anonymized long-tail from the
    // breakdown — that detail belongs to the Queries and Opportunities views,
    // not this overview. site_daily covers every day we have data for (including
    // low-volume days where Google suppresses query rows entirely). A day is
    // flagged provisional by the finalization window, so the UI dims only what
    // Google is still revising.
    const historyWithPendingI = (limit = 28) =>
      Effect.gen(function* () {
        const rows = yield* sql<HistoryDay>`
          select date, impressions, clicks, ctr, position from site_daily order by date`
        const cutoff = finalizationCutoffValue()
        return rows
          .map((row) => ({ ...row, provisional: row.date > cutoff }))
          .slice(-limit) as ReadonlyArray<HistoryDay>
      })

    const opportunityDigestI = (entries: ReadonlyArray<RegistryEntry>) =>
      Effect.gen(function* () {
        const latestDate = yield* latestSnapshotDateI
        if (!latestDate) {
          return {
            latestDate: null,
            currentStart: null,
            previousStart: null,
            previousEnd: null,
            signals: [],
          }
        }
        const currentStart = dateDaysBefore(latestDate, 27)
        const previousEnd = dateDaysBefore(currentStart, 1)
        const previousStart = dateDaysBefore(previousEnd, 27)
        const windowRows = (start: string, end: string) =>
          sql<Opportunity>`
            select query, page, sum(impressions) as impressions, sum(clicks) as clicks,
                   sum(clicks) * 1.0 / sum(impressions) as ctr,
                   sum(position * impressions) * 1.0 / sum(impressions) as position
            from search_snapshot
            where date between ${start} and ${end} and lower(query) not like ${brandPattern}
            group by query, page`
        const current = yield* windowRows(currentStart, latestDate)
        const previous = yield* windowRows(previousStart, previousEnd)
        const previousByKey = new Map(
          previous.map((row) => [`${row.query} ${row.page}`, row]),
        )
        const registryKeywords = new Set(
          entries
            .filter((entry) => entry.keyword.trim())
            .map((entry) => entry.keyword.toLowerCase()),
        )
        const comparableCtr = new Map<string, number>()
        const comparableRows = current.filter(
          (row) => row.impressions >= 20 && row.position <= 10,
        )
        const siteMedianCtr = median(comparableRows.map((row) => row.ctr))
        for (const band of ["1–3", "4–5", "6–10"] as const) {
          const bandCtr = comparableRows
            .filter((row) => positionBand(row.position) === band)
            .map((row) => row.ctr)
          comparableCtr.set(band, bandCtr.length >= 3 ? median(bandCtr) : siteMedianCtr)
        }
        const signals: OpportunitySignal[] = []
        for (const row of current) {
          const prior = previousByKey.get(`${row.query} ${row.page}`) ?? null
          const mapped = registryKeywords.has(row.query.toLowerCase())
          if (
            row.impressions >= 20 &&
            row.position >= 4 &&
            row.position <= 20 &&
            row.ctr < 0.1
          ) {
            signals.push({
              kind: "striking-distance",
              label: row.query,
              query: row.query,
              page: row.page,
              pages: [row.page],
              current: row,
              previous: prior,
              mapped,
              recommendation: mapped
                ? "Improve the mapped page before creating another page."
                : "Check whether the ranking page satisfies intent before adding a new page.",
              score: row.impressions * (21 - row.position),
            })
          }
          const benchmark =
            row.position <= 10 ? comparableCtr.get(positionBand(row.position)) ?? 0 : 0
          if (
            row.position <= 10 &&
            row.impressions >= 50 &&
            benchmark > 0 &&
            row.ctr < benchmark * 0.8
          ) {
            signals.push({
              kind: "ctr",
              label: row.query,
              query: row.query,
              page: row.page,
              pages: [row.page],
              current: row,
              previous: prior,
              mapped,
              recommendation:
                "Test title, description, and snippet alignment; do not repeat keywords.",
              score: row.impressions * (benchmark - row.ctr),
            })
          }
        }
        const byQuery = new Map<string, Opportunity[]>()
        for (const row of current)
          byQuery.set(row.query, [...(byQuery.get(row.query) ?? []), row])
        const previousByQuery = new Map<string, Opportunity[]>()
        for (const row of previous)
          previousByQuery.set(row.query, [...(previousByQuery.get(row.query) ?? []), row])
        const combineRows = (rows: ReadonlyArray<Opportunity>): Metrics => {
          const impressions = rows.reduce((total, row) => total + row.impressions, 0)
          const clicks = rows.reduce((total, row) => total + row.clicks, 0)
          return {
            impressions,
            clicks,
            ctr: impressions > 0 ? clicks / impressions : 0,
            position:
              impressions > 0
                ? rows.reduce(
                    (total, row) => total + row.position * row.impressions,
                    0,
                  ) / impressions
                : 0,
          }
        }
        for (const [query, rows] of byQuery) {
          const pages = [...new Set(rows.map((row) => row.page))]
          const currentMetrics = combineRows(rows)
          const priorRows = previousByQuery.get(query) ?? []
          if (
            currentMetrics.impressions >= 20 &&
            !registryKeywords.has(query.toLowerCase())
          ) {
            const ranksOnRegisteredTarget = pages.some((page) =>
              entries.some((entry) => page === `${origin}${entry.targetUrl}`),
            )
            signals.push({
              kind: "new-demand",
              label: query,
              query,
              page: pages[0]!,
              pages,
              current: currentMetrics,
              previous: priorRows.length > 0 ? combineRows(priorRows) : null,
              mapped: false,
              recommendation: ranksOnRegisteredTarget
                ? "Review whether the existing ranking page satisfies this intent before adding a registry mapping."
                : "Cluster the phrase and map it only if no existing page satisfies the intent.",
              score: currentMetrics.impressions,
            })
          }
          if (pages.length < 2) continue
          signals.push({
            kind: "cannibalization",
            label: query,
            query,
            page: pages[0]!,
            pages,
            current: currentMetrics,
            previous: null,
            mapped: registryKeywords.has(query.toLowerCase()),
            recommendation:
              "Consolidate content and internal links, or clarify canonicals and page intent.",
            score: currentMetrics.impressions * pages.length,
          })
        }
        return {
          latestDate,
          currentStart,
          previousStart,
          previousEnd,
          signals: signals.sort((left, right) => right.score - left.score),
        }
      })

    // Per-target 28-day series for the Registry table. For inventory/PAGE
    // targets (no keyword rows) `inventoryTotal` is set, and we read the TRUE
    // page total from page_daily — the query-less daily totals that match
    // Search Console — because summing query rows (search_snapshot) under-reports
    // the page: Google withholds its anonymized long-tail from the breakdown.
    // Keyword targets keep the non-brand search_snapshot sum, which is the
    // intent of measuring a mapped keyword's own page footprint.
    const targetPerformanceI = (targetUrl: string, inventoryTotal = false) =>
      Effect.gen(function* () {
        const latestDate = yield* latestSnapshotDateI
        if (!latestDate) {
          return {
            days: [],
            total: zeroMetrics,
            last7: zeroMetrics,
            previous7: zeroMetrics,
          }
        }
        const start = dateDaysBefore(latestDate, 27)
        const page = `${origin}${targetUrl}`
        const rows = inventoryTotal
          ? yield* sql<RegistryDay>`
              select date, clicks, impressions, ctr, position
              from page_daily
              where page = ${page} and date between ${start} and ${latestDate}`
          : yield* sql<RegistryDay>`
              select date, sum(clicks) as clicks, sum(impressions) as impressions,
                     sum(clicks) * 1.0 / sum(impressions) as ctr,
                     sum(position * impressions) * 1.0 / sum(impressions) as position
              from search_snapshot
              where page = ${page} and date between ${start} and ${latestDate}
                and lower(query) not like ${brandPattern}
              group by date`
        const byDate = new Map(rows.map((row) => [row.date, row]))
        const days = Array.from({ length: 28 }, (_, index) => {
          const date = new Date(`${start}T00:00:00.000Z`)
          date.setUTCDate(date.getUTCDate() + index)
          const key = date.toISOString().slice(0, 10)
          return byDate.get(key) ?? { date: key, ...zeroMetrics }
        })
        return {
          days,
          total: summariseMetrics(days),
          last7: summariseMetrics(days.slice(-7)),
          previous7: summariseMetrics(days.slice(-14, -7)),
        }
      })

    const registryProgressI = (entries: ReadonlyArray<RegistryEntry>) =>
      Effect.gen(function* () {
        const latestDate = yield* latestSnapshotDateI
        const result: RegistryProgress[] = []
        for (const entry of entries) {
          const targetUrl = `${origin}${entry.targetUrl}`
          const baselineRows = yield* sql<Metrics>`
            select clicks, impressions, ctr, position from page_baseline where target_url = ${targetUrl}`
          const baselineRow = baselineRows[0] ?? null
          const progressStart = entry.publishedAt || entry.baselineDate
          if (!latestDate) {
            result.push({
              entry,
              latestDate,
              measuredFrom: null,
              target: zeroMetrics,
              keyword: zeroMetrics,
              baseline: baselineRow,
              state: "awaiting-data",
            })
            continue
          }
          if (!entry.keyword.trim()) {
            const windowStart = dateDaysBefore(latestDate, 27)
            result.push({
              entry,
              latestDate,
              measuredFrom: windowStart,
              target: zeroMetrics,
              keyword: zeroMetrics,
              baseline: null,
              state: "measuring",
            })
            continue
          }
          if (!progressStart || latestDate <= progressStart) {
            result.push({
              entry,
              latestDate,
              measuredFrom: progressStart || null,
              target: zeroMetrics,
              keyword: zeroMetrics,
              baseline: baselineRow,
              state: "awaiting-post-baseline",
            })
            continue
          }
          const windowStart = [dateDaysBefore(latestDate, 27), progressStart]
            .sort()
            .at(-1)!
          const targetRows = yield* sql<Metrics>`
            select coalesce(sum(clicks), 0) as clicks,
                   coalesce(sum(impressions), 0) as impressions,
                   case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
                   case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
            from search_snapshot
            where page = ${targetUrl} and date between ${windowStart} and ${latestDate} and lower(query) not like ${brandPattern}`
          const keywordRows = yield* sql<Metrics>`
            select coalesce(sum(clicks), 0) as clicks,
                   coalesce(sum(impressions), 0) as impressions,
                   case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
                   case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
            from search_snapshot
            where page = ${targetUrl} and lower(query) = lower(${entry.keyword}) and date between ${windowStart} and ${latestDate}`
          result.push({
            entry,
            latestDate,
            measuredFrom: windowStart,
            target: targetRows[0]!,
            keyword: keywordRows[0]!,
            baseline: baselineRow,
            state: "measuring",
          })
        }
        return result as ReadonlyArray<RegistryProgress>
      })

    const registryTargetProgressI = (entries: ReadonlyArray<RegistryEntry>) =>
      Effect.gen(function* () {
        const progress = yield* registryProgressI(entries)
        const indexRows = yield* sql<{
          target_url: string
          status: "indexed" | "not-indexed" | "unknown"
          coverage_state: string
          inspected_at: string
        }>`select target_url, status, coverage_state, inspected_at from page_index_status`
        const indexByUrl = new Map(indexRows.map((row) => [row.target_url, row]))
        const grouped = new Map<string, RegistryProgress[]>()
        for (const row of progress)
          grouped.set(row.entry.targetUrl, [
            ...(grouped.get(row.entry.targetUrl) ?? []),
            row,
          ])
        const targets: RegistryTargetProgress[] = []
        for (const [targetUrl, rows] of grouped) {
          const first = rows[0]!
          const inventoryOnly = rows.every((row) => !row.entry.keyword.trim())
          const performance = yield* targetPerformanceI(targetUrl, inventoryOnly)
          targets.push({
            entries: rows.map((row) => row.entry),
            targetUrl,
            latestDate: first.latestDate,
            measuredFrom: first.measuredFrom,
            target: performance.total,
            baseline: first.baseline,
            state: first.state,
            indexStatus: indexByUrl.get(`${origin}${targetUrl}`)?.status ?? "unknown",
            coverageState:
              indexByUrl.get(`${origin}${targetUrl}`)?.coverage_state || null,
            inspectedAt: indexByUrl.get(`${origin}${targetUrl}`)?.inspected_at ?? null,
          })
        }
        const priorityRank = (priority: string) =>
          /^P\d+$/.test(priority) ? Number(priority.slice(1)) : Number.POSITIVE_INFINITY
        const keywordCount = (target: RegistryTargetProgress) =>
          target.entries.filter((entry) => entry.keyword.trim()).length
        return targets.sort(
          (left, right) =>
            priorityRank(left.entries[0]?.priority ?? "") -
              priorityRank(right.entries[0]?.priority ?? "") ||
            keywordCount(right) - keywordCount(left) ||
            left.targetUrl.localeCompare(right.targetUrl),
        ) as ReadonlyArray<RegistryTargetProgress>
      })

    type Grouped = Metrics & { readonly page: string }

    const pagesWindowOverviewI = (windowDays = 28) =>
      Effect.gen(function* () {
        const latestDate = yield* latestSnapshotDateI
        const coverageRows = yield* sql<{ siteDays: number; pageDays: number }>`
          select (select count(*) from site_daily) as siteDays,
                 (select count(distinct date) from page_daily) as pageDays`
        const coverage = coverageRows[0] ?? { siteDays: 0, pageDays: 0 }
        if (!latestDate) {
          return {
            latestDate: null,
            currentStart: null,
            previousStart: null,
            previousEnd: null,
            totalsCoverage: coverage,
            rows: [],
          }
        }
        const currentStart = dateDaysBefore(latestDate, windowDays - 1)
        const previousEnd = dateDaysBefore(currentStart, 1)
        const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
        const snapshotWindow = (start: string, end: string, includeBrand: boolean) =>
          sql<Grouped>`
            select page, sum(impressions) as impressions, sum(clicks) as clicks,
                   sum(clicks) * 1.0 / sum(impressions) as ctr,
                   sum(position * impressions) * 1.0 / sum(impressions) as position
            from search_snapshot
            where date between ${start} and ${end} and (${includeBrand ? 1 : 0} = 1 or lower(query) not like ${brandPattern})
            group by page`
        const totalsWindow = (start: string, end: string) =>
          sql<Grouped>`
            select page, sum(impressions) as impressions, sum(clicks) as clicks,
                   sum(clicks) * 1.0 / sum(impressions) as ctr,
                   sum(position * impressions) * 1.0 / sum(impressions) as position
            from page_daily
            where date between ${start} and ${end}
            group by page`
        const asMap = (rows: ReadonlyArray<Grouped>) =>
          new Map(rows.map(({ page, ...metrics }) => [page, metrics as Metrics]))
        const nonBrandCurrent = asMap(
          yield* snapshotWindow(currentStart, latestDate, false),
        )
        const nonBrandPrevious = asMap(
          yield* snapshotWindow(previousStart, previousEnd, false),
        )
        const allCurrent = asMap(yield* snapshotWindow(currentStart, latestDate, true))
        const allPrevious = asMap(
          yield* snapshotWindow(previousStart, previousEnd, true),
        )
        const trueCurrent = asMap(yield* totalsWindow(currentStart, latestDate))
        const truePrevious = asMap(yield* totalsWindow(previousStart, previousEnd))
        const pages = [
          ...new Set([
            ...allCurrent.keys(),
            ...allPrevious.keys(),
            ...trueCurrent.keys(),
          ]),
        ]
        const rows = pages.map((page) => ({
          page,
          nonBrand: {
            current: nonBrandCurrent.get(page) ?? zeroMetrics,
            previous: nonBrandPrevious.get(page) ?? zeroMetrics,
          },
          allQueries: {
            current: allCurrent.get(page) ?? zeroMetrics,
            previous: allPrevious.get(page) ?? zeroMetrics,
          },
          trueTotals:
            trueCurrent.has(page) || truePrevious.has(page)
              ? {
                  current: trueCurrent.get(page) ?? zeroMetrics,
                  previous: truePrevious.get(page) ?? zeroMetrics,
                }
              : null,
        }))
        return {
          latestDate,
          currentStart,
          previousStart,
          previousEnd,
          totalsCoverage: coverage,
          rows,
        }
      })

    type GroupedQuery = Metrics & { readonly query: string; readonly page: string }

    const topQueriesI = (options: TopQueriesOptions = {}) =>
      Effect.gen(function* () {
        const {
          page,
          windowDays = 28,
          minImpressions = 0,
          includeBrand = false,
          limit = 50,
        } = options
        const latestDate = yield* latestSnapshotDateI
        if (!latestDate) {
          return {
            latestDate: null,
            currentStart: null,
            previousStart: null,
            previousEnd: null,
            rows: [],
          }
        }
        const currentStart = dateDaysBefore(latestDate, windowDays - 1)
        const previousEnd = dateDaysBefore(currentStart, 1)
        const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
        const windowRows = (start: string, end: string) =>
          sql<GroupedQuery>`
            select query, page, sum(impressions) as impressions, sum(clicks) as clicks,
                   sum(clicks) * 1.0 / sum(impressions) as ctr,
                   sum(position * impressions) * 1.0 / sum(impressions) as position
            from search_snapshot
            where date between ${start} and ${end}
              and (${includeBrand ? 1 : 0} = 1 or lower(query) not like ${brandPattern})
              and (${page ?? ""} = '' or page = ${page ?? ""})
            group by query, page`
        const current = yield* windowRows(currentStart, latestDate)
        const previous = new Map(
          (yield* windowRows(previousStart, previousEnd)).map((row) => [
            `${row.query} ${row.page}`,
            row,
          ]),
        )
        const rows = current
          .filter((row) => row.impressions >= minImpressions)
          .sort((left, right) => right.impressions - left.impressions)
          .slice(0, limit)
          .map(({ query, page: rowPage, ...metrics }) => {
            const prior = previous.get(`${query} ${rowPage}`)
            return {
              query,
              page: rowPage,
              current: metrics as Metrics,
              previous: prior
                ? {
                    impressions: prior.impressions,
                    clicks: prior.clicks,
                    ctr: prior.ctr,
                    position: prior.position,
                  }
                : null,
            }
          })
        return { latestDate, currentStart, previousStart, previousEnd, rows }
      })

    const metricsBetweenI = (
      targetUrl: string,
      start: string,
      end: string,
      includeBrand = false,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<Metrics>`
          select coalesce(sum(impressions), 0) as impressions,
                 coalesce(sum(clicks), 0) as clicks,
                 case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
                 case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
          from search_snapshot
          where page = ${`${origin}${targetUrl}`} and date between ${start} and ${end}
            and (${includeBrand ? 1 : 0} = 1 or lower(query) not like ${brandPattern})`
        return rows[0]!
      })

    const listLogI = (path?: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          date: string
          path: string
          kind: LogEntry["kind"]
          note: string
          created_at: string
        }>`
          select id, date, path, kind, note, created_at from action_log
          where (${path ?? ""} = '' or path = ${path ?? ""})
          order by date desc, id desc`
        return rows.map(({ created_at, ...rest }) => ({
          ...rest,
          createdAt: created_at,
        })) as ReadonlyArray<LogEntry>
      })

    // --- writes ---

    const saveSnapshotsI = (
      snapshots: ReadonlyArray<DailySnapshot>,
      fetchedDates: ReadonlyArray<string> = [
        ...new Set(snapshots.map((snapshot) => snapshot.date)),
      ],
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rowCounts = new Map<string, number>()
          for (const snapshot of snapshots)
            rowCounts.set(snapshot.date, (rowCounts.get(snapshot.date) ?? 0) + 1)
          for (const date of fetchedDates)
            yield* sql`delete from search_snapshot where date = ${date}`
          for (const snapshot of snapshots)
            yield* sql`
              insert into search_snapshot (date, query, page, device, country, clicks, impressions, ctr, position)
              values (${snapshot.date}, ${snapshot.query}, ${snapshot.page}, ${snapshot.device}, ${snapshot.country}, ${snapshot.clicks}, ${snapshot.impressions}, ${snapshot.ctr}, ${snapshot.position})
              on conflict(date, query, page, device, country) do update set
                clicks = excluded.clicks,
                impressions = excluded.impressions,
                ctr = excluded.ctr,
                position = excluded.position,
                collected_at = current_timestamp`
          for (const date of fetchedDates)
            yield* sql`
              insert into synced_day (date, rows) values (${date}, ${rowCounts.get(date) ?? 0})
              on conflict(date) do update set rows = excluded.rows, fetched_at = current_timestamp`
        }),
      )

    const saveDailyTotalsI = (
      totals: DailyTotals,
      fetchedDates: ReadonlyArray<string>,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const date of fetchedDates)
            yield* sql`delete from page_daily where date = ${date}`
          for (const row of totals.site)
            yield* sql`
              insert into site_daily (date, clicks, impressions, ctr, position)
              values (${row.date}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position})
              on conflict(date) do update set
                clicks = excluded.clicks, impressions = excluded.impressions,
                ctr = excluded.ctr, position = excluded.position, collected_at = current_timestamp`
          for (const row of totals.pages)
            yield* sql`
              insert into page_daily (date, page, clicks, impressions, ctr, position)
              values (${row.date}, ${row.page}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position})
              on conflict(date, page) do update set
                clicks = excluded.clicks, impressions = excluded.impressions,
                ctr = excluded.ctr, position = excluded.position, collected_at = current_timestamp`
        }),
      )

    const recordSyncCheckI = sql`
      insert into sync_run (id, checked_at) values (1, current_timestamp)
      on conflict(id) do update set checked_at = current_timestamp`

    const savePageIndexStatusesI = (statuses: ReadonlyArray<PageIndexStatus>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const status of statuses)
            yield* sql`
              insert into page_index_status (target_url, status, verdict, coverage_state)
              values (${status.targetUrl}, ${status.status}, ${status.verdict}, ${status.coverageState})
              on conflict(target_url) do update set
                status = excluded.status, verdict = excluded.verdict,
                coverage_state = excluded.coverage_state, inspected_at = current_timestamp`
        }),
      )

    const pruneIndexStatusesI = (targetUrls: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const keep = [...new Set(targetUrls)]
        const deleted =
          keep.length > 0
            ? yield* sql<{ target_url: string }>`
                delete from page_index_status where target_url not in ${sql.in(keep)} returning target_url`
            : yield* sql<{ target_url: string }>`
                delete from page_index_status returning target_url`
        return deleted.length
      })

    const addLogEntryI = (entry: LogEntryInput) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: number; created_at: string }>`
          insert into action_log (date, path, kind, note)
          values (${entry.date}, ${entry.path}, ${entry.kind}, ${entry.note})
          returning id, created_at`
        const row = rows[0]!
        return {
          id: row.id,
          date: entry.date,
          path: entry.path,
          kind: entry.kind,
          note: entry.note,
          createdAt: row.created_at,
        }
      })

    const capturePageBaselinesI = (
      entries: ReadonlyArray<RegistryEntry>,
      baselineDate: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const windowEndDate = new Date(`${baselineDate}T00:00:00.000Z`)
          windowEndDate.setUTCDate(windowEndDate.getUTCDate() - 3)
          const windowStartDate = new Date(windowEndDate)
          windowStartDate.setUTCDate(windowStartDate.getUTCDate() - 27)
          const windowStart = windowStartDate.toISOString().slice(0, 10)
          const windowEnd = windowEndDate.toISOString().slice(0, 10)
          const targets = [
            ...new Set(entries.map((entry) => `${origin}${entry.targetUrl}`)),
          ]
          for (const target of targets) {
            const rows = yield* sql<Metrics>`
              select coalesce(sum(clicks), 0) as clicks,
                     coalesce(sum(impressions), 0) as impressions,
                     case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
                     case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
              from search_snapshot
              where page = ${target} and date between ${windowStart} and ${windowEnd} and lower(query) not like ${brandPattern}`
            const row = rows[0]!
            yield* sql`
              insert into page_baseline (target_url, baseline_date, window_start, window_end, clicks, impressions, ctr, position)
              values (${target}, ${baselineDate}, ${windowStart}, ${windowEnd}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position})
              on conflict(target_url) do nothing`
          }
          return { targets: targets.length, windowStart, windowEnd }
        }),
      )

    // --- freshness / coverage queries ---

    const missingDailyTotalDatesI = (dates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`select date from site_daily`
        const stored = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => !stored.has(date))
      })

    const missingSnapshotDatesI = (dates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`select date from synced_day`
        const fetched = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => !fetched.has(date))
      })

    const recentlySyncedDatesI = (
      dates: ReadonlyArray<string>,
      maxAgeHours: number,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`
          select date from synced_day where fetched_at > datetime('now', ${`-${maxAgeHours} hours`})`
        const fresh = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => fresh.has(date))
      })

    const syncedWithinHoursI = (maxAgeHours: number) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ fresh: number }>`
          select exists(select 1 from synced_day where fetched_at > datetime('now', ${`-${maxAgeHours} hours`})) as fresh`
        return rows[0]?.fresh === 1
      })

    const recentlyInspectedUrlsI = (
      targetUrls: ReadonlyArray<string>,
      maxAgeHours: number,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ target_url: string }>`
          select target_url from page_index_status where inspected_at > datetime('now', ${`-${maxAgeHours} hours`})`
        const fresh = new Set(rows.map((row) => row.target_url))
        return [...new Set(targetUrls)].filter((targetUrl) => fresh.has(targetUrl))
      })

    const snapshotDateRangeI = Effect.gen(function* () {
      const rows = yield* sql<{ first: string | null; last: string | null }>`
        select min(date) as first, max(date) as last from synced_day`
      return rows[0] ?? { first: null, last: null }
    })

    // `fetched_at` is written by SQLite's current_timestamp, so it is UTC in
    // 'YYYY-MM-DD HH:MM:SS' form — lexicographically ordered, hence max().
    // strftime restates it as an ISO 8601 instant for the wire.
    const latestSyncedAtI = Effect.gen(function* () {
      const rows = yield* sql<{ fetched_at: string | null }>`
        select strftime('%Y-%m-%dT%H:%M:%SZ', max(fetched_at)) as fetched_at
        from synced_day`
      return rows[0]?.fetched_at ?? null
    })

    // `checked_at` is written by the same SQLite current_timestamp that stamps
    // `synced_day.fetched_at`, so the two instants a status report carries are
    // read off one clock and are directly comparable.
    const latestCheckedAtI = Effect.gen(function* () {
      const rows = yield* sql<{ checked_at: string | null }>`
        select strftime('%Y-%m-%dT%H:%M:%SZ', checked_at) as checked_at
        from sync_run where id = 1`
      return rows[0]?.checked_at ?? null
    })

    const snapshotSummaryI = Effect.gen(function* () {
      const rows = yield* sql<{ rows: number; dates: number }>`
        select (select count(*) from search_snapshot) as rows,
               (select count(*) from synced_day) as dates`
      return rows[0] ?? { rows: 0, dates: 0 }
    })

    return {
      saveSnapshots: (snapshots, fetchedDates) =>
        saveSnapshotsI(snapshots, fetchedDates).pipe(mapErr("saveSnapshots")),
      saveDailyTotals: (totals, fetchedDates) =>
        saveDailyTotalsI(totals, fetchedDates).pipe(mapErr("saveDailyTotals")),
      savePageIndexStatuses: (statuses) =>
        savePageIndexStatusesI(statuses).pipe(mapErr("savePageIndexStatuses")),
      pruneIndexStatuses: (targetUrls) =>
        pruneIndexStatusesI(targetUrls).pipe(mapErr("pruneIndexStatuses")),
      addLogEntry: (entry) => addLogEntryI(entry).pipe(mapErr("addLogEntry")),
      capturePageBaselines: (entries, baselineDate) =>
        capturePageBaselinesI(entries, baselineDate).pipe(
          mapErr("capturePageBaselines"),
        ),
      recordSyncCheck: () =>
        recordSyncCheckI.pipe(Effect.asVoid, mapErr("recordSyncCheck")),
      missingDailyTotalDates: (dates) =>
        missingDailyTotalDatesI(dates).pipe(mapErr("missingDailyTotalDates")),
      missingSnapshotDates: (dates) =>
        missingSnapshotDatesI(dates).pipe(mapErr("missingSnapshotDates")),
      recentlySyncedDates: (dates, maxAgeHours) =>
        recentlySyncedDatesI(dates, maxAgeHours).pipe(
          mapErr("recentlySyncedDates"),
        ),
      syncedWithinHours: (maxAgeHours) =>
        syncedWithinHoursI(maxAgeHours).pipe(mapErr("syncedWithinHours")),
      recentlyInspectedUrls: (targetUrls, maxAgeHours) =>
        recentlyInspectedUrlsI(targetUrls, maxAgeHours).pipe(
          mapErr("recentlyInspectedUrls"),
        ),
      snapshotDateRange: () => snapshotDateRangeI.pipe(mapErr("snapshotDateRange")),
      snapshotSummary: () => snapshotSummaryI.pipe(mapErr("snapshotSummary")),
      latestSnapshotDate: () =>
        latestSnapshotDateI.pipe(mapErr("latestSnapshotDate")),
      latestSyncedAt: () => latestSyncedAtI.pipe(mapErr("latestSyncedAt")),
      latestCheckedAt: () => latestCheckedAtI.pipe(mapErr("latestCheckedAt")),
      finalizationCutoff: () => Effect.sync(finalizationCutoffValue),
      historyWithPending: (limit) =>
        historyWithPendingI(limit).pipe(mapErr("historyWithPending")),
      opportunityDigest: (entries) =>
        opportunityDigestI(entries).pipe(mapErr("opportunityDigest")),
      targetPerformance: (targetUrl, inventoryTotal) =>
        targetPerformanceI(targetUrl, inventoryTotal).pipe(
          mapErr("targetPerformance"),
        ),
      registryProgress: (entries) =>
        registryProgressI(entries).pipe(mapErr("registryProgress")),
      registryTargetProgress: (entries) =>
        registryTargetProgressI(entries).pipe(mapErr("registryTargetProgress")),
      pagesWindowOverview: (windowDays) =>
        pagesWindowOverviewI(windowDays).pipe(mapErr("pagesWindowOverview")),
      topQueries: (options) => topQueriesI(options).pipe(mapErr("topQueries")),
      listLog: (path) => listLogI(path).pipe(mapErr("listLog")),
      metricsBetween: (targetUrl, start, end, includeBrand) =>
        metricsBetweenI(targetUrl, start, end, includeBrand).pipe(
          mapErr("metricsBetween"),
        ),
    } satisfies Interface
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CurrentSite.defaultLayer))

export * as Storage from "./storage"
