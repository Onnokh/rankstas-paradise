// Sites service: resolves the site catalog into Sites. Read-only and
// process-global (the catalog is the same for everyone); the *active* site is a
// separate per-scope concern — see CurrentSite.
//
// The entries come from the Catalog (the app-level database). A legacy
// config.json is imported into the catalog once, the first time the catalog is
// read while empty; after that the file is not consulted again.
import { Context, Effect, Layer } from "effect"

import {
  type AnalyticsSource,
  type ConfigAnalytics,
  defaultTimeZone,
} from "../analytics/schema.ts"
import { Catalog } from "../catalog/catalog.ts"
import { Config } from "../config/config.ts"
import { type ConfigSite } from "../config/schema.ts"
import { Market } from "../keyword-metrics/market.ts"
import {
  type ConfigRevenue,
  defaultKeyVariable,
  type RevenueSource,
} from "../revenue/schema.ts"
import { serviceUse } from "../service-use.ts"
import { InvalidSiteError, Site, SiteId, UnknownSiteError } from "./schema.ts"

export interface Interface {
  // The full catalog, normalized. Legacy single-site config yields one site.
  readonly loadSites: () => Effect.Effect<ReadonlyArray<Site>>
  // Resolve one site by id, or fail if it is not in the catalog.
  readonly siteFor: (id: SiteId) => Effect.Effect<Site, UnknownSiteError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Sites") {}

export const use = serviceUse(Service)

// The site's origin: an explicit override wins; otherwise a `sc-domain:` property
// is expanded to `https://<host>`, and a URL property is used verbatim.
const originFor = (siteUrl: string, explicitOrigin?: string): string =>
  explicitOrigin ??
  (siteUrl.startsWith("sc-domain:")
    ? `https://${siteUrl.slice("sc-domain:".length)}`
    : siteUrl)

// The analytics block with its defaults filled: no base URL means the vendor's
// cloud origin (the adapter knows it), no time zone means UTC.
const analyticsFor = (analytics: ConfigAnalytics): AnalyticsSource => ({
  provider: analytics.provider,
  siteId: analytics.siteId,
  baseUrl: analytics.baseUrl?.replace(/\/$/, "") ?? null,
  timeZone: analytics.timeZone ?? defaultTimeZone,
})

// The revenue block with its defaults filled: no account id means the token
// is scoped to one already, no key variable means `<PROVIDER>_API_KEY`, no
// base URL means the vendor's production API, and no time zone means the
// site's analytics zone (so an order and its visit fall on the same day), else
// UTC.
const revenueFor = (
  revenue: ConfigRevenue,
  analytics: AnalyticsSource | undefined,
): RevenueSource => ({
  provider: revenue.provider,
  accountId: revenue.accountId ?? null,
  keyVariable: revenue.keyVariable ?? defaultKeyVariable(revenue.provider),
  baseUrl: revenue.baseUrl?.replace(/\/$/, "") ?? null,
  timeZone: revenue.timeZone ?? analytics?.timeZone ?? defaultTimeZone,
})

// Fill in every derived field: origin (no trailing slash), sitemapUrl
// (defaults to https://<hostname>/sitemap.xml), brandTerms (defaults to [id]),
// the Market, and the analytics and revenue sources when the entry has them.
// Throws when the origin is not a URL; `resolve` below is the checked form.
const normalize = (site: ConfigSite): Site => {
  const origin = originFor(site.siteUrl, site.origin)
  const hostname = new URL(origin).hostname
  const analytics = site.analytics ? analyticsFor(site.analytics) : undefined
  return {
    id: SiteId.make(site.id),
    name: site.name ?? site.id,
    property: site.siteUrl,
    origin: origin.replace(/\/$/, ""),
    sitemapUrl: site.sitemapUrl ?? `https://${hostname}/sitemap.xml`,
    brandTerms: site.brandTerms ?? [site.id],
    ...(analytics ? { analytics } : {}),
    ...(site.revenue ? { revenue: revenueFor(site.revenue, analytics) } : {}),
    // Resolved through the Market table rather than here, so the settings
    // surface and every report agree on what an absent Market means.
    market: Market.resolve(site.market),
  }
}

// A site id is a URL query value and a directory name under `sites/`, so it is
// limited to lower-case letters, digits, and hyphens.
const siteIdPattern = /^[a-z0-9][a-z0-9-]*$/

// Resolve a catalog entry into a Site, or say why it cannot be served. Run
// before an entry is stored, so `loadSites` never meets an entry it cannot
// normalize.
export const resolve = (site: ConfigSite): Effect.Effect<Site, InvalidSiteError> =>
  Effect.gen(function* () {
    if (!siteIdPattern.test(site.id))
      return yield* new InvalidSiteError({
        message: `Site id "${site.id}" must be lower-case letters, digits, and hyphens`,
      })
    if (site.siteUrl.trim() === "")
      return yield* new InvalidSiteError({ message: "siteUrl is required" })
    return yield* Effect.try({
      try: () => normalize(site),
      catch: (cause) =>
        new InvalidSiteError({
          message: `Site "${site.id}" has no valid origin: "${originFor(site.siteUrl, site.origin)}" is not a URL`,
          cause,
        }),
    })
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service

    // The entries a legacy config.json contributes: its `sites` array, or one
    // site derived from a bare `siteUrl` (the hostname's first label as id).
    // Null when there is no file and no SITE_URL — nothing to import. Any
    // other load failure (unreadable, malformed) is a defect: the file exists
    // and is wrong, which must not be silently skipped.
    const legacySites = Effect.gen(function* () {
      const loaded = yield* config.load().pipe(
        Effect.map((resolved) => ({ resolved, missing: false as const })),
        Effect.catchTag("ConfigLoadError", (error) =>
          // Config.load's missing-config error is the "nothing to import" case.
          error.message.startsWith("Missing config")
            ? Effect.succeed({ resolved: null, missing: true as const })
            : Effect.die(error),
        ),
      )
      if (loaded.missing) return null
      const configured = loaded.resolved.sites ?? []
      if (configured.length > 0) return configured
      const id = new URL(originFor(loaded.resolved.siteUrl)).hostname.split(".")[0]!
      return [{ id, siteUrl: loaded.resolved.siteUrl }] satisfies ReadonlyArray<ConfigSite>
    })

    // A failure to read the catalog is a bug for the caller (missing setup), not
    // a typed outcome of asking for the catalog — turn it into a defect so
    // `loadSites` stays error-free.
    const loadSites = Effect.fn("Sites.loadSites")(function* () {
      const stored = yield* Effect.orDie(catalog.list())
      if (stored.length > 0) return stored.map(normalize)
      const legacy = yield* legacySites
      const imported = yield* Effect.orDie(catalog.importOnce(legacy ?? []))
      if (!imported) return []
      if (legacy && legacy.length > 0)
        yield* Effect.logInfo(
          `Imported ${legacy.length} site(s) from config.json into the catalog; the file is not read again.`,
        )
      return (yield* Effect.orDie(catalog.list())).map(normalize)
    })

    const siteFor = Effect.fn("Sites.siteFor")(function* (id: SiteId) {
      const sites = yield* loadSites()
      const site = sites.find((candidate) => candidate.id === id)
      if (!site)
        return yield* new UnknownSiteError({
          siteId: id,
          available: sites.map((candidate) => candidate.id),
        })
      return site
    })

    return { loadSites, siteFor }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Catalog.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Sites from "./sites"
