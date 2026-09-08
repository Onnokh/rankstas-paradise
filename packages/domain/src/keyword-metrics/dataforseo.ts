// The DataForSEO wire layer: five endpoints, one envelope, and the translation
// from their field names to ours. No storage, no caching, no policy — that is
// KeywordMetrics' and KeywordDiscovery's job. Kept separate from the services so
// the shape of their payload stays in one file and a service reads as decisions.
//
// Two kinds of question live here. The lookups take a batch of keywords and
// answer with one item per keyword they know. The expansions take one seed and
// answer with keywords the caller did not name. Both are routed by the Market's
// country alone; see ./market.ts for why, and `providerFor` for the routing.
//
// Authentication is HTTP Basic, and the stored key is the base64 of
// "<login>:<password>" — the value DataForSEO's own dashboard shows as the API
// key. It is passed straight through as the credentials, so nothing here has to
// hold a login and a password as two separate secrets.
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

import {
  foldKeyword,
  KeywordMetricsError,
  type KeywordMetric,
  type MonthlySearch,
} from "./schema.ts"

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

// How many rows an expansion may return by default. Not an optimization: the
// Labs expansions bill per row, so an unbounded call is an unbounded bill. 200
// is enough that the terms worth having are in the set after filtering, and
// small enough that one mistaken call costs about two cents.
export const expansionLimit = 200

// How far `related_keywords` walks Google's related-searches graph. Each level
// branches by up to eight, so depth 1 is at most 8 keywords, depth 2 at most 72,
// and depth 3 at most 584. Two is the choice here for two reasons: every answer
// is within two hops of the seed, so the set still reads as the same subject;
// and 72 is under `expansionLimit`, so nothing is truncated. Depth 3 would hand
// back more than the limit and let DataForSEO choose which 200 survive, by an
// order they do not document.
const RELATED_DEPTH = 2

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
interface RelatedResult {
  readonly items?: ReadonlyArray<{
    readonly keyword_data?: LabsItem | null
  } | null> | null
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

// --- expansion ----------------------------------------------------------------

// One seed to expand. `limit` is on the seed rather than a module constant
// because on the two Labs expansions it is the price of the call, and a price
// belongs at the call site. On the Google Ads expansion, which charges a flat
// fee, it only bounds how many rows come back.
export interface Seed {
  readonly keyword: string
  readonly locationCode: number
  readonly languageCode: string
  readonly limit: number
}

// The shape all three expansions share: POST one seed, get keywords back with
// their metrics already filled in. Discovery therefore costs one request, not
// an expansion followed by a metric lookup — which is the whole reason to read
// the metrics off these endpoints instead of calling `keywordOverview` after.
type Expansion = (
  httpClient: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
  seed: Seed,
  fetchedAt: string,
) => Effect.Effect<ReadonlyArray<KeywordMetric>, KeywordMetricsError>

// Turn Labs items into metrics, dropping the seed itself and anything unnamed.
// The seed is dropped because the caller already holds it: it is the keyword
// they asked about, so returning it as a discovery would propose a keyword the
// Registry has.
const labsRows = (
  items: ReadonlyArray<LabsItem | null | undefined>,
  seed: Seed,
  fetchedAt: string,
): ReadonlyArray<KeywordMetric> => {
  const folded = foldKeyword(seed.keyword)
  return items.flatMap((item) =>
    item?.keyword && foldKeyword(item.keyword) !== folded
      ? [
          {
            keyword: item.keyword,
            locationCode: seed.locationCode,
            languageCode: seed.languageCode,
            fetchedAt,
            ...labsMetrics(item),
          },
        ]
      : [],
  )
}

// Long-tail phrases built around the seed: every answer contains the seed term.
// The predictable expansion, and the one to reach for when a Cluster needs more
// of the subject it already has.
export const keywordSuggestions: Expansion = (httpClient, apiKey, seed, fetchedAt) =>
  Effect.map(
    postTask<LabsResult>(httpClient, apiKey, LABS_SUGGESTIONS_PATH, {
      keyword: seed.keyword,
      location_code: seed.locationCode,
      language_code: seed.languageCode,
      limit: seed.limit,
      include_clickstream_data: false,
      // The seed's own row would be a billed row we already have.
      include_seed_keyword: false,
      // Their defaults, named because each one silently changes what comes back:
      // synonyms in, and phrase matching rather than exact, is the wider set.
      ignore_synonyms: false,
      exact_match: false,
    }),
    (results) => labsRows(results[0]?.items ?? [], seed, fetchedAt),
  )

// Terms Google itself relates to the seed. Broader than suggestions, and the
// only one of the three that can find a subject the Site does not cover — an
// answer here need not contain the seed term at all.
export const relatedKeywords: Expansion = (httpClient, apiKey, seed, fetchedAt) =>
  Effect.map(
    postTask<RelatedResult>(httpClient, apiKey, LABS_RELATED_PATH, {
      keyword: seed.keyword,
      location_code: seed.locationCode,
      language_code: seed.languageCode,
      limit: seed.limit,
      depth: RELATED_DEPTH,
      include_clickstream_data: false,
      // The SERP for every keyword found, which is a much larger response and
      // is not read here.
      include_serp_info: false,
    }),
    (results) =>
      labsRows(
        (results[0]?.items ?? []).map((item) => item?.keyword_data),
        seed,
        fetchedAt,
      ),
  )

// The Google Ads expansion, for the 49 Markets Labs does not serve. Reports no
// difficulty and no intent, like every Google Ads answer, so a proposal from
// here cannot be filtered on either.
export const adsKeywordsForKeywords: Expansion = (httpClient, apiKey, seed, fetchedAt) => {
  const folded = foldKeyword(seed.keyword)
  return Effect.map(
    postTask<AdsItem>(httpClient, apiKey, ADS_IDEAS_PATH, {
      // Plural: this endpoint takes a list of seeds, and is given one, so that
      // every answer has a seed to attribute it to.
      keywords: [seed.keyword],
      location_code: seed.locationCode,
      language_code: seed.languageCode,
      // This endpoint has no `limit`: it charges one flat fee and can answer
      // with thousands of rows, so `seed.limit` is applied below, on the way
      // out. Sorted by volume first so the rows the limit keeps are the rows
      // worth keeping.
      sort_by: "search_volume",
    }),
    (items) =>
      items.slice(0, seed.limit).flatMap((item) =>
        item.keyword && foldKeyword(item.keyword) !== folded
          ? [
              {
                keyword: item.keyword,
                locationCode: seed.locationCode,
                languageCode: seed.languageCode,
                fetchedAt,
                ...adsMetrics(item),
              },
            ]
          : [],
      ),
  )
}

export * as DataForSeo from "./dataforseo"
