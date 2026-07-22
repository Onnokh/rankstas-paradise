// Frozen constants and errors for the Sync domain.
import { Schema } from "effect"

// Search Console revises recent days and index verdicts change slowly, so data
// refreshed within this window is reused instead of re-fetched. Also the
// freshness gate for the server's read-triggered warm sync.
export const reconciliationTtlHours = 6

// Raised when a sync or backfill run fails (wraps the underlying SearchConsole/
// Storage/Registry/Sitemap failure).
export class SyncError extends Schema.TaggedErrorClass<SyncError>()(
  "SyncError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as SyncSchema from "./schema"
