// Frozen data shapes and errors for the Domain Rating domain.
//
// Domain Rating is Ahrefs' 0–100 logarithmic score for the strength of a site's
// backlink profile. It is the one number in Ranksta's Paradise that does not
// come from Google Search Console, and Ahrefs requires it to be attributed —
// see `license`, which their API returns alongside the score and which the
// front-ends must show.
import { Schema } from "effect"

export const DomainRating = Schema.Struct({
  // What was asked about: the site's bare host, e.g. "sleevy.app".
  target: Schema.String,
  // 0–100 on a logarithmic scale, so a 60 is far more than twice a 30.
  rating: Schema.Number,
  // When Ahrefs was asked, not when the score changed — Ahrefs does not report
  // the latter. Domain Rating moves on the order of weeks, so a reading hours
  // old is still current; this exists so a stale one can be recognised.
  fetchedAt: Schema.String,
  // The licence URL Ahrefs returns. Their terms require it to be carried with
  // the number, so it travels in the DTO rather than being hardcoded in a view.
  license: Schema.String,
}).annotate({ identifier: "DomainRating" })
export interface DomainRating extends Schema.Schema.Type<typeof DomainRating> {}

// Raised when a refresh cannot complete. Reads never fail: a site with no
// reading yields null, because Domain Rating is supplementary and its absence
// must not cost the caller a dashboard.
export class DomainRatingError extends Schema.TaggedErrorClass<DomainRatingError>()(
  "DomainRatingError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// One day of the accumulated series. Only the number and its day: the target
// and licence belong to the current reading, not repeated per point.
export const DomainRatingDay = Schema.Struct({
  date: Schema.String,
  rating: Schema.Number,
}).annotate({ identifier: "DomainRatingDay" })
export interface DomainRatingDay
  extends Schema.Schema.Type<typeof DomainRatingDay> {}

export * as DomainRatingSchema from "./schema"
