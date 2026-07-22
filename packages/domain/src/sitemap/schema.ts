// Frozen data shapes and errors for the Sitemap domain.
import { Schema } from "effect"

// One <url> entry parsed from the site's sitemap.xml.
export const SitemapPage = Schema.Struct({
  url: Schema.String,
  path: Schema.String,
  lastModified: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SitemapPage" })
export interface SitemapPage extends Schema.Schema.Type<typeof SitemapPage> {}

// Raised when the sitemap cannot be fetched, read, or cached.
export class SitemapError extends Schema.TaggedErrorClass<SitemapError>()(
  "SitemapError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as SitemapSchema from "./schema"
