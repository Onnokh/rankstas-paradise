// Frozen data shapes and errors for the KeywordMetrics domain: what DataForSEO
// says about a Keyword, and the Market that answer describes.
//
// Every vendor number here is nullable, and each null means something
// different. A null `searchVolume` means DataForSEO has no volume for the
// keyword — it is too rare to report, not that it has none. A null `difficulty`
// or `intent` usually means the Site's Market is served by Google Ads rather
// than Labs, which reports neither (see ./market.ts). Nothing here treats a
// null as a zero, because "nobody searches this" and "we were not told" lead to
// opposite decisions about a Keyword.
import { Schema } from "effect"

// The one form a keyword is stored, compared, and looked up in. DataForSEO
// answers in lower-case, Search Console reports queries in lower-case, and a
// Registry keyword is typed by hand — so everything is folded to this form
// before it is matched, or the same keyword would be paid for twice and joined
// to neither.
//
// It lives here rather than on the service because Storage folds too, and
// Storage cannot import the service: the service reads Storage.
export const foldKeyword = (keyword: string): string =>
  keyword.trim().toLowerCase().replace(/\s+/g, " ")

// One month of a keyword's volume history, as DataForSEO reports it: the last
// twelve complete months. Kept because seasonality is invisible in the twelve-
// month average that `searchVolume` is — a term with a December peak and a term
// with flat demand can report the same average.
export const MonthlySearch = Schema.Struct({
  year: Schema.Number,
  month: Schema.Number,
  searchVolume: Schema.Number,
}).annotate({ identifier: "MonthlySearch" })
export interface MonthlySearch extends Schema.Schema.Type<typeof MonthlySearch> {}

// A Site's Market as it is stored in Site settings: the DataForSEO country
// code, and optionally the language. The language is optional because every
// country has one primary search language and that is nearly always the right
// answer; the country is not, because there is no country that is a safe guess.
export const ConfigMarket = Schema.Struct({
  locationCode: Schema.Number,
  languageCode: Schema.optional(Schema.String),
}).annotate({ identifier: "ConfigMarket" })
export interface ConfigMarket extends Schema.Schema.Type<typeof ConfigMarket> {}

// A Site's resolved Market: ConfigMarket with its defaults filled and the two
// derived facts a caller would otherwise need the country table for. `label` is
// the country's name, for display. `provider` says which DataForSEO product
// answers, and therefore whether `difficulty` and `intent` can arrive at all —
// a client can say so before it asks, instead of showing empty columns.
export const Market = Schema.Struct({
  locationCode: Schema.Number,
  languageCode: Schema.String,
  label: Schema.String,
  provider: Schema.Literals(["labs", "google-ads"]),
}).annotate({ identifier: "Market" })
export interface Market extends Schema.Schema.Type<typeof Market> {}

// What DataForSEO says about one Keyword in one Market. `keyword` is stored as
// DataForSEO returns it, which is lower-case and trimmed; that is also the form
// this domain looks rows up by, so a Registry keyword is folded before it is
// asked about.
export const KeywordMetric = Schema.Struct({
  keyword: Schema.String,
  locationCode: Schema.Number,
  languageCode: Schema.String,
  // Average monthly searches over the last twelve months.
  searchVolume: Schema.NullOr(Schema.Number),
  // 0-100. How hard the first page is to reach. Labs only.
  difficulty: Schema.NullOr(Schema.Number),
  // What an advertiser pays for a click, in the Market's currency.
  costPerClick: Schema.NullOr(Schema.Number),
  // 0-1. How contested the keyword is among advertisers. Google Ads reports
  // this as a 0-100 index; it is divided down on the way in so one column
  // means one thing whichever product answered.
  competition: Schema.NullOr(Schema.Number),
  // "informational", "navigational", "commercial", or "transactional". Labs
  // only. Deliberately a string and not a Literals union: this is a vendor
  // vocabulary, and a new value must not fail a decode of the whole ledger.
  intent: Schema.NullOr(Schema.String),
  monthlySearches: Schema.Array(MonthlySearch),
  fetchedAt: Schema.String,
}).annotate({ identifier: "KeywordMetric" })
export interface KeywordMetric extends Schema.Schema.Type<typeof KeywordMetric> {}

// What one refresh did. Reported rather than returned as rows because the
// caller is Sync, which wants to log a line, not read metrics.
export const KeywordMetricsRefresh = Schema.Struct({
  // Keywords asked about, after folding, de-duplication, and the cache cutoff.
  asked: Schema.Number,
  // Keywords DataForSEO answered for. Lower than `asked` when it has no data.
  answered: Schema.Number,
  // Requests actually sent, each one billed.
  requests: Schema.Number,
}).annotate({ identifier: "KeywordMetricsRefresh" })
export interface KeywordMetricsRefresh
  extends Schema.Schema.Type<typeof KeywordMetricsRefresh> {}

// Raised when DataForSEO cannot be reached, rejects the request, or answers
// something this domain cannot read.
export class KeywordMetricsError extends Schema.TaggedErrorClass<KeywordMetricsError>()(
  "KeywordMetricsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Raised when a Site's Market names a country DataForSEO does not serve, or a
// language it does not serve for that country. Separate from the error above
// because it is a settings mistake, not a vendor failure, and because catching
// it costs nothing while letting it through costs a charged task.
export class UnservedMarketError extends Schema.TaggedErrorClass<UnservedMarketError>()(
  "UnservedMarketError",
  {
    locationCode: Schema.Number,
    languageCode: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason
  }
}

export * as KeywordMetricsSchema from "./schema"
