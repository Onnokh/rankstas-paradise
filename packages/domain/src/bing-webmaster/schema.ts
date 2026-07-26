// Frozen data shapes and errors for the Bing Webmaster API boundary.
import { Schema } from "effect"

export const BingSiteDailyTotal = Schema.Struct({
  date: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
}).annotate({ identifier: "BingSiteDailyTotal" })
export interface BingSiteDailyTotal
  extends Schema.Schema.Type<typeof BingSiteDailyTotal> {}

export const BingQueryWindowRow = Schema.Struct({
  query: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
  position: Schema.Number,
}).annotate({ identifier: "BingQueryWindowRow" })
export interface BingQueryWindowRow
  extends Schema.Schema.Type<typeof BingQueryWindowRow> {}

export class BingAuthError extends Schema.TaggedErrorClass<BingAuthError>()(
  "BingAuthError",
  {
    message: Schema.String,
    errorCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class BingHttpError extends Schema.TaggedErrorClass<BingHttpError>()(
  "BingHttpError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class BingDecodeError extends Schema.TaggedErrorClass<BingDecodeError>()(
  "BingDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type BingError = BingAuthError | BingHttpError | BingDecodeError

export const BingUrlInfo = Schema.Struct({
  targetUrl: Schema.String,
  discoveredAt: Schema.NullOr(Schema.String),
  lastCrawledAt: Schema.NullOr(Schema.String),
  anchorCount: Schema.Number,
  documentSize: Schema.Number,
  inIndex: Schema.Boolean,
}).annotate({ identifier: "BingUrlInfo" })
export interface BingUrlInfo extends Schema.Schema.Type<typeof BingUrlInfo> {}

export const BingUrlInfoInspection = Schema.Struct({
  infos: Schema.Array(BingUrlInfo),
  failed: Schema.Number,
}).annotate({ identifier: "BingUrlInfoInspection" })
export interface BingUrlInfoInspection
  extends Schema.Schema.Type<typeof BingUrlInfoInspection> {}

export * as BingWebmasterSchema from "./schema"
