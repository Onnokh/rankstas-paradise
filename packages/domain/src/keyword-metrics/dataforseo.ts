// The DataForSEO wire layer: two endpoints, one envelope, and the translation
// from their field names to ours. No storage, no caching, no policy — that is
// KeywordMetrics' job. Kept separate from the service so the shape of their
// payload stays in one file and the service reads as decisions.
//
// Both endpoints take a batch of keywords and answer with one item per keyword
// they know. Which one to call is decided by the Market's country alone; see
// ./market.ts for why, and `providerFor` for the routing.
//
// Authentication is HTTP Basic, and the stored key is the base64 of
// "<login>:<password>" — the value DataForSEO's own dashboard shows as the API
// key. It is passed straight through as the credentials, so nothing here has to
// hold a login and a password as two separate secrets.
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import { KeywordMetricsError, type KeywordMetric, type MonthlySearch } from "./schema.ts"

const BASE_URL = "https://api.dataforseo.com"

// Labs reports search volume, cost per click, competition, difficulty, and
// intent. https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live/
const LABS_PATH = "/v3/dataforseo_labs/google/keyword_overview/live"

// Google Ads reports volume, cost per click, and competition, for every Google
// geotarget. https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/
const ADS_PATH = "/v3/keywords_data/google_ads/search_volume/live"

// --- expansion: asking what ELSE people search -------------------------------
//
// The three above answer "what about these keywords". These answer "what other
// keywords are there", which is a different kind of request in one way that
// matters: the caller does not know how many rows will come back. A metric
// lookup is priced by the keywords you name; an expansion is priced by the rows
// it decides to return, so the `limit` is the only thing standing between one
// call and a four-figure row count.
//
// Long-tail phrases built around the seed. The safest expansion, because every
// answer contains the term you asked about.
// https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live/
const LABS_SUGGESTIONS_PATH =
  "/v3/dataforseo_labs/google/keyword_suggestions/live"

// Terms Google itself relates to the seed, from its "searches related to" data.
// Broader than suggestions, and the one that finds an adjacent topic rather than
// a variant of the one you have.
// https://docs.dataforseo.com/v3/dataforseo_labs/google/related_keywords/live/
const LABS_RELATED_PATH = "/v3/dataforseo_labs/google/related_keywords/live"

// The Google Ads equivalent, for the 49 countries Labs does not cover. Reports
// no difficulty and no intent, like every Google Ads answer.
// https://docs.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live/
const ADS_IDEAS_PATH =
  "/v3/keywords_data/google_ads/keywords_for_keywords/live"

// How many rows an expansion may return. Not an optimization: this endpoint
// bills per row, so an unbounded call is an unbounded bill. 200 is enough that
// the terms worth having are in the set after filtering, and small enough that
// one mistaken call costs about two cents.
export const expansionLimit = 200

// How deep `related_keywords` follows Google's related-searches graph. One is
// the seed's own related searches; three is their related searches' related
// searches, which is where the results stop resembling the seed. DataForSEO
// defaults to zero (the seed alone), which would answer nothing.
const RELATED_DEPTH = 1

// Both endpoints cap a batch at 700 keywords. Exceeding it is a rejected task,
// which is charged, so the batching is not an optimization.
export const batchSize = 700

// A third party must not be able to hold a sync open indefinitely. Longer than
// DomainRating's ten seconds because a 700-keyword task is real work at their
// end, and a timeout here throws away a request we have already paid for.
const TIMEOUT_MS = 60_000

// The DataForSEO status code that means "this worked". Every other value is a
// failure, including on an HTTP 200 — task failures ride inside a 200 response,
// so the status codes have to be read rather than the HTTP status alone.
const OK = 20000

// Their envelope, twice nested: a response holds tasks, and a task holds
// results. Only the fields that are read are named; the rest is theirs.
interface Envelope<T> {
  readonly status_code?: number
  readonly status_message?: string
  readonly tasks?: ReadonlyArray<{
    readonly status_code?: number
    readonly status_message?: string
    readonly result?: ReadonlyArray<T> | null
  }> | null
}

interface WireMonthlySearch {
  readonly year?: number | null
  readonly month?: number | null
  readonly search_volume?: number | null
}

interface WireKeywordInfo {
  readonly search_volume?: number | null
  readonly cpc?: number | null
  readonly competition?: number | null
  readonly monthly_searches?: ReadonlyArray<WireMonthlySearch> | null
}

// One Labs item. `keyword_info_normalized_with_clickstream` only arrives when
// the caller opted into clickstream data, which doubles the price; this domain
// never does, so the field is not read.
interface LabsItem {
  readonly keyword?: string | null
  readonly keyword_info?: WireKeywordInfo | null
  readonly keyword_properties?: { readonly keyword_difficulty?: number | null } | null
  readonly search_intent_info?: { readonly main_intent?: string | null } | null
}

// One Google Ads item. Note the two competition fields: `competition` is their
// LOW/MEDIUM/HIGH bucket and `competition_index` is a 0-100 number, where Labs
// reports a single 0-1 ratio under the name `competition`. The index is the one
// that converts, so the bucket is not read.
interface AdsItem {
  readonly keyword?: string | null
  readonly search_volume?: number | null
  readonly cpc?: number | null
  readonly competition_index?: number | null
  readonly monthly_searches?: ReadonlyArray<WireMonthlySearch> | null
}

// Labs nests its items one level deeper than Google Ads does: a Labs result
// holds an `items` array, while a Google Ads result *is* an item. Getting this
// wrong yields an empty answer from a charged request, which is why the two
// endpoints do not share an unwrapper.
interface LabsResult {
  readonly items?: ReadonlyArray<LabsItem> | null
}

const monthlySearchesOf = (
  entries: ReadonlyArray<WireMonthlySearch> | null | undefined,
): ReadonlyArray<MonthlySearch> =>
  (entries ?? []).flatMap((entry) =>
    // A month without a year and a month is not a data point. Dropped rather
    // than zero-filled: a seasonality read over invented months is worse than
    // one over a short series.
    typeof entry.year === "number" && typeof entry.month === "number"
      ? [{ year: entry.year, month: entry.month, searchVolume: entry.search_volume ?? 0 }]
      : [],
  )

// A vendor number that is present and finite, else null. DataForSEO sends null
// for "no data", and this also stops a NaN reaching a score.
const numberOf = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

// Everything but `keyword` and `fetchedAt`, which the caller supplies.
type Metrics = Omit<KeywordMetric, "keyword" | "locationCode" | "languageCode" | "fetchedAt">

const labsMetrics = (item: LabsItem): Metrics => ({
  searchVolume: numberOf(item.keyword_info?.search_volume),
  difficulty: numberOf(item.keyword_properties?.keyword_difficulty),
  costPerClick: numberOf(item.keyword_info?.cpc),
  competition: numberOf(item.keyword_info?.competition),
  intent: item.search_intent_info?.main_intent ?? null,
  monthlySearches: monthlySearchesOf(item.keyword_info?.monthly_searches),
})

const adsMetrics = (item: AdsItem): Metrics => {
  const index = numberOf(item.competition_index)
  return {
    searchVolume: numberOf(item.search_volume),
    // Google Ads does not measure organic difficulty, and neither does anything
    // else here — so this is null rather than derived from the paid competition
    // index, which is a different question with a similar-looking answer.
    difficulty: null,
    costPerClick: numberOf(item.cpc),
    competition: index === null ? null : index / 100,
    intent: null,
    monthlySearches: monthlySearchesOf(item.monthly_searches),
  }
}

const failure = (message: string, cause?: unknown) =>
  new KeywordMetricsError({ message, cause })

// POST one task and hand back its result array. Fails on a transport problem,
// on a non-2xx, and on either of the two status codes inside the envelope.
const postTask = <T>(
  httpClient: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  path: string,
  payload: unknown,
): Effect.Effect<ReadonlyArray<T>, KeywordMetricsError> =>
  Effect.gen(function* () {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${BASE_URL}${path}`).pipe(
          HttpClientRequest.setHeader("authorization", `Basic ${Redacted.value(apiKey)}`),
          HttpClientRequest.setHeader("accept", "application/json"),
          // Their API takes an array of tasks even when there is one.
          HttpClientRequest.bodyJsonUnsafe([payload]),
        ),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: `${TIMEOUT_MS} millis`,
          orElse: () =>
            Effect.fail(
              failure(`DataForSEO did not answer within ${TIMEOUT_MS / 1000}s.`),
            ),
        }),
        Effect.mapError((cause) =>
          cause instanceof KeywordMetricsError
            ? cause
            : failure(`Could not reach DataForSEO: ${String(cause)}`, cause),
        ),
      )

    // `execute` does not fail on a non-2xx, so the status is classified here.
    // 401 means the key is wrong, 402 means the account is out of funds, and
    // 429 means the rate limit is hit; all three are worth naming, because they
    // are the three a caller can act on.
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(
        failure(
          response.status === 401 || response.status === 403
            ? `DataForSEO rejected the API key (HTTP ${response.status}).`
            : response.status === 402
              ? "The DataForSEO account has no funds left (HTTP 402)."
              : response.status === 429
                ? "DataForSEO rate-limited the request (HTTP 429)."
                : `DataForSEO request failed with HTTP ${response.status}.`,
        ),
      )

    const body = yield* response.json.pipe(
      Effect.mapError((cause) =>
        failure("Could not read the DataForSEO response.", cause),
      ),
    )
    const envelope = body as Envelope<T>

    if (envelope.status_code !== OK)
      return yield* Effect.fail(
        failure(
          `DataForSEO refused the request: ${envelope.status_message ?? `status ${envelope.status_code}`}`,
        ),
      )

    const task = envelope.tasks?.[0]
    if (!task)
      return yield* Effect.fail(failure("The DataForSEO response held no task."))

    // A failed task is still a charged task. Named loudly so the message
    // reaches a log rather than being read as "no keywords matched" — the two
    // look identical from an empty result array.
    if (task.status_code !== OK)
      return yield* Effect.fail(
        failure(
          `The DataForSEO task failed: ${task.status_message ?? `status ${task.status_code}`}`,
        ),
      )

    return task.result ?? []
  })

// `related_keywords` wraps the same keyword payload one level deeper than every
// other Labs endpoint. Reading it at the wrong level yields an empty answer from
// a charged request, which is why it does not share an unwrapper.
interface RelatedItem {
  readonly keyword_data?: LabsItem | null
}

export interface Batch {
  readonly keywords: ReadonlyArray<string>
  readonly locationCode: number
  readonly languageCode: string
}

// Ask Labs about a batch. Returns one row per keyword DataForSEO knows, so a
// caller must not assume its input and this output line up.
export const keywordOverview = (
  httpClient: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  batch: Batch,
  fetchedAt: string,
): Effect.Effect<ReadonlyArray<KeywordMetric>, KeywordMetricsError> =>
  Effect.map(
    postTask<LabsResult>(httpClient, apiKey, LABS_PATH, {
      keywords: batch.keywords,
      location_code: batch.locationCode,
      language_code: batch.languageCode,
      // Named explicitly, though false is their default: this field doubles the
      // price of the request, so it must be visible at the call site.
      include_clickstream_data: false,
    }),
    (results) =>
      (results[0]?.items ?? []).flatMap((item) =>
        item.keyword
          ? [
              {
                keyword: item.keyword,
                locationCode: batch.locationCode,
                languageCode: batch.languageCode,
                fetchedAt,
                ...labsMetrics(item),
              },
            ]
          : [],
      ),
  )

// Ask Google Ads about a batch, for the countries Labs does not cover.
export const adsSearchVolume = (
  httpClient: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  batch: Batch,
  fetchedAt: string,
): Effect.Effect<ReadonlyArray<KeywordMetric>, KeywordMetricsError> =>
  Effect.map(
    postTask<AdsItem>(httpClient, apiKey, ADS_PATH, {
      keywords: batch.keywords,
      location_code: batch.locationCode,
      language_code: batch.languageCode,
    }),
    (items) =>
      items.flatMap((item) =>
        item.keyword
          ? [
              {
                keyword: item.keyword,
                locationCode: batch.locationCode,
                languageCode: batch.languageCode,
                fetchedAt,
                ...adsMetrics(item),
              },
            ]
          : [],
      ),
  )

export * as DataForSeo from "./dataforseo"
