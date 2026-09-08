// Frozen data shapes and errors for the Sites domain.
import { Schema } from "effect"

import { AnalyticsSource } from "../analytics/schema.ts"
import { Market } from "../keyword-metrics/schema.ts"
import { RevenueSource } from "../revenue/schema.ts"

// Stable per-site identifier used in URLs (?site=<id>) and on-disk paths
// (data/sites/<id>/). Branded so a bare string can't be passed where a resolved
// site id is required.
export const SiteId = Schema.String.pipe(Schema.brand("SiteId"))
export type SiteId = typeof SiteId.Type

// A fully-resolved site: the normalized form of a ConfigSite with all derived
// fields filled in (origin without trailing slash, sitemapUrl, brandTerms).
export const Site = Schema.Struct({
  id: SiteId,
  name: Schema.String,
  // The Search Console property string (e.g. "sc-domain:example.com" or a URL).
  property: Schema.String,
  // The site's canonical origin, no trailing slash (e.g. "https://example.com").
  origin: Schema.String,
  sitemapUrl: Schema.String,
  brandTerms: Schema.Array(Schema.String),
  // The resolved analytics source, when the site has one. Optional rather than
  // nullable so every existing Site value (fixtures, the api-client's decode of
  // GET /api/sites against an older server) stays valid as it is.
  analytics: Schema.optional(AnalyticsSource),
  // The resolved revenue source, when the site sells through one. Optional for
  // the same reason.
  revenue: Schema.optional(RevenueSource),
  // The resolved Market its Keyword metrics describe. Always present — every
  // site has one, because an absent setting resolves to the default rather than
  // to nothing. Optional on the schema only so an api-client decoding an older
  // server's `GET /api/sites` still succeeds.
  market: Schema.optional(Market),
}).annotate({ identifier: "Site" })
export interface Site extends Schema.Schema.Type<typeof Site> {}

// Raised when a requested site id is not present in the catalog.
export class UnknownSiteError extends Schema.TaggedErrorClass<UnknownSiteError>()(
  "UnknownSiteError",
  {
    siteId: Schema.String,
    available: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Unknown site "${this.siteId}". Available sites: ${this.available.join(", ")}`
  }
}

// Raised when a site entry cannot be resolved into a Site: an id that is not a
// safe path segment, or a property/origin that is not a URL. Checked before an
// entry is stored, so the catalog never holds an entry the server cannot serve.
export class InvalidSiteError extends Schema.TaggedErrorClass<InvalidSiteError>()(
  "InvalidSiteError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Raised when a site is added under an id the catalog already holds.
export class SiteExistsError extends Schema.TaggedErrorClass<SiteExistsError>()(
  "SiteExistsError",
  {
    siteId: Schema.String,
  },
) {
  override get message() {
    return `A site with id "${this.siteId}" already exists`
  }
}

export * as SitesSchema from "./schema"
