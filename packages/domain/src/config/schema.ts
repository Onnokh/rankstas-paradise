// Frozen data shapes and errors for the Config domain. Downstream tickets code
// against these; do not change them without a versioned migration.
import { Schema } from "effect"

// One entry in the `sites` catalog of config.json. Only `id` and `siteUrl` are
// required; the rest are derived (see the Sites domain) when omitted.
export const ConfigSite = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  siteUrl: Schema.String,
  origin: Schema.optional(Schema.String),
  sitemapUrl: Schema.optional(Schema.String),
  brandTerms: Schema.optional(Schema.Array(Schema.String)),
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
