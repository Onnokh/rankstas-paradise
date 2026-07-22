// Frozen data shapes and errors for the SearchConsole domain — the Google
// Search Console + URL Inspection API boundary.
import { Schema } from "effect"

// One query/page/device/country row for a single day.
export const DailySnapshot = Schema.Struct({
  date: Schema.String,
  query: Schema.String,
  page: Schema.String,
  device: Schema.String,
  country: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "DailySnapshot" })
export interface DailySnapshot
  extends Schema.Schema.Type<typeof DailySnapshot> {}

// Site-wide totals for a day (no query dimension → includes anonymized long tail).
export const SiteDailyTotal = Schema.Struct({
  date: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "SiteDailyTotal" })
export interface SiteDailyTotal
  extends Schema.Schema.Type<typeof SiteDailyTotal> {}

// Per-page totals for a day (site totals broken down by page, no query dimension).
export const PageDailyTotal = Schema.Struct({
  date: Schema.String,
  page: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "PageDailyTotal" })
export interface PageDailyTotal
  extends Schema.Schema.Type<typeof PageDailyTotal> {}

export const DailyTotals = Schema.Struct({
  site: Schema.Array(SiteDailyTotal),
  pages: Schema.Array(PageDailyTotal),
}).annotate({ identifier: "DailyTotals" })
export interface DailyTotals extends Schema.Schema.Type<typeof DailyTotals> {}

export const PageIndexStatus = Schema.Struct({
  targetUrl: Schema.String,
  status: Schema.Literals(["indexed", "not-indexed", "unknown"]),
  verdict: Schema.String,
  coverageState: Schema.String,
}).annotate({ identifier: "PageIndexStatus" })
export interface PageIndexStatus
  extends Schema.Schema.Type<typeof PageIndexStatus> {}

// Result of a batch URL-inspection: the statuses that succeeded, plus a count
// of URLs that could not be inspected.
export const PageIndexInspection = Schema.Struct({
  inspections: Schema.Array(PageIndexStatus),
  failed: Schema.Number,
}).annotate({ identifier: "PageIndexInspection" })
export interface PageIndexInspection
  extends Schema.Schema.Type<typeof PageIndexInspection> {}

// --- errors: auth / http / decode ---

// The Google connection is missing, expired, or refused a refresh.
export class SearchConsoleAuthError extends Schema.TaggedErrorClass<SearchConsoleAuthError>()(
  "SearchConsoleAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// A Search Console / OAuth HTTP request failed (non-2xx or transport error).
export class SearchConsoleHttpError extends Schema.TaggedErrorClass<SearchConsoleHttpError>()(
  "SearchConsoleHttpError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// A Search Console response did not match its expected shape.
export class SearchConsoleDecodeError extends Schema.TaggedErrorClass<SearchConsoleDecodeError>()(
  "SearchConsoleDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type SearchConsoleError =
  | SearchConsoleAuthError
  | SearchConsoleHttpError
  | SearchConsoleDecodeError

export * as SearchConsoleSchema from "./schema"
