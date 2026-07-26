// Frozen data shapes and errors for the Bing Webmaster API boundary.
import { Schema } from "effect"

export const BingSiteDailyTotal = Schema.Struct({
  date: Schema.String,
  clicks: Schema.Number,
  impressions: Schema.Number,
}).annotate({ identifier: "BingSiteDailyTotal" })
export interface BingSiteDailyTotal
  extends Schema.Schema.Type<typeof BingSiteDailyTotal> {}

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

export * as BingWebmasterSchema from "./schema"
