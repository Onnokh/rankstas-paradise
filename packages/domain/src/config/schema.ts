// Frozen data shapes and errors for the Config domain. Downstream tickets code
// against these; do not change them without a versioned migration.
import { Schema } from "effect"

import { ConfigAnalytics } from "../analytics/schema.ts"
import { ConfigMarket } from "../keyword-metrics/schema.ts"
import { ConfigRevenue } from "../revenue/schema.ts"

// The editable settings of one site: everything a site entry holds except its
// id. Only `siteUrl` is required; the rest is derived (see the Sites domain)
// when omitted. This is the payload a settings page sends, and the shape the
// Catalog stores.
export const SiteSettings = Schema.Struct({
  name: Schema.optional(Schema.String),
  siteUrl: Schema.String,
  origin: Schema.optional(Schema.String),
  sitemapUrl: Schema.optional(Schema.String),
  brandTerms: Schema.optional(Schema.Array(Schema.String)),
  // The site's web-analytics provider, one per site. Absent means the site has
  // no analytics and every report simply omits visits. The API key is NOT here:
  // like the Ahrefs key it lives in the environment, read by the adapter.
  analytics: Schema.optional(ConfigAnalytics),
  // The site's commerce provider, one per site, on the same terms: absent
  // means no revenue, and the key lives in the environment under the variable
  // `keyVariable` names (default `<PROVIDER>_API_KEY`).
  revenue: Schema.optional(ConfigRevenue),
  // The country and language the site's Keyword metrics describe. Absent means
  // the United States in English (see ../keyword-metrics/market.ts). One per
  // site, not one per Keyword: a site sells into one search market, and a
  // Keyword's volume is only comparable to another Keyword's in the same one.
  market: Schema.optional(ConfigMarket),
}).annotate({ identifier: "SiteSettings" })
export interface SiteSettings extends Schema.Schema.Type<typeof SiteSettings> {}

// One entry in the site catalog: an id plus its settings. Also the shape of an
// entry in the `sites` array of a legacy config.json, which the Catalog imports
// once.
export const ConfigSite = Schema.Struct({
  id: Schema.String,
  ...SiteSettings.fields,
}).annotate({ identifier: "ConfigSite" })
export interface ConfigSite extends Schema.Schema.Type<typeof ConfigSite> {}

// The resolved application config. Google credentials are not part of it: auth
// is a service-account key file on the volume, read directly by the
// SearchConsole service, so nothing secret passes through here.
export const SeoConfig = Schema.Struct({
  siteUrl: Schema.String,
  sites: Schema.optional(Schema.Array(ConfigSite)),
}).annotate({ identifier: "SeoConfig" })
export interface SeoConfig extends Schema.Schema.Type<typeof SeoConfig> {}

// Raised when config.json is missing, unreadable, or missing a required field.
export class ConfigLoadError extends Schema.TaggedErrorClass<ConfigLoadError>()(
  "ConfigLoadError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as ConfigSchema from "./schema"
