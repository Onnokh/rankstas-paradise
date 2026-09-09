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

import {
  type SiteVisitsDay,
  type SiteVisitsHour,
  type VisitsDays,
} from "../analytics/schema.ts"
import {
  foldKeyword,
  type KeywordMetric,
  type KeywordMetricSummary,
  type MonthlySearch,
} from "../keyword-metrics/schema.ts"
import { type KeywordProposal } from "../keyword-discovery/schema.ts"
import { type RevenueDay } from "../revenue/schema.ts"
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
  type DomainRatingDay,
  type EventWindowRow,
  type HistoryDay,
  type IndexCoverageDay,
  type LogEntry,
  type LogEntryInput,
  type Metrics,
  type Opportunity,
  type OpportunityDigest,
  type OpportunitySignal,
  type PagesWindowOverview,
  type PageVisitsOverview,
  type RegistryDay,
  type RegistryPerformance,
  type RegistryProgress,
  type RegistryTargetProgress,
  type RevenueSummary,
  StorageError,
  type SnapshotDateRange,
  type SnapshotSummary,
  type TopQueriesOptions,
  type TopQueriesResult,
  type VisitsSummary,
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
  // Record today's Indexed tally over the statuses held now, replacing any
  // reading already stored for the same day.
  //
  // Takes the Registry's keyword targets — the pages at least one Keyword aims
  // at, fully qualified — and not a count, for two reasons. The denominator is
  // not the row count of `page_index_status`: a page whose inspection failed has
  // no row there and is still a target. And the numerators are counted over
  // these URLs only, so an inventory-only page Google is right never to index
  // cannot hold the share down.
  readonly recordIndexCoverage: (
    keywordTargets: ReadonlyArray<string>,
  ) => Effect.Effect<void, StorageError>
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
  // Store what DataForSEO said about a batch of Keywords, replacing any answer
  // already held for the same keyword in the same Market. Unlike the Domain
  // Rating this is a cache and not a ledger: DataForSEO will answer the same
  // question again, and the number it reports is a rolling twelve-month
  // average, so an old row is not a historical reading — it is a stale one.
  readonly saveKeywordMetrics: (
    metrics: ReadonlyArray<KeywordMetric>,
  ) => Effect.Effect<void, StorageError>
  // Record today's Domain Rating, replacing any reading already stored for the
  // same day.
  readonly saveDomainRating: (
    rating: number,
    fetchedAt: string,
    license: string,
  ) => Effect.Effect<void, StorageError>
  // Record one fetch of canonical visit rows from the site's analytics provider:
  // every fetched date's page and event rows are replaced, site rows upserted,
  // and the dates stamped in `analytics_synced_day` with the provider they came
  // from. `source` is the provider name, kept so a switch of provider halfway
  // through the series stays visible; nothing queries by it.
  readonly saveVisits: (
    visits: VisitsDays,
    fetchedDates: ReadonlyArray<string>,
    source: string,
  ) => Effect.Effect<void, StorageError>
  // Replace one day's hourly site rows. Written by the today sync only: the
  // daily sync has no use for hours, and a finished day keeps the last ones.
  readonly saveHours: (
    date: string,
    hours: ReadonlyArray<SiteVisitsHour>,
    source: string,
  ) => Effect.Effect<void, StorageError>
  // Record one fetch of canonical revenue rows from the site's commerce
  // provider: every fetched date's row is replaced (a fetched day the
  // provider returned nothing for is a day with no sales, stored as zeros)
  // and the dates stamped in `revenue_synced_day`. `source` as for saveVisits.
  readonly saveRevenue: (
    days: ReadonlyArray<RevenueDay>,
    fetchedDates: ReadonlyArray<string>,
    source: string,
  ) => Effect.Effect<void, StorageError>

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
  // The visits twins of missingSnapshotDates / recentlySyncedDates /
  // latestSyncedAt, over `analytics_synced_day`.
  readonly missingVisitDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly recentlySyncedVisitDates: (
    dates: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly latestVisitsSyncedAt: () => Effect.Effect<string | null, StorageError>
  // The revenue twins, over `revenue_synced_day`.
  readonly missingRevenueDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly recentlySyncedRevenueDates: (
    dates: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly latestRevenueSyncedAt: () => Effect.Effect<string | null, StorageError>
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
  // The newest stored reading, or null when the site has none.
  readonly latestDomainRating: () => Effect.Effect<
    { readonly rating: number; readonly fetchedAt: string; readonly license: string } | null,
    StorageError
  >
  // Every stored Keyword metric for one Market, keyword order, WITHOUT the
  // monthly series. Reads only what is on disk and never reaches DataForSEO, so
  // a report can join volume onto its rows without a caller waiting on a third
  // party. A Market change leaves the old Market's rows in place and simply
  // stops reading them, so switching back does not have to be paid for twice.
  //
  // The series is left behind on purpose. DataForSEO returns about 94 months a
  // keyword, and the Opportunity digest calls this on every dashboard load to
  // use three scalars — decoding the series here would parse megabytes of JSON
  // that no caller reads. It stays in the column for the surface that wants it.
  readonly keywordMetrics: (
    locationCode: number,
    languageCode: string,
  ) => Effect.Effect<ReadonlyArray<KeywordMetricSummary>, StorageError>
  // The stored monthly series for one Market, keyed by folded keyword. Read
  // separately from the scalars above because this is the part that costs
  // something: it is the whole eight-year history DataForSEO sends.
  readonly keywordMonthlySearches: (
    locationCode: number,
    languageCode: string,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<MonthlySearch>>, StorageError>
  // Store proposed Keywords, keeping any status already recorded for one. The
  // status is deliberately not overwritten: a discovery run that finds a
  // keyword the reader already dismissed must not resurrect it, and a run is
  // the one thing likely to find it again.
  readonly saveKeywordProposals: (
    proposals: ReadonlyArray<KeywordProposal>,
  ) => Effect.Effect<void, StorageError>
  // Every Proposal for one Market, whatever its status. Filtering by status is
  // left to the caller, which also has to remove the ones the Registry has
  // since taken — a question this table cannot answer.
  readonly keywordProposals: (
    locationCode: number,
    languageCode: string,
  ) => Effect.Effect<ReadonlyArray<KeywordProposal>, StorageError>
  // Mark Proposals dismissed; returns how many rows changed. A keyword with no
  // row is not an error — a caller dismissing a list should not have to know
  // which of it was ever proposed.
  readonly dismissKeywordProposals: (
    keywords: ReadonlyArray<string>,
    locationCode: number,
    languageCode: string,
  ) => Effect.Effect<number, StorageError>
  // The stored Domain Rating series, oldest first.
  readonly domainRatingHistory: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<DomainRatingDay>, StorageError>
  // The stored Indexed series, oldest first.
  readonly indexCoverageHistory: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<IndexCoverageDay>, StorageError>
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
  // --- visits reads (empty, never failing on absence, for a site without a
  // provider: the tables exist for every site) ---
  readonly visitsSummary: () => Effect.Effect<VisitsSummary, StorageError>
  // Daily site visits, oldest first, the newest `limit` days.
  readonly visitsHistory: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<SiteVisitsDay>, StorageError>
  // One day's canonical rows — the site row, its pages, its events — as the
  // provider gave them. Empty for a day never synced.
  readonly visitsOfDay: (date: string) => Effect.Effect<VisitsDays, StorageError>
  // One day's hourly site rows, whatever hours were written, hour ascending.
  readonly hoursOfDay: (
    date: string,
  ) => Effect.Effect<ReadonlyArray<SiteVisitsHour>, StorageError>
  // When one day was last fetched from the provider, or null if never.
  readonly visitsSyncedAt: (
    date: string,
  ) => Effect.Effect<string | null, StorageError>
  // Per-page visits over a current/previous window. `endDate` anchors the
  // window; callers pass the Search Console latest date so both ledgers
  // describe the same days. Defaults to the newest visits day.
  readonly pageVisitsOverview: (
    windowDays?: number,
    endDate?: string,
  ) => Effect.Effect<PageVisitsOverview, StorageError>
  // Per-event counts over the same kind of window.
  readonly eventWindow: (
    windowDays?: number,
    endDate?: string,
  ) => Effect.Effect<ReadonlyArray<EventWindowRow>, StorageError>
  // --- revenue reads (empty, never failing on absence, for a site without a
  // commerce provider) ---
  readonly revenueSummary: () => Effect.Effect<RevenueSummary, StorageError>
  // The synced days from `start` to `end` inclusive, date ascending. Days
  // never fetched are absent, not zero, so a client can tell "no sales" from
  // "not synced".
  readonly revenueDays: (
    start: string,
    end: string,
  ) => Effect.Effect<ReadonlyArray<RevenueDay>, StorageError>
  // When the sync last wrote that one day's revenue rows, as an ISO 8601
  // instant; null for a day never fetched. The revenue twin of visitsSyncedAt,
  // and how a caller tells "no sales" from "not synced yet".
  readonly revenueSyncedAt: (
    date: string,
  ) => Effect.Effect<string | null, StorageError>
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

// --- Operator queries ---
//
// Search Console reports a `site:` search as an ordinary Query row with
// impressions: `(shadertown.com) (site:sleevy.app or site:www.shadertown.com)`
// arrived twice on one site. Nobody searched for that phrase — it is the trace
// of somebody auditing a domain in Google — so read as demand it invents an
// Opportunity, most visibly a new-demand one, that no page could ever satisfy.
// It also becomes a billed row the day a keyword-metrics vendor is wired in.
//
// Ruled out at read time, beside the brand filter, rather than dropped at
// ingest: a kept row can be reconsidered when this rule turns out to be wrong,
// and Brand query already works exactly this way — a view over the ledger,
// never a deletion.
//
// The boundary is deliberate and narrow. An Operator query leaves Opportunity
// detection and any surface that offers Queries as keyword candidates; it stays
// in all-queries, in non-brand, and in true totals. All-queries is defined as a
// mechanical sum over the stored per-query rows, and true totals come from
// Google's query-less daily figures, which we could not change if we wanted to.
// A headline number that no longer reconciles with Search Console is a worse
// fault than a Query row nobody would ever plan against.
//
// The token list is short on purpose. A natural search term essentially never
// holds an operator token followed by a colon, so the whole false-positive risk
// sits in which tokens are listed: `define`, `before`, `after` and bare schemes
// like `https` are left out because a person could plausibly type them. The
// token must also begin a word, or `opposite:` would read as `site:`.
const operatorTokens = [
  "site",
  "inurl",
  "intitle",
  "intext",
  "allintitle",
  "allinurl",
  "allintext",
  "cache",
  "related",
  "filetype",
] as const

const operatorQueryPattern = new RegExp(
  `(^|[^a-z0-9])(${operatorTokens.join("|")}):`,
  "i",
)

export const isOperatorQuery = (query: string): boolean =>
  operatorQueryPattern.test(query)

// A stored `monthly_searches` value read back into rows. Anything this cannot
// read yields an empty series: the column is written by this domain and always
// holds a JSON array, so a value that fails here is a hand-edited or truncated
// row, and the honest answer for it is "no history" rather than a failed read
// of the volume beside it.
const parseMonthlySearches = (stored: string): ReadonlyArray<MonthlySearch> => {
  try {
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry: unknown) => {
      const month = entry as Partial<MonthlySearch>
      return typeof month?.year === "number" &&
        typeof month?.month === "number" &&
        typeof month?.searchVolume === "number"
        ? [{ year: month.year, month: month.month, searchVolume: month.searchVolume }]
        : []
    })
  } catch {
    return []
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const site = yield* CurrentSite.Service
    const resolved = yield* site.current()
    const databasePath = yield* site.databasePath()
    const origin = resolved.origin

    yield* Effect.sync(() =>
      mkdirSync(databasePath.slice(0, databasePath.lastIndexOf("/")), {
        recursive: true,
      }),
    )

    const sql = yield* SqliteClient.make({ filename: databasePath }).pipe(
      Effect.provide(Reactivity.layer),
    )

    // Non-brand is all-queries with every Brand query filtered out, so every
    // configured brand term gets its own `not like` — a site lists its
    // misspellings, product names and domain variants alongside its name, and
    // a term left unfiltered inflates non-brand clicks and impressions and can
    // read the site's own brand searches as new-demand Opportunities. Blank
    // terms are dropped so they never compile to `like '%%'`, which would
    // exclude every Query; `sql.and([])` compiles to `1=1`, so a site with no
    // brand terms filters nothing rather than everything.
    const nonBrandFilter = sql.and(
      resolved.brandTerms
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length > 0)
        .map((term) => sql`lower(query) not like ${`%${term}%`}`),
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
      // One Indexed tally per calendar day, over the pages `page_index_status`
      // holds. That table keeps one row per target and overwrites it on every
      // inspection, so it can only ever answer "how many are indexed now" —
      // this is where "how many were indexed then" comes from. Like
      // domain_rating it cannot be backfilled, and it is keyed by date rather
      // than by fetch instant so several syncs in one day settle on one reading.
      `create table if not exists index_coverage (
        date text primary key,
        keyword_targets integer not null,
        indexed integer not null,
        not_indexed integer not null,
        recorded_at text not null default current_timestamp
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
      // One Domain Rating per calendar day. Ahrefs' free endpoint reports only
      // the present value, so this series cannot be backfilled — it is worth
      // exactly as much as the number of days it has been recording. Keyed by
      // date (not by fetch instant) so several syncs in one day settle on one
      // reading instead of inflating the series.
      `create table if not exists domain_rating (
        date text primary key,
        rating real not null,
        fetched_at text not null,
        license text not null default ''
      )`,
      // What DataForSEO says about a Keyword in one Market. Keyed by the three
      // things that identify the question — keyword, country, language — so a
      // site that changes Market keeps both answers and a shared keyword is
      // still asked once per Market.
      //
      // A cache, not a ledger: every number here can be asked for again, and
      // `search_volume` is a rolling twelve-month average, so yesterday's row
      // is not a reading of yesterday. `monthly_searches` is the one part with
      // history in it, stored as the JSON array DataForSEO sends rather than as
      // rows, because nothing queries inside it — it is read whole, for one
      // keyword, to answer whether demand is seasonal.
      //
      // Every metric column is nullable, and null means "not told" rather than
      // zero. `difficulty` and `intent` are null for a whole Market when its
      // country is served by Google Ads (see ../keyword-metrics/market.ts).
      `create table if not exists keyword_metric (
        keyword text not null,
        location_code integer not null,
        language_code text not null,
        search_volume integer,
        difficulty integer,
        cost_per_click real,
        competition real,
        intent text,
        monthly_searches text not null default '[]',
        fetched_at text not null,
        primary key (keyword, location_code, language_code)
      )`,
      // Keywords an expansion found that this Site does not have yet, and what
      // DataForSEO said about them at that moment. The metrics are duplicated
      // from keyword_metric on purpose: that table is a cache which is re-asked
      // and overwritten, and these numbers are the reason a keyword was
      // proposed. Losing them to a refresh would leave a row whose rationale no
      // longer matches the row.
      //
      // There is no `accepted` status — see ../keyword-discovery/schema.ts.
      `create table if not exists keyword_proposal (
        keyword text not null,
        location_code integer not null,
        language_code text not null,
        seed text not null,
        source text not null,
        search_volume integer,
        difficulty integer,
        cost_per_click real,
        competition real,
        intent text,
        status text not null default 'proposed',
        discovered_at text not null,
        primary key (keyword, location_code, language_code)
      )`,
      // The analytics provider's series in canonical form (see
      // ../analytics/schema.ts). Vendor-neutral on purpose: no table or column
      // is named after a product, so a site can move from one provider to
      // another and keep its history. `source` records which provider wrote a
      // row, so such a move stays visible; nothing queries by it. `page` is a
      // path, unlike page_daily's full URL, because that is what analytics
      // vendors report and what the registry keys targets by.
      `create table if not exists analytics_site_daily (
        date text primary key,
        pageviews integer not null,
        visits integer not null,
        visitors integer not null,
        source text not null,
        collected_at text not null default current_timestamp
      )`,
      `create table if not exists analytics_page_daily (
        date text not null,
        page text not null,
        pageviews integer not null,
        visits integer not null,
        source text not null,
        collected_at text not null default current_timestamp,
        primary key (date, page)
      )`,
      `create table if not exists analytics_event_daily (
        date text not null,
        name text not null,
        occurrences integer not null,
        source text not null,
        collected_at text not null default current_timestamp,
        primary key (date, name)
      )`,
      // The day in progress by the hour, for the Today view. Only the today
      // sync writes here, replacing the day's rows each time; nothing reads it
      // for any other purpose, so a finished day's hours are simply history.
      `create table if not exists analytics_site_hourly (
        date text not null,
        hour integer not null,
        pageviews integer not null,
        visits integer not null,
        visitors integer not null,
        source text not null,
        collected_at text not null default current_timestamp,
        primary key (date, hour)
      )`,
      // The visits twin of synced_day: which dates have been fetched from the
      // provider, and when, so a sync fetches only what is missing or stale.
      `create table if not exists analytics_synced_day (
        date text primary key,
        source text not null,
        fetched_at text not null default current_timestamp
      )`,
      // The commerce provider's series in canonical form (see
      // ../revenue/schema.ts), vendor-neutral on the same terms as the
      // analytics tables. Amounts are in the currency's minor unit.
      `create table if not exists revenue_site_daily (
        date text primary key,
        orders integer not null,
        revenue integer not null,
        net integer not null,
        currency text not null,
        source text not null,
        collected_at text not null default current_timestamp
      )`,
      `create table if not exists revenue_synced_day (
        date text primary key,
        source text not null,
        fetched_at text not null default current_timestamp
      )`,
    ]
    // One shape change to live through, before the DDL runs. `index_coverage`
    // shipped counting every tracked page and now counts the Registry's keyword
    // targets, and `create table if not exists` is a no-op over the old table —
    // so a deployment that ran the first version answered every registry read
    // with "no such column: keyword_targets" until this.
    //
    // Dropped rather than renamed. The old rows' numerators are counted over the
    // other population, so they are not convertible, and a series that mixes two
    // populations is worse than one that starts over: at most one day of the
    // wrong measurement is lost, and the series was never backfillable anyway.
    const coverageColumns = yield* sql<{ name: string }>`
      select name from pragma_table_info('index_coverage')`.pipe(
      mapErr("initialize"),
    )
    if (coverageColumns.some((column) => column.name === "tracked")) {
      yield* sql.unsafe(`drop table index_coverage`).pipe(mapErr("initialize"))
    }

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
        // Every one of the four Opportunity kinds is derived from these rows,
        // so dropping Operator queries here — and only here — keeps them out of
        // all four, and out of the CTR benchmark the kinds are measured
        // against, while leaving every metric read untouched. SQLite's `like`
        // has no word boundary, so the token test is a regular expression in
        // TypeScript rather than another SQL fragment beside `nonBrandFilter`.
        const windowRows = (start: string, end: string) =>
          Effect.map(
            sql<Opportunity>`
              select query, page, sum(impressions) as impressions, sum(clicks) as clicks,
                     sum(clicks) * 1.0 / sum(impressions) as ctr,
                     sum(position * impressions) * 1.0 / sum(impressions) as position
              from search_snapshot
              where date between ${start} and ${end} and ${nonBrandFilter}
              group by query, page`,
            (rows) => rows.filter((row) => !isOperatorQuery(row.query)),
          )
        const current = yield* windowRows(currentStart, latestDate)
        const previous = yield* windowRows(previousStart, previousEnd)

        // The Keyword metrics for the Site's Market, keyed by folded keyword.
        // Read here rather than passed in: this store already resolves the
        // Site's origin and brand terms from CurrentSite, and the Market is the
        // same move — so no caller has to learn about DataForSEO to get a
        // better-ranked digest. A Site with no Market, or one whose metrics
        // have never been fetched, simply gets an empty map and the
        // impression-only behaviour this had before.
        const demand = new Map(
          (resolved.market
            ? yield* keywordMetricsI(
                resolved.market.locationCode,
                resolved.market.languageCode,
              )
            : []
          ).map((metric) => [metric.keyword, metric]),
        )
        const demandFor = (query: string) => {
          const metric = demand.get(foldKeyword(query))
          return metric
            ? {
                searchVolume: metric.searchVolume,
                difficulty: metric.difficulty,
                intent: metric.intent,
              }
            : undefined
        }

        // How much demand a signal is ranked by.
        //
        // Impressions alone are the wrong weight for three of the four kinds,
        // and the reason is structural: impressions at position 18 are tiny,
        // because almost nobody reaches the second page of results. A term with
        // ten thousand monthly searches stuck at 18 can report fewer
        // impressions in a month than a term with two hundred searches sitting
        // at 5 — so an impression-weighted striking-distance score
        // systematically buries exactly the terms it exists to find.
        //
        // Search volume is the demand behind the query rather than the traffic
        // the current ranking happens to catch, so it is the honest weight. The
        // larger of the two is taken, never the volume alone: volume is scoped
        // to one Market, while impressions are counted worldwide, so a site
        // that draws more impressions than its Market's volume is not
        // over-reporting — it is ranking outside that Market too. Taking the
        // max means learning a keyword's volume can only ever promote an
        // under-observed term, never demote a well-observed one.
        const rankingWeight = (query: string, impressions: number) => {
          const volume = demand.get(foldKeyword(query))?.searchVolume
          return typeof volume === "number" && volume > impressions
            ? volume
            : impressions
        }

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
              // The kind this weighting was written for: everything here sits
              // between positions 4 and 20, so the observed impressions are
              // the least trustworthy signal of how much the term is worth.
              score: rankingWeight(row.query, row.impressions) * (21 - row.position),
              demand: demandFor(row.query),
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
              // Deliberately still weighted by impressions, unlike the other
              // three kinds. This score estimates the clicks being lost on
              // appearances the site *already* has, and every one of these rows
              // ranks in the top ten — so the observed impressions are the
              // right number, and search volume would answer a different
              // question.
              score: row.impressions * (benchmark - row.ctr),
              demand: demandFor(row.query),
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
              // A phrase the site is not planning for is usually ranking badly
              // by definition, so its impressions understate it for the same
              // reason striking-distance's do.
              score: rankingWeight(query, currentMetrics.impressions),
              demand: demandFor(query),
            })
          }
          // Same impression floor as the other kinds: a query split across
          // pages at a handful of impressions is long-tail noise, not a
          // cannibalization problem worth a signal.
          if (pages.length < 2 || currentMetrics.impressions < 20) continue
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
            // Two pages splitting a high-demand term is a worse problem than
            // two pages splitting a rare one, whatever the impressions each
            // currently draws.
            score: rankingWeight(query, currentMetrics.impressions) * pages.length,
            demand: demandFor(query),
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
                and ${nonBrandFilter}
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
            where page = ${targetUrl} and date between ${windowStart} and ${latestDate} and ${nonBrandFilter}`
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
            where date between ${start} and ${end} and (${includeBrand ? 1 : 0} = 1 or ${nonBrandFilter})
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
              and (${includeBrand ? 1 : 0} = 1 or ${nonBrandFilter})
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
            and (${includeBrand ? 1 : 0} = 1 or ${nonBrandFilter})`
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
          // A day Google has no rows for is a day with no impressions, and it
          // has to be recorded as such. Without this the date never enters
          // site_daily, so `missingDailyTotalDates` reports it missing again on
          // the next sync — and every sync after that, forever. A quiet site can
          // spend minutes and a large slice of the API quota re-asking about the
          // same few hundred empty days on every run.
          //
          // `do nothing` on conflict: a stored reading is never overwritten with
          // zeros, so a transient empty response cannot erase real data.
          const returned = new Set(totals.site.map((row) => row.date))
          for (const date of fetchedDates)
            if (!returned.has(date))
              yield* sql`
                insert into site_daily (date, clicks, impressions, ctr, position)
                values (${date}, 0, 0, 0, 0)
                on conflict(date) do nothing`
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

    // `date('now')` is UTC, matching how every other date in this ledger is
    // keyed, so a reading does not land on a different day than the totals
    // fetched beside it.
    const saveKeywordProposalsI = (proposals: ReadonlyArray<KeywordProposal>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const proposal of proposals)
            yield* sql`
              insert into keyword_proposal (
                keyword, location_code, language_code, seed, source, search_volume,
                difficulty, cost_per_click, competition, intent, status, discovered_at
              ) values (
                ${proposal.keyword}, ${proposal.locationCode}, ${proposal.languageCode},
                ${proposal.seed}, ${proposal.source}, ${proposal.searchVolume},
                ${proposal.difficulty}, ${proposal.costPerClick}, ${proposal.competition},
                ${proposal.intent}, ${proposal.status}, ${proposal.discoveredAt}
              )
              on conflict(keyword, location_code, language_code) do update set
                seed = excluded.seed,
                source = excluded.source,
                search_volume = excluded.search_volume,
                difficulty = excluded.difficulty,
                cost_per_click = excluded.cost_per_click,
                competition = excluded.competition,
                intent = excluded.intent,
                discovered_at = excluded.discovered_at`
          // `status` is absent from that update list, so a dismissal survives
          // being found again. See the interface for why that is the point.
        }),
      )

    const keywordProposalsI = (locationCode: number, languageCode: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          keyword: string
          seed: string
          source: string
          searchVolume: number | null
          difficulty: number | null
          costPerClick: number | null
          competition: number | null
          intent: string | null
          status: string
          discoveredAt: string
        }>`
          select keyword,
                 seed,
                 source,
                 search_volume as "searchVolume",
                 difficulty,
                 cost_per_click as "costPerClick",
                 competition,
                 intent,
                 status,
                 discovered_at as "discoveredAt"
          from keyword_proposal
          where location_code = ${locationCode} and language_code = ${languageCode}
          order by search_volume desc, keyword`
        return rows.map((row) => ({
          ...row,
          locationCode,
          languageCode,
        })) as ReadonlyArray<KeywordProposal>
      })

    const dismissKeywordProposalsI = (
      keywords: ReadonlyArray<string>,
      locationCode: number,
      languageCode: string,
    ) =>
      Effect.gen(function* () {
        let dismissed = 0
        // One statement a keyword rather than an `in` list: the count has to be
        // the number of rows that actually changed, and a keyword already
        // dismissed changes nothing.
        for (const keyword of keywords) {
          const rows = yield* sql<{ keyword: string }>`
            update keyword_proposal
            set status = 'dismissed'
            where keyword = ${keyword}
              and location_code = ${locationCode}
              and language_code = ${languageCode}
              and status <> 'dismissed'
            returning keyword`
          dismissed += rows.length
        }
        return dismissed
      })

    const saveDomainRatingI = (rating: number, fetchedAt: string, license: string) => sql`
      insert into domain_rating (date, rating, fetched_at, license)
      values (date('now'), ${rating}, ${fetchedAt}, ${license})
      on conflict(date) do update set
        rating = excluded.rating,
        fetched_at = excluded.fetched_at,
        license = excluded.license`

    const latestDomainRatingI = Effect.gen(function* () {
      const rows = yield* sql<{
        rating: number
        fetchedAt: string
        license: string
      }>`select rating, fetched_at as "fetchedAt", license from domain_rating
         order by date desc limit 1`
      return rows[0] ?? null
    })

    const domainRatingHistoryI = (limit = 180) =>
      Effect.gen(function* () {
        const rows = yield* sql<DomainRatingDay>`
          select date, rating from domain_rating order by date`
        return rows.slice(-limit) as ReadonlyArray<DomainRatingDay>
      })

    // One statement per keyword inside one transaction, matching how the other
    // batch writes here work. `monthly_searches` is serialized rather than
    // spread across rows because it is read whole or not at all.
    const saveKeywordMetricsI = (metrics: ReadonlyArray<KeywordMetric>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const metric of metrics)
            yield* sql`
              insert into keyword_metric (
                keyword, location_code, language_code, search_volume, difficulty,
                cost_per_click, competition, intent, monthly_searches, fetched_at
              ) values (
                ${metric.keyword}, ${metric.locationCode}, ${metric.languageCode},
                ${metric.searchVolume}, ${metric.difficulty}, ${metric.costPerClick},
                ${metric.competition}, ${metric.intent},
                ${JSON.stringify(metric.monthlySearches)}, ${metric.fetchedAt}
              )
              on conflict(keyword, location_code, language_code) do update set
                search_volume = excluded.search_volume,
                difficulty = excluded.difficulty,
                cost_per_click = excluded.cost_per_click,
                competition = excluded.competition,
                intent = excluded.intent,
                monthly_searches = excluded.monthly_searches,
                fetched_at = excluded.fetched_at`
        }),
      )

    // `monthly_searches` is not in the select list, so the ~94 months a row
    // holds are never read off the disk, let alone parsed.
    const keywordMetricsI = (locationCode: number, languageCode: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          keyword: string
          searchVolume: number | null
          difficulty: number | null
          costPerClick: number | null
          competition: number | null
          intent: string | null
          fetchedAt: string
        }>`
          select keyword,
                 search_volume as "searchVolume",
                 difficulty,
                 cost_per_click as "costPerClick",
                 competition,
                 intent,
                 fetched_at as "fetchedAt"
          from keyword_metric
          where location_code = ${locationCode} and language_code = ${languageCode}
          order by keyword`
        return rows.map((row) => ({
          ...row,
          locationCode,
          languageCode,
        })) as ReadonlyArray<KeywordMetricSummary>
      })

    // The monthly series for one Market, keyed by folded keyword. Its own read
    // because it is the expensive part: about 94 months a keyword, and only the
    // surfaces that answer a seasonality or trend question want it.
    const keywordMonthlySearchesI = (locationCode: number, languageCode: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ keyword: string; monthlySearches: string }>`
          select keyword, monthly_searches as "monthlySearches"
          from keyword_metric
          where location_code = ${locationCode} and language_code = ${languageCode}
          order by keyword`
        return new Map(
          rows.map((row) => [
            row.keyword,
            // A row this domain wrote always holds a JSON array. A row it
            // cannot parse reads as no history rather than failing the whole
            // read: the series is supplementary, and losing it must not cost a
            // caller the answer it came for.
            parseMonthlySearches(row.monthlySearches),
          ]),
        ) as ReadonlyMap<string, ReadonlyArray<MonthlySearch>>
      })

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

    // Counted in SQL over the caller's own URLs, so the tally cannot disagree
    // with the statuses the same run just wrote, and cannot count a page the
    // Registry aims no Keyword at.
    //
    // A Registry with no keyword targets at all still records a row of zeros:
    // "nothing is planned here" is a reading, and a missing day would read as a
    // sync that never ran.
    const recordIndexCoverageI = (keywordTargets: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const urls = [...new Set(keywordTargets)]
        type Tally = { indexed: number; notIndexed: number }
        const rows =
          urls.length > 0
            ? yield* sql<Tally>`
                select
                  count(*) filter (where status = 'indexed') as indexed,
                  count(*) filter (where status = 'not-indexed') as "notIndexed"
                from page_index_status where target_url in ${sql.in(urls)}`
            : []
        const tally = rows[0] ?? { indexed: 0, notIndexed: 0 }
        yield* sql`
          insert into index_coverage (date, keyword_targets, indexed, not_indexed)
          values (date('now'), ${urls.length}, ${tally.indexed}, ${tally.notIndexed})
          on conflict(date) do update set
            keyword_targets = excluded.keyword_targets,
            indexed = excluded.indexed,
            not_indexed = excluded.not_indexed,
            recorded_at = current_timestamp`
      })

    const indexCoverageHistoryI = (limit = 180) =>
      Effect.gen(function* () {
        const rows = yield* sql<IndexCoverageDay>`
          select date, keyword_targets as "keywordTargets", indexed,
                 not_indexed as "notIndexed"
          from index_coverage order by date`
        return rows.slice(-limit) as ReadonlyArray<IndexCoverageDay>
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
              where page = ${target} and date between ${windowStart} and ${windowEnd} and ${nonBrandFilter}`
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

    // --- visits (canonical analytics rows; see ../analytics/schema.ts) ---

    const saveVisitsI = (
      visits: VisitsDays,
      fetchedDates: ReadonlyArray<string>,
      source: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const date of fetchedDates) {
            yield* sql`delete from analytics_page_daily where date = ${date}`
            yield* sql`delete from analytics_event_daily where date = ${date}`
          }
          // A fetched day the provider returned no site row for is a day with
          // no visits, and it is recorded as such — otherwise the date reads as
          // missing on every later sync (the trap saveDailyTotals also avoids).
          const returned = new Set(visits.site.map((row) => row.date))
          for (const date of fetchedDates)
            if (!returned.has(date))
              yield* sql`
                insert into analytics_site_daily (date, pageviews, visits, visitors, source)
                values (${date}, 0, 0, 0, ${source})
                on conflict(date) do nothing`
          for (const row of visits.site)
            yield* sql`
              insert into analytics_site_daily (date, pageviews, visits, visitors, source)
              values (${row.date}, ${row.pageviews}, ${row.visits}, ${row.visitors}, ${source})
              on conflict(date) do update set
                pageviews = excluded.pageviews, visits = excluded.visits,
                visitors = excluded.visitors, source = excluded.source,
                collected_at = current_timestamp`
          for (const row of visits.pages)
            yield* sql`
              insert into analytics_page_daily (date, page, pageviews, visits, source)
              values (${row.date}, ${row.page}, ${row.pageviews}, ${row.visits}, ${source})
              on conflict(date, page) do update set
                pageviews = excluded.pageviews, visits = excluded.visits,
                source = excluded.source, collected_at = current_timestamp`
          for (const row of visits.events)
            yield* sql`
              insert into analytics_event_daily (date, name, occurrences, source)
              values (${row.date}, ${row.name}, ${row.count}, ${source})
              on conflict(date, name) do update set
                occurrences = excluded.occurrences, source = excluded.source,
                collected_at = current_timestamp`
          for (const date of fetchedDates)
            yield* sql`
              insert into analytics_synced_day (date, source) values (${date}, ${source})
              on conflict(date) do update set
                source = excluded.source, fetched_at = current_timestamp`
        }),
      )

    const saveHoursI = (
      date: string,
      hours: ReadonlyArray<SiteVisitsHour>,
      source: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`delete from analytics_site_hourly where date = ${date}`
          for (const row of hours)
            yield* sql`
              insert into analytics_site_hourly (date, hour, pageviews, visits, visitors, source)
              values (${date}, ${row.hour}, ${row.pageviews}, ${row.visits}, ${row.visitors}, ${source})
              on conflict(date, hour) do update set
                pageviews = excluded.pageviews, visits = excluded.visits,
                visitors = excluded.visitors, source = excluded.source,
                collected_at = current_timestamp`
        }),
      )

    const visitsOfDayI = (date: string) =>
      Effect.gen(function* () {
        const site = yield* sql<SiteVisitsDay>`
          select date, pageviews, visits, visitors from analytics_site_daily
          where date = ${date}`
        const pages = yield* sql<{ date: string; page: string; pageviews: number; visits: number }>`
          select date, page, pageviews, visits from analytics_page_daily
          where date = ${date} order by visits desc, pageviews desc, page`
        const events = yield* sql<{ date: string; name: string; count: number }>`
          select date, name, occurrences as count from analytics_event_daily
          where date = ${date} order by occurrences desc, name`
        return { site, pages, events } as VisitsDays
      })

    const hoursOfDayI = (date: string) =>
      sql<SiteVisitsHour>`
        select hour, pageviews, visits, visitors from analytics_site_hourly
        where date = ${date} order by hour`.pipe(
        Effect.map((rows) => rows as ReadonlyArray<SiteVisitsHour>),
      )

    const visitsSyncedAtI = (date: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ fetched_at: string | null }>`
          select strftime('%Y-%m-%dT%H:%M:%SZ', fetched_at) as fetched_at
          from analytics_synced_day where date = ${date}`
        return rows[0]?.fetched_at ?? null
      })

    const missingVisitDatesI = (dates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`select date from analytics_synced_day`
        const fetched = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => !fetched.has(date))
      })

    const recentlySyncedVisitDatesI = (
      dates: ReadonlyArray<string>,
      maxAgeHours: number,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`
          select date from analytics_synced_day
          where fetched_at > datetime('now', ${`-${maxAgeHours} hours`})`
        const fresh = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => fresh.has(date))
      })

    const latestVisitsSyncedAtI = Effect.gen(function* () {
      const rows = yield* sql<{ fetched_at: string | null }>`
        select strftime('%Y-%m-%dT%H:%M:%SZ', max(fetched_at)) as fetched_at
        from analytics_synced_day`
      return rows[0]?.fetched_at ?? null
    })

    const visitsSummaryI = Effect.gen(function* () {
      const rows = yield* sql<VisitsSummary>`
        select count(*) as days, min(date) as firstDate, max(date) as lastDate,
               (select source from analytics_synced_day
                order by fetched_at desc, date desc limit 1) as source
        from analytics_synced_day`
      return rows[0] ?? { days: 0, firstDate: null, lastDate: null, source: null }
    })

    const visitsHistoryI = (limit = 28) =>
      Effect.gen(function* () {
        const rows = yield* sql<SiteVisitsDay>`
          select date, pageviews, visits, visitors from analytics_site_daily order by date`
        return rows.slice(-limit) as ReadonlyArray<SiteVisitsDay>
      })

    const latestVisitsDateI = Effect.gen(function* () {
      const rows = yield* sql<{ date: string | null }>`
        select max(date) as date from analytics_site_daily`
      return rows[0]?.date ?? null
    })

    // --- revenue (canonical commerce rows; see ../revenue/schema.ts) ---

    const saveRevenueI = (
      days: ReadonlyArray<RevenueDay>,
      fetchedDates: ReadonlyArray<string>,
      source: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // A fetched day the provider returned no row for is a day with no
          // sales, recorded as such so it does not read as missing forever.
          // Its currency is whatever the fetch's other rows carry.
          const currency = days[0]?.currency ?? ""
          const returned = new Set(days.map((row) => row.date))
          for (const date of fetchedDates)
            if (!returned.has(date))
              yield* sql`
                insert into revenue_site_daily (date, orders, revenue, net, currency, source)
                values (${date}, 0, 0, 0, ${currency}, ${source})
                on conflict(date) do update set
                  orders = 0, revenue = 0, net = 0, source = excluded.source,
                  collected_at = current_timestamp`
          for (const row of days)
            yield* sql`
              insert into revenue_site_daily (date, orders, revenue, net, currency, source)
              values (${row.date}, ${row.orders}, ${row.revenue}, ${row.net}, ${row.currency}, ${source})
              on conflict(date) do update set
                orders = excluded.orders, revenue = excluded.revenue, net = excluded.net,
                currency = excluded.currency, source = excluded.source,
                collected_at = current_timestamp`
          for (const date of fetchedDates)
            yield* sql`
              insert into revenue_synced_day (date, source) values (${date}, ${source})
              on conflict(date) do update set
                source = excluded.source, fetched_at = current_timestamp`
        }),
      )

    const missingRevenueDatesI = (dates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`select date from revenue_synced_day`
        const fetched = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => !fetched.has(date))
      })

    const recentlySyncedRevenueDatesI = (
      dates: ReadonlyArray<string>,
      maxAgeHours: number,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ date: string }>`
          select date from revenue_synced_day
          where fetched_at > datetime('now', ${`-${maxAgeHours} hours`})`
        const fresh = new Set(rows.map((row) => row.date))
        return [...new Set(dates)].filter((date) => fresh.has(date))
      })

    const latestRevenueSyncedAtI = Effect.gen(function* () {
      const rows = yield* sql<{ fetched_at: string | null }>`
        select strftime('%Y-%m-%dT%H:%M:%SZ', max(fetched_at)) as fetched_at
        from revenue_synced_day`
      return rows[0]?.fetched_at ?? null
    })

    const revenueSyncedAtI = (date: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ fetched_at: string | null }>`
          select strftime('%Y-%m-%dT%H:%M:%SZ', fetched_at) as fetched_at
          from revenue_synced_day where date = ${date}`
        return rows[0]?.fetched_at ?? null
      })

    const revenueSummaryI = Effect.gen(function* () {
      const rows = yield* sql<RevenueSummary>`
        select count(*) as days, min(date) as firstDate, max(date) as lastDate,
               (select source from revenue_synced_day
                order by fetched_at desc, date desc limit 1) as source
        from revenue_synced_day`
      return rows[0] ?? { days: 0, firstDate: null, lastDate: null, source: null }
    })

    const revenueDaysI = (start: string, end: string) =>
      sql<RevenueDay>`
        select date, orders, revenue, net, currency from revenue_site_daily
        where date >= ${start} and date <= ${end} order by date`.pipe(
        Effect.map((rows) => rows as ReadonlyArray<RevenueDay>),
      )

    // The two window bounds every visits window read shares: anchored on the
    // caller's end date when given, else on the newest visits day.
    const visitsWindowBounds = (windowDays: number, endDate?: string) =>
      Effect.gen(function* () {
        const latestDate = endDate ?? (yield* latestVisitsDateI)
        if (!latestDate) return null
        const currentStart = dateDaysBefore(latestDate, windowDays - 1)
        const previousEnd = dateDaysBefore(currentStart, 1)
        const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
        return { latestDate, currentStart, previousEnd, previousStart }
      })

    const zeroVisits = { pageviews: 0, visits: 0 }

    const pageVisitsOverviewI = (windowDays = 28, endDate?: string) =>
      Effect.gen(function* () {
        const bounds = yield* visitsWindowBounds(windowDays, endDate)
        if (!bounds) {
          return {
            latestDate: null,
            currentStart: null,
            previousStart: null,
            previousEnd: null,
            rows: [],
          }
        }
        const window = (start: string, end: string) =>
          sql<{ page: string; pageviews: number; visits: number }>`
            select page, sum(pageviews) as pageviews, sum(visits) as visits
            from analytics_page_daily
            where date between ${start} and ${end}
            group by page`
        const asMap = (
          rows: ReadonlyArray<{ page: string; pageviews: number; visits: number }>,
        ) =>
          new Map(
            rows.map(({ page, ...visits }) => [page, visits as typeof zeroVisits]),
          )
        const current = asMap(
          yield* window(bounds.currentStart, bounds.latestDate),
        )
        const previous = asMap(
          yield* window(bounds.previousStart, bounds.previousEnd),
        )
        const pages = [...new Set([...current.keys(), ...previous.keys()])]
        const rows = pages
          .map((page) => ({
            page,
            current: current.get(page) ?? zeroVisits,
            previous: previous.get(page) ?? zeroVisits,
          }))
          .sort((left, right) => right.current.pageviews - left.current.pageviews)
        return {
          latestDate: bounds.latestDate,
          currentStart: bounds.currentStart,
          previousStart: bounds.previousStart,
          previousEnd: bounds.previousEnd,
          rows,
        }
      })

    const eventWindowI = (windowDays = 28, endDate?: string) =>
      Effect.gen(function* () {
        const bounds = yield* visitsWindowBounds(windowDays, endDate)
        if (!bounds) return [] as ReadonlyArray<EventWindowRow>
        const window = (start: string, end: string) =>
          sql<{ name: string; count: number }>`
            select name, sum(occurrences) as count
            from analytics_event_daily
            where date between ${start} and ${end}
            group by name`
        const current = new Map(
          (yield* window(bounds.currentStart, bounds.latestDate)).map((row) => [
            row.name,
            row.count,
          ]),
        )
        const previous = new Map(
          (yield* window(bounds.previousStart, bounds.previousEnd)).map((row) => [
            row.name,
            row.count,
          ]),
        )
        const names = [...new Set([...current.keys(), ...previous.keys()])]
        return names
          .map((name) => ({
            name,
            current: current.get(name) ?? 0,
            previous: previous.get(name) ?? 0,
          }))
          .sort((left, right) => right.current - left.current) as ReadonlyArray<EventWindowRow>
      })

    return {
      saveSnapshots: (snapshots, fetchedDates) =>
        saveSnapshotsI(snapshots, fetchedDates).pipe(mapErr("saveSnapshots")),
      saveDailyTotals: (totals, fetchedDates) =>
        saveDailyTotalsI(totals, fetchedDates).pipe(mapErr("saveDailyTotals")),
      savePageIndexStatuses: (statuses) =>
        savePageIndexStatusesI(statuses).pipe(mapErr("savePageIndexStatuses")),
      recordIndexCoverage: (keywordTargets) =>
        recordIndexCoverageI(keywordTargets).pipe(
          Effect.asVoid,
          mapErr("recordIndexCoverage"),
        ),
      indexCoverageHistory: (limit) =>
        indexCoverageHistoryI(limit).pipe(mapErr("indexCoverageHistory")),
      pruneIndexStatuses: (targetUrls) =>
        pruneIndexStatusesI(targetUrls).pipe(mapErr("pruneIndexStatuses")),
      addLogEntry: (entry) => addLogEntryI(entry).pipe(mapErr("addLogEntry")),
      capturePageBaselines: (entries, baselineDate) =>
        capturePageBaselinesI(entries, baselineDate).pipe(
          mapErr("capturePageBaselines"),
        ),
      recordSyncCheck: () =>
        recordSyncCheckI.pipe(Effect.asVoid, mapErr("recordSyncCheck")),
      saveKeywordMetrics: (metrics) =>
        saveKeywordMetricsI(metrics).pipe(
          Effect.asVoid,
          mapErr("saveKeywordMetrics"),
        ),
      keywordMetrics: (locationCode, languageCode) =>
        keywordMetricsI(locationCode, languageCode).pipe(mapErr("keywordMetrics")),
      keywordMonthlySearches: (locationCode, languageCode) =>
        keywordMonthlySearchesI(locationCode, languageCode).pipe(
          mapErr("keywordMonthlySearches"),
        ),
      saveKeywordProposals: (proposals) =>
        saveKeywordProposalsI(proposals).pipe(
          Effect.asVoid,
          mapErr("saveKeywordProposals"),
        ),
      keywordProposals: (locationCode, languageCode) =>
        keywordProposalsI(locationCode, languageCode).pipe(
          mapErr("keywordProposals"),
        ),
      dismissKeywordProposals: (keywords, locationCode, languageCode) =>
        dismissKeywordProposalsI(keywords, locationCode, languageCode).pipe(
          mapErr("dismissKeywordProposals"),
        ),
      saveDomainRating: (rating, fetchedAt, license) =>
        saveDomainRatingI(rating, fetchedAt, license).pipe(
          Effect.asVoid,
          mapErr("saveDomainRating"),
        ),
      latestDomainRating: () =>
        latestDomainRatingI.pipe(mapErr("latestDomainRating")),
      domainRatingHistory: (limit) =>
        domainRatingHistoryI(limit).pipe(mapErr("domainRatingHistory")),
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
      saveVisits: (visits, fetchedDates, source) =>
        saveVisitsI(visits, fetchedDates, source).pipe(mapErr("saveVisits")),
      saveHours: (date, hours, source) =>
        saveHoursI(date, hours, source).pipe(mapErr("saveHours")),
      visitsOfDay: (date) => visitsOfDayI(date).pipe(mapErr("visitsOfDay")),
      hoursOfDay: (date) => hoursOfDayI(date).pipe(mapErr("hoursOfDay")),
      visitsSyncedAt: (date) =>
        visitsSyncedAtI(date).pipe(mapErr("visitsSyncedAt")),
      missingVisitDates: (dates) =>
        missingVisitDatesI(dates).pipe(mapErr("missingVisitDates")),
      recentlySyncedVisitDates: (dates, maxAgeHours) =>
        recentlySyncedVisitDatesI(dates, maxAgeHours).pipe(
          mapErr("recentlySyncedVisitDates"),
        ),
      latestVisitsSyncedAt: () =>
        latestVisitsSyncedAtI.pipe(mapErr("latestVisitsSyncedAt")),
      visitsSummary: () => visitsSummaryI.pipe(mapErr("visitsSummary")),
      visitsHistory: (limit) =>
        visitsHistoryI(limit).pipe(mapErr("visitsHistory")),
      pageVisitsOverview: (windowDays, endDate) =>
        pageVisitsOverviewI(windowDays, endDate).pipe(
          mapErr("pageVisitsOverview"),
        ),
      eventWindow: (windowDays, endDate) =>
        eventWindowI(windowDays, endDate).pipe(mapErr("eventWindow")),
      saveRevenue: (days, fetchedDates, source) =>
        saveRevenueI(days, fetchedDates, source).pipe(mapErr("saveRevenue")),
      missingRevenueDates: (dates) =>
        missingRevenueDatesI(dates).pipe(mapErr("missingRevenueDates")),
      recentlySyncedRevenueDates: (dates, maxAgeHours) =>
        recentlySyncedRevenueDatesI(dates, maxAgeHours).pipe(
          mapErr("recentlySyncedRevenueDates"),
        ),
      latestRevenueSyncedAt: () =>
        latestRevenueSyncedAtI.pipe(mapErr("latestRevenueSyncedAt")),
      revenueSummary: () => revenueSummaryI.pipe(mapErr("revenueSummary")),
      revenueDays: (start, end) =>
        revenueDaysI(start, end).pipe(mapErr("revenueDays")),
      revenueSyncedAt: (date) =>
        revenueSyncedAtI(date).pipe(mapErr("revenueSyncedAt")),
    } satisfies Interface
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CurrentSite.defaultLayer))

export * as Storage from "./storage"
