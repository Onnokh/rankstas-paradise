// Data shapes and errors for the server's Jobs service. Ports the legacy
// `Job` record (src/jobs.ts) verbatim in shape; the tagged error replaces the
// legacy `null` return that a single caller turned into an HTTP 409.
import { Schema } from "effect"

import { SiteId } from "@rp/domain/sites/schema"

// The two Google-touching jobs. Each uses delete-then-insert transactions that
// must not interleave — hence the single-job lock in the service.
export const JobName = Schema.Literals(["sync", "backfill"])
export type JobName = typeof JobName.Type

// A job is running until its background work settles, then done or failed.
export const JobStatus = Schema.Literals(["running", "done", "failed"])
export type JobStatus = typeof JobStatus.Type

// One background run. `finishedAt`/`message` are null while running and filled
// in when the work settles (message = the run's summary, or the failure text).
export const Job = Schema.Struct({
  id: Schema.Number,
  name: JobName,
  siteId: SiteId,
  status: JobStatus,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Job" })
export interface Job extends Schema.Schema.Type<typeof Job> {}

// Raised when a second job is started while one is already running — the
// single-job lock is held. The HTTP/MCP surface turns this into a 409.
export class JobAlreadyRunningError extends Schema.TaggedErrorClass<JobAlreadyRunningError>()(
  "JobAlreadyRunningError",
  {},
) {
  override get message() {
    return "A job is already running; only one may run at a time."
  }
}

export * as JobsSchema from "./schema"
