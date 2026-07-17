import { Effect } from "effect"

import { dataDirectory, debugMode, ensureDataDirectory } from "./config.ts"
import { debugDailyTotals, debugSnapshots } from "./debug.ts"
import { fetchDailyTotals, fetchPageIndexStatuses, fetchSearchConsoleSnapshots } from "./google.ts"
import { loadRegistry } from "./registry.ts"
import { refreshSitemapPages } from "./sitemap.ts"
import { missingDailyTotalDates, missingSnapshotDates, opportunityDigest, recentlyInspectedUrls, recentlySyncedDates, saveDailyTotals, savePageIndexStatuses, saveSnapshots, snapshotDateRange } from "./storage.ts"

const today = new Date()
const datesBeforeToday = (count: number) => Array.from({ length: count }, (_, index) => {
  const date = new Date(today)
  date.setUTCDate(date.getUTCDate() - index - 3)
  return date.toISOString().slice(0, 10)
})
const dateDaysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}
const datesBetween = (start: string, end: string) => {
  const dates: string[] = []
  const date = new Date(`${start}T00:00:00.000Z`)
  const last = new Date(`${end}T00:00:00.000Z`)
  while (date <= last) {
    dates.push(date.toISOString().slice(0, 10))
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return dates
}
const debugDates = [...new Set(debugSnapshots.map((snapshot) => snapshot.date))]
const reconciliationDates = () => datesBeforeToday(5)

// Search Console revises recent days and index verdicts change slowly, so data
// refreshed within these windows is reused instead of re-fetched at startup.
const reconciliationTtlHours = 6
const inspectionTtlHours = 12

const fetchPlan = (candidateDates: readonly string[]) => {
  const candidates = [...new Set(candidateDates)]
  const candidateSet = new Set(candidates)
  const missing = missingSnapshotDates(candidates)
  const missingSet = new Set(missing)
  const fresh = new Set(recentlySyncedDates(reconciliationDates(), reconciliationTtlHours))
  const recent = reconciliationDates().filter((date) => candidateSet.has(date) && !missingSet.has(date) && !fresh.has(date))
  return { dates: [...missing, ...recent], missing, recent }
}

export const syncSearchConsole = async () => {
  await Effect.runPromise(ensureDataDirectory)
  if (debugMode) {
    saveSnapshots(debugSnapshots, debugDates)
    saveDailyTotals(debugDailyTotals, debugDates)
    return `Saved ${debugSnapshots.length} fake rows to the isolated debug database.`
  }
  const sitemapRefresh = Effect.runPromise(refreshSitemapPages).catch(() => [])
  const finalizedThrough = datesBeforeToday(1)[0]!
  const tracked = snapshotDateRange()
  const trackingStart = tracked.first ?? dateDaysBefore(finalizedThrough, 27)
  const plan = fetchPlan(datesBetween(trackingStart, finalizedThrough))
  const snapshots = plan.dates.length > 0 ? await Effect.runPromise(fetchSearchConsoleSnapshots(plan.dates)) : []
  saveSnapshots(snapshots, plan.dates)
  const totalDates = [...new Set([...plan.dates, ...missingDailyTotalDates(datesBetween(trackingStart, finalizedThrough))])]
  const totals = totalDates.length > 0 ? await Effect.runPromise(fetchDailyTotals(totalDates)) : { site: [], pages: [] }
  saveDailyTotals(totals, totalDates)
  const registry = await loadRegistry()
  const targetUrls = [...new Set(registry.map((entry) => `https://sleevy.app${entry.targetUrl}`))]
  const freshUrls = new Set(recentlyInspectedUrls(targetUrls, inspectionTtlHours))
  const staleUrls = targetUrls.filter((targetUrl) => !freshUrls.has(targetUrl))
  const inspection = staleUrls.length > 0 ? await Effect.runPromise(fetchPageIndexStatuses(staleUrls)) : { inspections: [], failed: 0 }
  savePageIndexStatuses(inspection.inspections)
  const sitemapPages = await sitemapRefresh
  const inspectionSummary = inspection.failed > 0
    ? `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached); ${inspection.failed} unavailable`
    : `${inspection.inspections.length} indexed-status checks saved (${freshUrls.size} cached)`
  return `Saved ${snapshots.length} Search Console rows across ${plan.dates.length} finalized days (${plan.missing.length} missing, ${plan.recent.length} reconciled); daily totals for ${totalDates.length} days; ${inspectionSummary}; current through ${finalizedThrough}. Sitemap: ${sitemapPages.length || "cached"} pages.`
}

export const backfillSearchConsole = async (months = 16) => {
  if (debugMode) throw new Error("Backfill is unavailable in debug mode; the debug database already contains its full fake history.")
  await Effect.runPromise(ensureDataDirectory)
  const finalizedThrough = datesBeforeToday(1)[0]!
  const retentionStart = dateDaysBefore(finalizedThrough, Math.min(Math.round(months * 30.4), 485))
  const candidates = datesBetween(retentionStart, finalizedThrough)
  const missingSnapshots = missingSnapshotDates(candidates)
  const missingTotals = missingDailyTotalDates(candidates)
  const chunkSize = 30
  let savedRows = 0
  for (let index = 0; index < missingSnapshots.length; index += chunkSize) {
    const chunk = missingSnapshots.slice(index, index + chunkSize)
    const snapshots = await Effect.runPromise(fetchSearchConsoleSnapshots(chunk))
    saveSnapshots(snapshots, chunk)
    savedRows += snapshots.length
  }
  for (let index = 0; index < missingTotals.length; index += chunkSize) {
    const chunk = missingTotals.slice(index, index + chunkSize)
    const totals = await Effect.runPromise(fetchDailyTotals(chunk))
    saveDailyTotals(totals, chunk)
  }
  return `Backfilled ${missingSnapshots.length} days (${savedRows} rows) and daily totals for ${missingTotals.length} days back to ${retentionStart}; current through ${finalizedThrough}.`
}

export const buildWeeklyDigest = async () => {
  await Effect.runPromise(ensureDataDirectory)
  await Effect.runPromise(refreshSitemapPages).catch(() => [])
  const dates = debugMode ? debugDates : fetchPlan(datesBeforeToday(56)).dates
  const snapshots = debugMode ? debugSnapshots : await Effect.runPromise(fetchSearchConsoleSnapshots(dates))
  saveSnapshots(snapshots, dates)
  const registry = await loadRegistry()
  const digest = opportunityDigest(registry)
  const path = `${dataDirectory}/weekly-digest${debugMode ? ".debug" : ""}.json`
  await Bun.write(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...digest }, null, 2)}\n`)
  return `Weekly digest saved: ${digest.signals.length} signals from ${digest.currentStart ?? "—"}–${digest.latestDate ?? "—"}.`
}
