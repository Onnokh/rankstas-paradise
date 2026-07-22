// Frozen data shapes and errors for the Sites domain.
import { Schema } from "effect"

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

export * as SitesSchema from "./schema"
