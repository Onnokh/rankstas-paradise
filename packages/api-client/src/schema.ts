// Wire shapes and typed errors for the Ranksta's Paradise HTTP client.
//
// The response DTOs are the *same* frozen report schemas the server encodes
// (imported from `@rp/domain/reports/schema`), so the client can never drift
// from the server's contract. The HTTP layer wraps every read payload in
// `{ generatedAt, mode, ...payload }`; decoding against the payload schema is
// safe because Effect `Schema.Struct` ignores excess properties on decode, so
// the additive envelope fields fall away.
//
// The job and catalog envelopes (`{ sites }`, `{ jobs }`, `{ job }`) have no
// frozen domain schema, so they are defined here.
import { Schema } from "effect"

import { Site } from "@rp/domain/sites/schema"
import {
  DashboardSnapshot,
  HistoryReport,
  LogAddResult,
  LogListResult,
  OpportunitiesReport,
  PageReport,
  PagesReport,
  QueriesReport,
  RegistryAddResult,
  RegistryListReport,
  RegistrySetResult,
  StatusReport,
} from "@rp/domain/reports/schema"

// Re-export the report DTOs the client decodes against, so consumers get the
// wire contract from one place without reaching into the domain package.
export {
  DashboardSnapshot,
  HistoryReport,
  LogAddResult,
  LogListResult,
  OpportunitiesReport,
  PageReport,
  PagesReport,
  QueriesReport,
  RegistryAddResult,
  RegistryListReport,
  RegistrySetResult,
  StatusReport,
}

// A queued or settled background job (POST /api/jobs/sync|backfill, GET
// /api/jobs). Mirrors the server's Job shape (which isn't exported as a schema).
export const SyncJob = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  siteId: Schema.String,
  status: Schema.Literals(["running", "done", "failed"]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SyncJob" })
export interface SyncJob extends Schema.Schema.Type<typeof SyncJob> {}

// GET /api/sites — the server-side site catalog for the remote site switcher.
export const SitesResponse = Schema.Struct({
  sites: Schema.Array(Site),
}).annotate({ identifier: "SitesResponse" })
export interface SitesResponse
  extends Schema.Schema.Type<typeof SitesResponse> {}

// GET /api/jobs — the process-wide job history.
export const JobsResponse = Schema.Struct({
  jobs: Schema.Array(SyncJob),
}).annotate({ identifier: "JobsResponse" })
export interface JobsResponse extends Schema.Schema.Type<typeof JobsResponse> {}

// POST /api/jobs/sync|backfill — the single queued job.
export const JobResponse = Schema.Struct({
  job: SyncJob,
}).annotate({ identifier: "JobResponse" })
export interface JobResponse extends Schema.Schema.Type<typeof JobResponse> {}

// --- typed errors (three distinct failure modes) ---

// The request could not be sent or no response was received (transport/DNS/
// connection error). Carries the underlying HttpClientError as a defect.
export class ApiClientError extends Schema.TaggedErrorClass<ApiClientError>()(
  "ApiClientError",
  {
    message: Schema.String,
    method: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// The server answered with a non-2xx status. Carries the status and the raw
// response body text for diagnosis.
export class ApiHttpError extends Schema.TaggedErrorClass<ApiHttpError>()(
  "ApiHttpError",
  {
    message: Schema.String,
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
    body: Schema.optional(Schema.String),
  },
) {}

// A 2xx response whose body could not be read or did not match its schema.
export class ApiDecodeError extends Schema.TaggedErrorClass<ApiDecodeError>()(
  "ApiDecodeError",
  {
    message: Schema.String,
    method: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// The client's full error channel.
export type ApiError = ApiClientError | ApiHttpError | ApiDecodeError

export * as ApiClientSchema from "./schema"
