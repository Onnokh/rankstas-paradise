// Sync service: orchestrates a Search Console refresh — composes SearchConsole
// (fetch), Storage (persist + freshness), Registry (targets), and Sitemap
// (refresh). Site-scoped. FROZEN CONTRACT — Interface/Service/use/defaultLayer
// are frozen; this is the real `layer`, ported from the legacy `src/automation.ts`.
import { Context, Effect, Fiber, Layer, Semaphore } from "effect"

import { Config } from "../config/config.ts"
import { BingWebmaster } from "../bing-webmaster/bing-webmaster.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Registry } from "../registry/registry.ts"
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

// Backfill fetches in 30-day chunks (Google's practical query span). The chunk
// fetches run with bounded concurrency; writes are serialized (one SQLite
// connection, one transaction at a time).
const backfillChunkSize = 30
const backfillFetchConcurrency = 3

const chunked = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < items.length; index += backfillChunkSize)
    chunks.push(items.slice(index, index + backfillChunkSize))
  return chunks
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const searchConsole = yield* SearchConsole.Service
    const bingWebmaster = yield* BingWebmaster.Service
    const storage = yield* Storage.Service
    const registry = yield* Registry.Service
    const sitemap = yield* Sitemap.Service
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

      const sitemapPages = yield* Fiber.join(sitemapFiber)
      const inspectionSummary =
        inspection.failed > 0
          ? `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached); ${inspection.failed} unavailable`
          : `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached)`

      const bingNote = yield* bingWebmaster.hasBingConnection().pipe(
        Effect.flatMap((connected) =>
          connected
            ? bingWebmaster.fetchSiteDailyTotals().pipe(
                Effect.flatMap((rows) =>
                  storage.saveBingSiteDaily(rows).pipe(
                    Effect.as(
                      `Bing site totals: ${rows.length} days saved (${rows.reduce((total, row) => total + row.clicks, 0)} clicks).`,
                    ),
                  ),
                ),
                Effect.catchCause(() =>
                  Effect.succeed("Bing site totals: skipped (fetch failed)."),
                ),
              )
            : Effect.succeed("Bing: off (no API key)."),
        ),
      )

      return `Saved ${snapshots.length} Search Console rows across ${plan.dates.length} finalized days (${plan.missing.length} missing, ${plan.recent.length} reconciled); daily totals for ${totalDates.length} days; ${inspectionSummary}; finalized through ${finalizedThrough}, provisional to ${freshestThrough}. Sitemap: ${sitemapPages.length || "cached"} pages. ${bingNote}`
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
        chunked(missingSnapshots),
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
        chunked(missingTotals),
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
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SearchConsole.defaultLayer),
  Layer.provide(BingWebmaster.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(Sitemap.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Sync from "./sync"
