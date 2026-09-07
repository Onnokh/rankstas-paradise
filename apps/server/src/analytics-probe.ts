// Run one analytics adapter against a real provider and print what comes back,
// in the canonical shapes Storage would receive. For checking a site's setup
// (key, site id, base URL) before or after a deploy, from a shell that has the
// provider's key in its environment. Reads nothing from config.json and writes
// nothing anywhere.
//
//   RYBBIT_API_KEY=… bun run apps/server/src/analytics-probe.ts \
//     --provider rybbit --site-id 63f063c7a6e7 \
//     --base-url https://rybbit.missingmounts.com --time-zone Europe/Amsterdam \
//     --days 3
//
// Prints a JSON document: the status the port would report, the dates asked,
// the site rows, the top pages per day, and the events per day.
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { Analytics } from "@rp/domain/analytics/analytics"
import { type AnalyticsSource } from "@rp/domain/analytics/schema"
import { CurrentSite } from "@rp/domain/sites/current-site"
import { type Site, SiteId } from "@rp/domain/sites/schema"

const flag = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const provider = flag("provider", "rybbit")!
const siteId = flag("site-id")
const baseUrl = flag("base-url") ?? null
const timeZone = flag("time-zone", "UTC")!
const days = Number(flag("days", "3"))
const topPages = Number(flag("top", "10"))

if (!siteId) {
  console.error(
    "Usage: bun run apps/server/src/analytics-probe.ts --provider rybbit --site-id <id> [--base-url <origin>] [--time-zone <zone>] [--days 3] [--top 10]",
  )
  process.exit(2)
}

const analytics: AnalyticsSource = { provider, siteId, baseUrl, timeZone }

// The probe stands in for a configured site; only `analytics` matters here.
const site: Site = {
  id: SiteId.make("probe"),
  name: "probe",
  property: "sc-domain:probe.invalid",
  origin: "https://probe.invalid",
  sitemapUrl: "https://probe.invalid/sitemap.xml",
  brandTerms: [],
  analytics,
}

// The last `days` whole days, ending yesterday (UTC), oldest first — the same
// window the first sync would ask for, shortened.
const dates = Array.from({ length: days }, (_, index) => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days + index)
  return date.toISOString().slice(0, 10)
})

const layer = Analytics.layer.pipe(
  Layer.provide(
    Layer.mock(CurrentSite.Service)({ current: () => Effect.succeed(site) }),
  ),
  Layer.provide(FetchHttpClient.layer),
)

const program = Effect.gen(function* () {
  const status = yield* Analytics.use.status()
  if (!status?.ready) return { status, dates, error: status?.reason ?? "no analytics" }
  const visits = yield* Analytics.use.fetchVisits(dates)
  const pagesByDay = Object.fromEntries(
    dates.map((date) => [
      date,
      visits.pages
        .filter((row) => row.date === date)
        .sort((left, right) => right.pageviews - left.pageviews)
        .slice(0, topPages)
        .map(({ page, pageviews, visits: v }) => ({ page, pageviews, visits: v })),
    ]),
  )
  const eventsByDay = Object.fromEntries(
    dates.map((date) => [
      date,
      visits.events
        .filter((row) => row.date === date)
        .sort((left, right) => right.count - left.count)
        .map(({ name, count }) => ({ name, count })),
    ]),
  )
  return {
    status,
    dates,
    site: visits.site,
    pageRows: visits.pages.length,
    pagesByDay,
    eventsByDay,
  }
})

const result = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))
if (result._tag === "Success") {
  console.log(JSON.stringify(result.value, null, 2))
} else {
  console.error(String(result.cause))
  process.exit(1)
}
