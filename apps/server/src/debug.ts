// The deterministic debug fixture dataset, copied verbatim from the legacy
// `src/debug.ts` (only the type imports are repointed at the new domain search
// -console schema). In `--debug` mode the server seeds Storage from this data so
// every report renders against a fixed, offline dataset — the golden suite's
// oracle. Kept debug-only; nothing here touches Google.
import {
  type DailySnapshot,
  type DailyTotals,
  type PageDailyTotal,
  type SiteDailyTotal,
} from "@rp/domain/search-console/schema"

const endDate = new Date("2026-07-12T00:00:00.000Z")
const dates = Array.from({ length: 56 }, (_, index) => {
  const date = new Date(endDate)
  date.setUTCDate(date.getUTCDate() - 55 + index)
  return date.toISOString().slice(0, 10)
})

const row = (
  date: string,
  query: string,
  page: string,
  impressions: number,
  clicks: number,
  position: number,
): DailySnapshot => ({
  date,
  query,
  page: `https://sleevy.app${page}`,
  device: "MOBILE",
  country: "USA",
  impressions,
  clicks,
  ctr: clicks / impressions,
  position,
})

const daily = (
  query: string,
  page: string,
  values: (day: number) => readonly [number, number, number],
) =>
  dates.map((date, day) => {
    const [impressions, clicks, position] = values(day)
    return row(date, query, page, impressions, clicks, position)
  })

export const debugSnapshots: ReadonlyArray<DailySnapshot> = [
  // Striking distance: mapped page is already close, with meaningful upward demand.
  ...daily("pocket alternative", "/pocket-alternative", (day) => [55 + day * 3, 3 + Math.floor(day / 11), 14 - day * 0.12]),
  ...daily("pocket replacement", "/pocket-alternative", (day) => [32 + day * 2, 2 + Math.floor(day / 18), 15.5 - day * 0.08]),

  // CTR opportunity: strong rank and demand, deliberately weak click-through rate.
  ...daily("chrome read later extension", "/chrome-extension", (day) => [260 + day * 6, 7 + Math.floor(day / 20), 4.9 - day * 0.01]),
  ...daily("save tabs for later chrome", "/chrome-extension", (day) => [38 + day, 2 + Math.floor(day / 24), 13.8 - day * 0.03]),

  // Existing mapped opportunity with a steady improving trend.
  ...daily("save links from iphone", "/ios-app", (day) => [45 + day * 2, 2 + Math.floor(day / 16), 12.6 - day * 0.09]),
  ...daily("ios share sheet read later app", "/ios-app", (day) => [18 + day, 1 + Math.floor(day / 21), 17.2 - day * 0.06]),

  // New demand: not in the registry, growing quickly but currently rank 11–20.
  ...daily("raindrop alternative", "/pocket-alternative", (day) => [12 + day * 4, Math.floor(day / 20), 19 - day * 0.09]),
  ...daily("bookmark organizer mac", "/", (day) => [8 + day * 3, Math.floor(day / 22), 18.5 - day * 0.08]),

  // Cannibalization: one query split across two Sleevy URLs.
  ...daily("read later app", "/ios-app", (day) => [38 + day, 2 + Math.floor(day / 18), 9.8 - day * 0.03]),
  ...daily("read later app", "/chrome-extension", (day) => [31 + day, 1 + Math.floor(day / 21), 11.5 - day * 0.02]),

  // Lower-volume existing mapping to keep a realistic long tail.
  ...daily("raycast save links", "/raycast", (day) => [10 + day, Math.floor(day / 23), 19.5 - day * 0.04]),
  ...daily("read later api", "/docs", (day) => [9 + Math.floor(day * 1.5), Math.floor(day / 25), 16 - day * 0.05]),

  // Brand query is intentionally present; opportunity filters should exclude it.
  ...daily("sleevy chrome extension", "/chrome-extension", (day) => [70 + day * 2, 22 + Math.floor(day / 5), 2.2]),
]

// Every date present in the fixture, used as the "fetched" set when seeding.
export const debugDates: ReadonlyArray<string> = [
  ...new Set(debugSnapshots.map((snapshot) => snapshot.date)),
]

// True daily totals exceed the sum of query rows because Google withholds
// anonymized long-tail queries; the debug data simulates that with a 25% uplift.
export const debugDailyTotals: DailyTotals = (() => {
  const anonymizedUplift = 1.25
  const pageBuckets = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>()
  for (const snapshot of debugSnapshots) {
    const key = `${snapshot.date} ${snapshot.page}`
    const bucket = pageBuckets.get(key) ?? { clicks: 0, impressions: 0, weightedPosition: 0 }
    bucket.clicks += snapshot.clicks
    bucket.impressions += snapshot.impressions
    bucket.weightedPosition += snapshot.position * snapshot.impressions
    pageBuckets.set(key, bucket)
  }
  const pages: Array<PageDailyTotal> = [...pageBuckets.entries()].map(([key, bucket]) => {
    const [date, page] = key.split(" ") as [string, string]
    const impressions = Math.round(bucket.impressions * anonymizedUplift)
    return {
      date,
      page,
      clicks: bucket.clicks,
      impressions,
      ctr: impressions > 0 ? bucket.clicks / impressions : 0,
      position: bucket.impressions > 0 ? bucket.weightedPosition / bucket.impressions : 0,
    }
  })
  const siteBuckets = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>()
  for (const page of pages) {
    const bucket = siteBuckets.get(page.date) ?? { clicks: 0, impressions: 0, weightedPosition: 0 }
    bucket.clicks += page.clicks
    bucket.impressions += page.impressions
    bucket.weightedPosition += page.position * page.impressions
    siteBuckets.set(page.date, bucket)
  }
  const site: Array<SiteDailyTotal> = [...siteBuckets.entries()].map(([date, bucket]) => ({
    date,
    clicks: bucket.clicks,
    impressions: bucket.impressions,
    ctr: bucket.impressions > 0 ? bucket.clicks / bucket.impressions : 0,
    position: bucket.impressions > 0 ? bucket.weightedPosition / bucket.impressions : 0,
  }))
  return { site, pages }
})()
