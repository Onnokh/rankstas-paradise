// Frozen errors for the AppDatabase domain: the one app-level SQLite database
// the Catalog and Secrets services share.
import { Schema } from "effect"

// Raised when the app-level database cannot be opened.
export class AppDatabaseError extends Schema.TaggedErrorClass<AppDatabaseError>()(
  "AppDatabaseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export * as AppDatabaseSchema from "./schema"
