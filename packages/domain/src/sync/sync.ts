// Sync service: orchestrates a Search Console refresh — composes SearchConsole
// (fetch), Storage (persist + freshness), Registry (targets), Sitemap
// (refresh), and the third-party reads that ride along (Domain Rating, visits,
// revenue, Keyword metrics). Site-scoped. FROZEN CONTRACT — Interface/Service/use/defaultLayer
// are frozen; this is the real `layer`, ported from the legacy `src/automation.ts`.
import { Cause, Context, Effect, Fiber, Layer, Result, Semaphore } from "effect"

import { Analytics } from "../analytics/analytics.ts"
import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { DomainRating } from "../domain-rating/domain-rating.ts"
import { KeywordMetrics } from "../keyword-metrics/keyword-metrics.ts"
import { Registry } from "../registry/registry.ts"
import { Revenue } from "../revenue/revenue.ts"
import { SearchConsole } from "../search-console/search-console.ts"
import { type SitemapPage } from "../sitemap/schema.ts"
import { serviceUse } from "../service-use.ts"
import { Sitemap } from "../sitemap/sitemap.ts"
import { Storage } from "../storage/storage.ts"
import { reconciliationTtlHours, SyncError } from "./schema.ts"

export interface Interface {
  // Reconcile the recently-finalized window and fetch missing days; returns a
  // human-readable summary of what was saved.
  readonly syncSearchConsole: () => Effect.Effect<string, SyncError>
  // Backfill up to `months` of history; returns a human-readable summary.
  readonly backfillSearchConsole: (
    months?: number,
  ) => Effect.Effect<string, SyncError>
  // The visits twin: re-fetch `months` of days from the site's analytics
  // provider, reaching back past the ledger's first day. Returns a
  // human-readable summary, or says so for a site with no provider.
  readonly backfillVisits: (
    months?: number,
  ) => Effect.Effect<string, SyncError>
  // Re-fetch the day in progress from the site's analytics provider (the
  // daily rows for today plus its hours) and from its commerce provider
  // (today's sales) and write them into the ledger. Meant to run every few
  // minutes for as long as the server is up; the daily sync fetches the same
  // day once more when it is finished. Returns a summary, or null for a site
  // with neither provider.
  readonly syncToday: () => Effect.Effect<string | null, SyncError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Sync") {}

export const use = serviceUse(Service)

// --- pure date helpers (ported verbatim from src/automation.ts) -------------

// URL-inspection verdicts change slowly; a registry target checked within this
// window is not re-inspected.
const inspectionTtlHours = 24

// `count` consecutive dates ending at the finalization cutoff (today − 3),
// newest first — the recently-finalized window reconciled on each sync to
// absorb Google's late processing. "today" is read fresh on each call: the
// hosted server is long-running, so a module-level `new Date()` would freeze at
// boot and the reconciliation window would drift a day behind per day of uptime.
const datesBeforeToday = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - index - 3)
    return date.toISOString().slice(0, 10)
  })

const dateDaysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

const datesBetween = (start: string, end: string) => {
  const dates: Array<string> = []
  const date = new Date(`${start}T00:00:00.000Z`)
  const last = new Date(`${end}T00:00:00.000Z`)
  while (date <= last) {
    dates.push(date.toISOString().slice(0, 10))
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return dates
}

const reconciliationDates = () => datesBeforeToday(5)

// Visits have no finalization lag — a day is complete at its midnight — so the
// newest whole day is yesterday, and only the last two days are reconciled,
// for events a vendor batches in late. "Yesterday" is the site's, in its
// provider's zone: that is the zone the provider keys its days in and the one
// the today sync writes, so a zone ahead of UTC does not leave its finished
// day unfetched until UTC catches up. UTC is the fallback for the tests' bare
// clock; a site with analytics always has a local day.
const newestVisitsDate = (localToday: string | undefined) => {
  if (localToday) return dateDaysBefore(localToday, 1)
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}
const visitsReconcileDays = 2
const visitsFirstRunDays = 28

// Revenue is the same kind of series with the same "yesterday is whole" rule,
// but a commerce API answers a year in one call where an analytics API needs
// one per day, so the first run reaches back a whole year: enough to compare
// the app's longest period with the one before it. Refunds land on the day of
// the order, days later, so the reconcile window is a week.
const revenueReconcileDays = 7
const revenueFirstRunDays = 365

// Backfill fetches in 30-day chunks (Google's practical query span). The chunk
// fetches run with bounded concurrency; writes are serialized (one SQLite
// connection, one transaction at a time).
const backfillChunkSize = 30
const backfillFetchConcurrency = 3

// The visits backfill chunks only to bound memory and to keep one transaction
// from covering the whole range: a chunk that lands is history that survives a
// later failure. An analytics provider is asked one day at a time whatever the
// chunk, and the adapter already paces those calls, so chunks run one after
// another rather than in parallel — two of them at once would multiply the
// in-flight requests the adapter was tuned for.
const visitsBackfillChunkSize = 30

// How many non-brand Queries are offered to KeywordMetrics as candidates, and
// how many impressions a Query needs to be one. The Registry's own keywords are
// always offered, however small: those are the plan, and the point of asking is
// to find out whether the plan aims at demand that exists. A Query is offered
// only once it has drawn real impressions, because a keyword costs money to ask
// about and a one-impression long-tail Query is not a decision waiting on data.
// The cap is one DataForSEO batch: past that a single sync would send a second
// billed request for the least important terms it could find.
const keywordCandidateQueries = 700
const keywordCandidateMinImpressions = 5

// The window the candidate Queries are read over. Longer than the 28 days the
// reports use: this is asking "has this site ever ranked for this", where a
// report asks "how is it doing now", and a seasonal term that drew impressions
// in spring is still worth a volume number in autumn.
const keywordCandidateWindowDays = 90

const chunked = <A>(
  items: ReadonlyArray<A>,
  size: number,
): Array<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size))
  return chunks
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const searchConsole = yield* SearchConsole.Service
    const storage = yield* Storage.Service
    const registry = yield* Registry.Service
    const sitemap = yield* Sitemap.Service
    const domainRating = yield* DomainRating.Service
    const keywordMetrics = yield* KeywordMetrics.Service
    const analytics = yield* Analytics.Service
    const revenue = yield* Revenue.Service
    const config = yield* Config.Service
    const currentSite = yield* CurrentSite.Service

    // The finalized days to fetch this run: every candidate day never synced,
    // plus the reconciliation window whose cached copy has gone stale.
    const fetchPlan = Effect.fnUntraced(function* (
      candidateDates: ReadonlyArray<string>,
    ) {
      const candidateSet = new Set(candidateDates)
      const missing = yield* storage.missingSnapshotDates(candidateDates)
      const missingSet = new Set(missing)
      const reconcile = reconciliationDates()
      const fresh = new Set(
        yield* storage.recentlySyncedDates(reconcile, reconciliationTtlHours),
      )
      const recent = reconcile.filter(
        (date) =>
          candidateSet.has(date) && !missingSet.has(date) && !fresh.has(date),
      )
      return { dates: [...missing, ...recent], missing, recent }
    })

    // The visits refresh: the missing days of the tracked range plus the stale
    // part of the reconcile window, fetched from the site's analytics provider
    // and saved in canonical form. The range starts at the first day ever
    // fetched, so a gap left by a failed run fills on the next one, or 28 days
    // back on the first run. Null for a site with no analytics — no fetch, no
    // stamp, nothing.
    const syncVisits = Effect.fnUntraced(function* () {
      const status = yield* analytics.status()
      if (!status) return null
      const local = yield* analytics.localDay()
      const newest = newestVisitsDate(local?.date)
      const summary = yield* storage.visitsSummary()
      const start = summary.firstDate ?? dateDaysBefore(newest, visitsFirstRunDays - 1)
      const range = datesBetween(start, newest)
      const missing = yield* storage.missingVisitDates(range)
      const missingSet = new Set(missing)
      const recent = datesBetween(
        dateDaysBefore(newest, visitsReconcileDays - 1),
        newest,
      )
      const fresh = new Set(
        yield* storage.recentlySyncedVisitDates(recent, reconciliationTtlHours),
      )
      const stale = recent.filter(
        (date) => !missingSet.has(date) && !fresh.has(date),
      )
      const dates = [...missing, ...stale]
      if (dates.length > 0) {
        const visits = yield* analytics.fetchVisits(dates)
        yield* storage.saveVisits(visits, dates, status.provider)
      }
      return { provider: status.provider, days: dates.length }
    })

    // The revenue refresh, on the visits' terms: the missing days of the
    // tracked range plus the stale part of the reconcile window, fetched from
    // the site's commerce provider and saved in canonical form. Null for a
    // site with no revenue source.
    const syncRevenue = Effect.fnUntraced(function* () {
      const status = yield* revenue.status()
      if (!status) return null
      const local = yield* revenue.localDay()
      const newest = newestVisitsDate(local?.date)
      const summary = yield* storage.revenueSummary()
      const start = summary.firstDate ?? dateDaysBefore(newest, revenueFirstRunDays - 1)
      const range = datesBetween(start, newest)
      const missing = yield* storage.missingRevenueDates(range)
      const missingSet = new Set(missing)
      const recent = datesBetween(
        dateDaysBefore(newest, revenueReconcileDays - 1),
        newest,
      )
      const fresh = new Set(
        yield* storage.recentlySyncedRevenueDates(recent, reconciliationTtlHours),
      )
      const stale = recent.filter(
        (date) => !missingSet.has(date) && !fresh.has(date),
      )
      const dates = [...missing, ...stale]
      if (dates.length > 0) {
        const days = yield* revenue.fetchRevenue(dates)
        yield* storage.saveRevenue(days, dates, status.provider)
      }
      return { provider: status.provider, days: dates.length }
    })

    // Today's visits, straight into the same tables as every other day. The
    // date is the provider's calendar day in the site's zone, the same key the
    // daily fetch writes (its time-series is asked in that zone too), so the
    // daily sync's reconcile of "yesterday" overwrites exactly this row.
    const todayVisits = Effect.fnUntraced(function* () {
      const status = yield* analytics.status()
      const local = yield* analytics.localDay()
      if (!status || !local) return null
      const [visits, hours] = yield* Effect.all(
        [analytics.fetchVisits([local.date]), analytics.fetchHours(local.date)],
        { concurrency: 2 },
      )
      yield* storage.saveVisits(visits, [local.date], status.provider)
      yield* storage.saveHours(local.date, hours, status.provider)
      const site = visits.site.find((day) => day.date === local.date)
      return `Today (${local.date} ${local.timeZone}) from ${status.provider}: ${site?.visits ?? 0} visits, ${site?.pageviews ?? 0} pageviews, ${visits.events.length} event names, ${hours.length} hours.`
    })

    // Today's sales, the same way: one row, overwritten each round and once
    // more by the daily sync's reconcile when the day is whole.
    const todayRevenue = Effect.fnUntraced(function* () {
      const status = yield* revenue.status()
      const local = yield* revenue.localDay()
      if (!status || !local) return null
      const days = yield* revenue.fetchRevenue([local.date])
      yield* storage.saveRevenue(days, [local.date], status.provider)
      const today = days.find((day) => day.date === local.date)
      return `Today (${local.date} ${local.timeZone}) from ${status.provider}: ${today?.orders ?? 0} orders, ${today?.revenue ?? 0} ${today?.currency ?? ""} revenue.`.replace("  ", " ")
    })

    // Either provider may be absent; one that fails must not cost the other
    // its round, so the two run apart and a failure is reported in the summary
    // rather than raised — except when both fail, which is the round failing.
    const runToday = Effect.fn("Sync.syncToday")(function* () {
      const [visits, sales] = yield* Effect.all(
        [Effect.result(todayVisits()), Effect.result(todayRevenue())],
        { concurrency: 2 },
      )
      if (Result.isFailure(visits) && Result.isFailure(sales))
        return yield* Effect.fail(visits.failure)
      const outcomes: ReadonlyArray<
        Result.Result<string | null, { readonly message: string }>
      > = [visits, sales]
      const parts = outcomes.map((outcome) =>
        Result.isSuccess(outcome)
          ? outcome.success
          : `Failed: ${outcome.failure.message}`,
      )
      const lines = parts.filter((part): part is string => part !== null)
      return lines.length === 0 ? null : lines.join(" ")
    })

    const runSync = Effect.fn("Sync.syncSearchConsole")(function* () {
      // The sitemap refresh runs alongside the Search Console work; a failure
      // is non-fatal — legacy swallowed it and reported the cached page count.
      const sitemapFiber = yield* Effect.forkChild(
        sitemap
          .refreshSitemapPages()
          .pipe(
            Effect.catchCause(() =>
              Effect.succeed<ReadonlyArray<SitemapPage>>([]),
            ),
          ),
      )

      // Domain Rating rides along on the same terms: a third party that is slow,
      // rate-limited or unconfigured must not fail a Search Console sync, so the
      // reading is forked and its failure swallowed. The previous cached value
      // stays on the volume when a refresh does not land.
      const domainRatingFiber = yield* Effect.forkChild(
        domainRating.refresh().pipe(Effect.catchCause(() => Effect.succeed(null))),
      )

      // Visits ride along on the same terms: a provider that is down, slow, or
      // missing its key must not fail the Search Console sync. Unlike the
      // rating, the failure is logged — a wrong key would otherwise show only
      // as visits that quietly stop moving.
      const visitsFiber = yield* Effect.forkChild(
        syncVisits().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `The analytics sync failed: ${Cause.pretty(cause)}`,
            ).pipe(Effect.as(null)),
          ),
        ),
      )

      // Revenue rides along on the visits' terms, logged the same way.
      const revenueFiber = yield* Effect.forkChild(
        syncRevenue().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `The revenue sync failed: ${Cause.pretty(cause)}`,
            ).pipe(Effect.as(null)),
          ),
        ),
      )

      const finalizedThrough = yield* storage.finalizationCutoff()
      // Query breakdowns are trusted only through finalizedThrough. Daily totals
      // are fetched to yesterday and flagged provisional by the UI; these
      // trailing days change daily, so they are always re-fetched.
      const freshestThrough = dateDaysBefore(finalizedThrough, -2)
      const provisionalDates = datesBetween(
        dateDaysBefore(finalizedThrough, -1),
        freshestThrough,
      )
      const tracked = yield* storage.snapshotDateRange()
      const trackingStart =
        tracked.first ?? dateDaysBefore(finalizedThrough, 27)
      const trackedRange = datesBetween(trackingStart, finalizedThrough)

      const plan = yield* fetchPlan(trackedRange)
      const snapshots =
        plan.dates.length > 0
          ? yield* searchConsole.fetchSearchConsoleSnapshots(plan.dates)
          : []
      yield* storage.saveSnapshots(snapshots, plan.dates)

      const missingTotals = yield* storage.missingDailyTotalDates(trackedRange)
      const totalDates = [
        ...new Set([...plan.dates, ...missingTotals, ...provisionalDates]),
      ]
      const totals =
        totalDates.length > 0
          ? yield* searchConsole.fetchDailyTotals(totalDates)
          : { site: [], pages: [] }
      yield* storage.saveDailyTotals(totals, totalDates)

      const site = yield* currentSite.current()
      const entries = yield* registry.loadRegistry()
      const targetUrls = [
        ...new Set(entries.map((entry) => `${site.origin}${entry.targetUrl}`)),
      ]
      // The pages at least one Keyword aims at. Inspected with the rest — a page
      // is inspected because it is tracked — but counted apart by the Indexed
      // series below.
      const keywordTargetUrls = [
        ...new Set(
          entries
            .filter((entry) => entry.keyword.trim())
            .map((entry) => `${site.origin}${entry.targetUrl}`),
        ),
      ]
      const freshUrls = new Set(
        yield* storage.recentlyInspectedUrls(targetUrls, inspectionTtlHours),
      )
      const staleUrls = targetUrls.filter((url) => !freshUrls.has(url))
      const inspection =
        staleUrls.length > 0
          ? yield* searchConsole.fetchPageIndexStatuses(staleUrls)
          : { inspections: [], failed: 0 }
      yield* storage.savePageIndexStatuses(inspection.inspections)
      yield* storage.pruneIndexStatuses(targetUrls)
      // The day's Indexed tally, over the statuses just written and pruned. It
      // is recorded even when every target was fresh and nothing was inspected:
      // the reading is about the day, not about this run's calls, and a run that
      // skipped the vendor still knows what the ledger says today.
      //
      // Counted over the keyword targets only, and not over every inspected
      // page: an inventory-only page has no Keyword to rank, so Google's verdict
      // on it cannot block the plan the series is about.
      yield* storage.recordIndexCoverage(keywordTargetUrls)

      // Keyword metrics run last and in sequence, not forked with the others,
      // because they are the one third-party call that depends on this run's
      // own output: the candidate Queries come from the rows saved above. The
      // failure is logged rather than swallowed — an empty answer and a wrong
      // key look identical from the stored side, and the second one costs
      // money to leave unnoticed.
      //
      // Nearly every run reaches no further than the freshness cutoff inside
      // `refresh` and sends nothing. A run that does send is bounded to one
      // batch by `keywordCandidateQueries`.
      const candidateQueries = yield* storage.topQueries({
        windowDays: keywordCandidateWindowDays,
        minImpressions: keywordCandidateMinImpressions,
        limit: keywordCandidateQueries,
      })
      const keywords = yield* keywordMetrics
        .refresh([
          ...entries.map((entry) => entry.keyword),
          ...candidateQueries.rows.map((row) => row.query),
        ])
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `The keyword-metrics refresh failed: ${Cause.pretty(cause)}`,
            ).pipe(Effect.as(null)),
          ),
        )

      const sitemapPages = yield* Fiber.join(sitemapFiber)
      const rating = yield* Fiber.join(domainRatingFiber)
      const visits = yield* Fiber.join(visitsFiber)
      const sales = yield* Fiber.join(revenueFiber)

      // Record that this run happened, last, so only a run that got all the way
      // here claims to have asked Google. A run that found every day present and
      // fresh writes no `synced_day` row, so without this stamp it leaves no
      // trace at all: latestSyncedAt still reports the write six hours ago, and a
      // caller cannot tell a healthy "nothing new" run from a sync that never
      // ran or one that failed. Backfill deliberately does not stamp it — this
      // instant answers "when was the daily refresh last attempted", and a
      // one-off historical fetch would make it read fresher than the truth.
      //
      // The forked reads are joined above it, so the stamp still means the whole
      // run finished — a rating that never landed is swallowed, not skipped.
      yield* storage.recordSyncCheck()

      const inspectionSummary =
        inspection.failed > 0
          ? `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached); ${inspection.failed} unavailable`
          : `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached)`
      return `Saved ${snapshots.length} Search Console rows across ${plan.dates.length} finalized days (${plan.missing.length} missing, ${plan.recent.length} reconciled); daily totals for ${totalDates.length} days; ${inspectionSummary}; finalized through ${finalizedThrough}, provisional to ${freshestThrough}. Sitemap: ${sitemapPages.length || "cached"} pages.${rating ? ` Domain Rating: ${rating.rating}.` : ""}${visits ? ` Visits: ${visits.days} days from ${visits.provider}.` : ""}${sales ? ` Revenue: ${sales.days} days from ${sales.provider}.` : ""}${keywords && keywords.requests > 0 ? ` Keyword metrics: ${keywords.answered} of ${keywords.asked} keywords in ${keywords.requests} request(s)${keywords.unreported > 0 ? `, ${keywords.unreported} too rare for the vendor to report` : ""}.` : ""}`
    })

    const runBackfill = Effect.fn("Sync.backfillSearchConsole")(function* (
      months: number,
    ) {
      // Debug uses an isolated, pre-seeded database; backfilling it against the
      // real API would pollute it (legacy threw here for the same reason).
      if (yield* config.debugMode()) {
        return yield* Effect.fail(
          new SyncError({
            message:
              "Backfill is unavailable in debug mode; the debug database already contains its full fake history.",
          }),
        )
      }
      const finalizedThrough = yield* storage.finalizationCutoff()
      const retentionStart = dateDaysBefore(
        finalizedThrough,
        Math.min(Math.round(months * 30.4), 485),
      )
      const candidates = datesBetween(retentionStart, finalizedThrough)
      const missingSnapshots = yield* storage.missingSnapshotDates(candidates)
      const missingTotals = yield* storage.missingDailyTotalDates(candidates)

      // Bounded-concurrency fetches, writes serialized through one permit so the
      // single SQLite connection only ever runs one transaction at a time.
      const writeLock = yield* Semaphore.make(1)

      const savedPerChunk = yield* Effect.forEach(
        chunked(missingSnapshots, backfillChunkSize),
        (dates) =>
          Effect.gen(function* () {
            const rows =
              yield* searchConsole.fetchSearchConsoleSnapshots(dates)
            yield* writeLock.withPermits(1)(storage.saveSnapshots(rows, dates))
            return rows.length
          }),
        { concurrency: backfillFetchConcurrency },
      )
      const savedRows = savedPerChunk.reduce((total, count) => total + count, 0)

      yield* Effect.forEach(
        chunked(missingTotals, backfillChunkSize),
        (dates) =>
          Effect.gen(function* () {
            const totals = yield* searchConsole.fetchDailyTotals(dates)
            yield* writeLock.withPermits(1)(
              storage.saveDailyTotals(totals, dates),
            )
          }),
        { concurrency: backfillFetchConcurrency },
      )

      return `Backfilled ${missingSnapshots.length} days (${savedRows} rows) and daily totals for ${missingTotals.length} days back to ${retentionStart}; current through ${finalizedThrough}.`
    })

    // The visits twin of runBackfill. Two things separate it from syncVisits.
    // It reaches back past the ledger's first day, where syncVisits starts at
    // it — the daily sync grows the series forward and can never widen it
    // backwards. And it re-fetches every day in the range rather than only the
    // days with no row: a day the provider had nothing for when it was first
    // synced is stored as zeros, not left absent, so "the missing days" would
    // skip exactly the days a backfill is asked to repair. saveVisits upserts,
    // so re-fetching a day that was already right costs a write and changes
    // nothing.
    const runVisitsBackfill = Effect.fn("Sync.backfillVisits")(function* (
      months: number,
    ) {
      // Same reason as the Search Console backfill: the debug database is
      // pre-seeded, and a real fetch would pollute it.
      if (yield* config.debugMode()) {
        return yield* Effect.fail(
          new SyncError({
            message:
              "Backfill is unavailable in debug mode; the debug database already contains its full fake history.",
          }),
        )
      }

      const status = yield* analytics.status()
      // No provider is not a failure anywhere else in the domain, and asking
      // for a backfill should not be the one place it becomes one.
      if (!status) {
        return "This site has no analytics provider, so there are no visits to backfill."
      }
      // A provider that is configured but unusable fails loudly here. The daily
      // sync forks and swallows that, because a bad key must not cost the site
      // its Search Console refresh; a backfill was asked for on its own, so its
      // caller is owed the reason.
      if (!status.ready) {
        return yield* Effect.fail(
          new SyncError({
            message: `The ${status.provider} analytics provider is not ready: ${status.reason ?? "no reason given"}.`,
          }),
        )
      }

      const local = yield* analytics.localDay()
      const newest = newestVisitsDate(local?.date)
      const start = dateDaysBefore(newest, Math.round(months * 30.4) - 1)
      const dates = datesBetween(start, newest)

      const saved = yield* Effect.forEach(
        chunked(dates, visitsBackfillChunkSize),
        (chunk) =>
          Effect.gen(function* () {
            const visits = yield* analytics.fetchVisits(chunk)
            yield* storage.saveVisits(visits, chunk, status.provider)
            return visits.site.reduce((total, day) => total + day.visits, 0)
          }),
        { concurrency: 1 },
      )
      const visits = saved.reduce((total, count) => total + count, 0)

      return `Backfilled ${dates.length} days of visits from ${status.provider}, ${start} to ${newest}: ${visits} visits.`
    })

    // Wrap any dependency failure as a SyncError (without double-wrapping the
    // debug-mode SyncError raised inside backfill).
    const toSyncError = (message: string) => (cause: unknown) =>
      cause instanceof SyncError ? cause : new SyncError({ message, cause })

    return {
      syncSearchConsole: () =>
        runSync().pipe(
          Effect.mapError(toSyncError("The Search Console sync failed.")),
        ),
      backfillSearchConsole: (months = 16) =>
        runBackfill(months).pipe(
          Effect.mapError(toSyncError("The Search Console backfill failed.")),
        ),
      backfillVisits: (months = 6) =>
        runVisitsBackfill(months).pipe(
          Effect.mapError(toSyncError("The visits backfill failed.")),
        ),
      syncToday: () =>
        runToday().pipe(Effect.mapError(toSyncError("The today sync failed."))),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SearchConsole.defaultLayer),
  Layer.provide(Analytics.defaultLayer),
  Layer.provide(Revenue.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(Sitemap.defaultLayer),
  Layer.provide(DomainRating.defaultLayer),
  Layer.provide(KeywordMetrics.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Sync from "./sync"
