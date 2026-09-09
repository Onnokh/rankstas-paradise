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

// Words that carry no meaning of their own in a search phrase. Kept short on
// purpose: every word dropped here merges two keywords that a reader can still
// tell apart, so the list holds only articles and prepositions.
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "for",
  "in",
  "on",
  "of",
  "to",
  "is",
  "and",
  "with",
  "your",
])

/**
 * The shape of a query, for adding volumes up — NEVER for storing or matching.
 *
 * DataForSEO answers a seed with every word order it has a number for, and
 * bills for each: `background design for website`, `design background website`
 * and `website design background` come back as three rows of 210 a month. They
 * are one query. Google ranks one page for all three, so summing the rows
 * reports 630 a month of demand that a page can only win once.
 *
 * That mattered more than it sounds. On 2026-09-09 shadertown's plan claimed
 * 1,470 a month behind `/3d-background` for a query worth 390, and its total
 * addressable demand read 28,880 against a true 22,290 — a fifth of the number
 * a decision would be made on. So volume totals group on this shape and count
 * each group once.
 *
 * Word order goes, articles and prepositions go, and a trailing plural `s`
 * goes. It is deliberately blunt: it exists to stop a total being wrong by a
 * fifth, not to model English. Anything it merges wrongly costs one row in a
 * sum; anything it fails to merge leaves the old over-count, which is the
 * safer direction to be wrong in.
 *
 * Not a storage key. `foldKeyword` is what a keyword is stored, matched and
 * paid for under — two different queries can share a shape, and joining on
 * this would hand one keyword's metrics to another.
 */
export const queryShape = (keyword: string): string =>
  foldKeyword(keyword)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !QUERY_STOPWORDS.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    )
    .sort()
    .join(" ")

// One month of a keyword's volume history, as DataForSEO reports it.
//
// The series is long: a live call on 2026-09-08 returned 94 months per keyword,
// running back to 2018-10, and its length is theirs to decide rather than a
// number this domain can rely on. It is not twelve months, which is what the
// comments here claimed until a live call was made — the fakes every other test
// runs against returned two months because that is what they were written to
// return, so nothing caught it. See scripts/dataforseo-probe.ts.
//
// Kept whole because seasonality and trend are both invisible in the
// twelve-month average that `searchVolume` is: a term with a December peak and
// a term with flat demand can report the same average, and a term that has
// halved over three years can report the same average as one that has doubled.
// Eight years is what makes the second question answerable, so it is not
// truncated on the way in.
//
// It is deliberately NOT read on the paths that only want a scalar. See
// Storage.keywordMetrics.
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
  // Average monthly searches over the newest twelve months — this one really is
  // twelve, unlike `monthlySearches` above. The same live call returned a
  // headline of 110,000 against a mean of 106,908 over the newest twelve
  // entries, where the mean over all 94 was 25,806. The headline and the series
  // answer different questions, and conflating them would read an eight-year
  // decline as current demand.
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

// A stored metric without its monthly series: every scalar, none of the ~94
// months. This is what reads return, because nothing that reads today wants the
// series and parsing it is not free — the Opportunity digest reads every row on
// every dashboard load, and at ~4.3 kB of JSON a keyword a 700-keyword site
// would mean parsing about 3 MB into some 70,000 objects to use three numbers.
//
// The series is still stored. It gets its own read when the surface that needs
// it lands; it does not get parsed on the way to a search volume.
export interface KeywordMetricSummary
  extends Omit<KeywordMetric, "monthlySearches"> {}

// What one refresh did. Reported rather than returned as rows because the
// caller is Sync, which wants to log a line, not read metrics.
export const KeywordMetricsRefresh = Schema.Struct({
  // Keywords asked about, after folding, de-duplication, and the cache cutoff.
  asked: Schema.Number,
  // Keywords DataForSEO answered for. Lower than `asked` when it has no data.
  answered: Schema.Number,
  // Keywords it was asked about and said nothing at all about — no row, not a
  // row with a null volume. Recorded as asked-and-unreported rather than left
  // absent, because an absent row reads as "never asked", which is a different
  // and wrong statement, and because it would be re-asked and re-billed on
  // every sync for ever.
  unreported: Schema.Number,
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
