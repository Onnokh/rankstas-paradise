// Frozen data shapes and errors for the Catalog domain: the stored list of
// sites and their settings. The stored entry shape is `ConfigSite` from the
// Config domain (an id plus `SiteSettings`), so a legacy config.json entry and a
// catalog row are the same thing.
import { Schema } from "effect"

// Raised when the catalog database cannot be opened, read, or written.
export class CatalogError extends Schema.TaggedErrorClass<CatalogError>()(
  "CatalogError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as CatalogSchema from "./schema"
