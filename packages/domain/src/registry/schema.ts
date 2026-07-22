// Frozen data shapes and errors for the Registry domain — the per-site keyword
// plan, persisted as a versioned CSV (see schema.v1.ts). The in-memory
// RegistryEntry is the current domain model; the on-disk encoding is versioned
// separately so old files stay readable without migration code.
import { Schema } from "effect"

// One registry row. Every field is a string (the CSV is the source of truth);
// empty strings mean "unset". `targetUrl` is a site-relative path ("/foo").
export const RegistryEntry = Schema.Struct({
  cluster: Schema.String,
  keyword: Schema.String,
  targetUrl: Schema.String,
  intent: Schema.String,
  whyOpportunity: Schema.String,
  country: Schema.String,
  priority: Schema.String,
  publishedAt: Schema.String,
  baselineDate: Schema.String,
  status: Schema.String,
}).annotate({ identifier: "RegistryEntry" })
export interface RegistryEntry
  extends Schema.Schema.Type<typeof RegistryEntry> {}

// A partial update to matching rows. All fields optional; `newTargetUrl`
// re-points the row to a different path.
export const RegistryPatch = Schema.Struct({
  cluster: Schema.optional(Schema.String),
  intent: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
  publishedAt: Schema.optional(Schema.String),
  baselineDate: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  whyOpportunity: Schema.optional(Schema.String),
  newTargetUrl: Schema.optional(Schema.String),
}).annotate({ identifier: "RegistryPatch" })
export interface RegistryPatch
  extends Schema.Schema.Type<typeof RegistryPatch> {}

// Raised for a malformed CSV, an invalid field (commas/newlines/bad date/path),
// a duplicate keyword or inventory row, or a no-op update.
export class RegistryError extends Schema.TaggedErrorClass<RegistryError>()(
  "RegistryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as RegistrySchema from "./schema"
