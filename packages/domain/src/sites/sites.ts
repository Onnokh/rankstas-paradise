// Sites service: loads and resolves the site catalog from config. Read-only and
// process-global (the catalog is the same for everyone); the *active* site is a
// separate per-scope concern — see CurrentSite.
import { Context, Effect, Layer } from "effect"

import {
  type AnalyticsSource,
  type ConfigAnalytics,
  defaultTimeZone,
} from "../analytics/schema.ts"
import { Config } from "../config/config.ts"
import { type ConfigSite } from "../config/schema.ts"
import {
  type ConfigRevenue,
  defaultKeyVariable,
  type RevenueSource,
} from "../revenue/schema.ts"
import { serviceUse } from "../service-use.ts"
import { Site, SiteId, UnknownSiteError } from "./schema.ts"

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
// and the analytics and revenue sources when the entry has them.
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
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    // A failure to read config is a bug for the caller (missing setup), not a
    // typed outcome of asking for the catalog — mirror the legacy behaviour and
    // turn it into a defect so `loadSites` stays error-free.
    const loadSites = Effect.fn("Sites.loadSites")(function* () {
      const resolved = yield* Effect.orDie(config.load())
      const configured = (resolved.sites ?? []).map(normalize)
      if (configured.length > 0) return configured
      // Legacy single-site config: only `siteUrl`, no `sites` array. Derive one
      // site from the hostname's first label — no hardcoded property.
      const id = new URL(originFor(resolved.siteUrl)).hostname.split(".")[0]!
      return [normalize({ id, siteUrl: resolved.siteUrl })]
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

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Sites from "./sites"
