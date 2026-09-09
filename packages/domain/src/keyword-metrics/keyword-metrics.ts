// KeywordMetrics service: what DataForSEO says about the Site's Keywords, kept
// on the volume.
//
// Shaped like DomainRating deliberately. `refresh` reaches the network and is
// called by Sync; `cached` only reads stored data, never fails, and is what
// every report and MCP read uses. A dashboard must never block on DataForSEO —
// if it did, a slow third party would stall a screen whose Search Console
// numbers are already on disk.
//
// Unlike the Domain Rating this store is a cache, not a ledger. Every number
// here can be asked for again, and `searchVolume` is an average of the newest
// twelve months rather than a reading of one day, so an old row is stale rather
// than historical. That is why `refresh` re-asks after `refreshAfterDays` and
// overwrites, where DomainRating accumulates.
//
// The whole feature is optional. With no API key configured, `refresh` is a
// no-op and `cached` yields an empty map, and every caller renders a site
// without volume rather than an error.
//
// Two rules govern what is paid for, and both are enforced here rather than in
// the caller, because they are properties of spending money and not of syncing:
//
//   1. A keyword with a fresh answer is not asked about again.
//   2. A Brand query and an Operator query are never asked about at all. Volume
//      on your own name tells you nothing you can act on, and `site:` is not a
//      search term — but DataForSEO charges per row either way.
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { Registry } from "../registry/registry.ts"
import { type RegistryError } from "../registry/schema.ts"
import { serviceUse } from "../service-use.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { isOperatorQuery, Storage } from "../storage/storage.ts"
import { DataForSeo } from "./dataforseo.ts"
import { Market } from "./market.ts"
import {
  foldKeyword as fold,
  type KeywordMetricSummary,
  type KeywordMetricsRefresh,
  type KeywordMetricsSync,
  KeywordMetricsError,
  UnservedMarketError,
} from "./schema.ts"

export interface Interface {
  // Every stored metric for the Site's Market, keyed by the folded keyword.
  // Scalars only — the monthly series is not read here; see
  // Storage.keywordMonthlySearches for why.
  // Never reaches the network and never fails — this is what report reads call,
  // and volume is supplementary: its absence, for any reason, must not cost a
  // caller the report it came for.
  readonly cached: () => Effect.Effect<ReadonlyMap<string, KeywordMetricSummary>>
  // Ask DataForSEO about the candidates that have no fresh answer, and store
  // what comes back. Returns null when no API key is configured, so an
  // unconfigured deployment simply has no volume. Candidates are folded,
  // de-duplicated and filtered before anything is billed, so a caller may pass
  // its whole keyword list without pre-cleaning it.
  readonly refresh: (
    candidates: ReadonlyArray<string>,
  ) => Effect.Effect<
    KeywordMetricsRefresh | null,
    KeywordMetricsError | UnservedMarketError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/KeywordMetrics",
) {}

export const use = serviceUse(Service)

// How long a stored answer is treated as current. Thirty days because that is
// the shape of the data: DataForSEO's headline volume averages the newest
// twelve months, so one month of drift moves it by at most a twelfth, and
// asking more often buys noise at full price. It is deliberately not a Sync constant — this is how
// long the vendor's answer stays true, not how often we choose to sync.
export const refreshAfterDays = 30

// Whether any of the site's brand terms appears in the keyword. The same test
// the ledger's non-brand filter applies, repeated here because this decision is
// made before a request rather than after a read.
const isBrandQuery = (keyword: string, brandTerms: ReadonlyArray<string>): boolean =>
  brandTerms.some((term) => {
    const folded = fold(term)
    return folded !== "" && keyword.includes(folded)
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient
    const storage = yield* Storage.Service

    // Redacted so the key cannot reach a log line or an error message. Absent
    // by design on a deployment that has not configured DataForSEO. The value
    // is the base64 of "<login>:<password>" that their dashboard shows; see
    // ./dataforseo.ts.
    const apiKey = yield* EffectConfig.redacted("DATAFORSEO_API_KEY").pipe(
      EffectConfig.option,
    )

    // The Site's Market, or the reason DataForSEO will not answer for it. The
    // check runs before a request rather than at normalize time because a
    // rejected location/language pair is a *charged* task failure — catching it
    // here is the difference between a clear error and a bill.
    const market = Effect.gen(function* () {
      const site = yield* currentSite.current()
      const resolved = site.market ?? {
        locationCode: Market.defaultLocationCode,
        languageCode: Market.defaultLanguageCode,
        label: "United States",
        provider: "labs" as const,
      }
      const problem = Market.marketProblem(
        resolved.locationCode,
        resolved.languageCode,
      )
      if (problem)
        return yield* new UnservedMarketError({
          locationCode: resolved.locationCode,
          languageCode: resolved.languageCode,
          reason: problem,
        })
      return { site, market: resolved }
    })

    const impl: Interface = {
      cached: () =>
        Effect.gen(function* () {
          const site = yield* currentSite.current()
          const resolved = site.market
          if (!resolved) return new Map<string, KeywordMetricSummary>()
          // An unreadable store reads as "no metrics yet" rather than an error,
          // for the reason given on the interface.
          const rows = yield* storage
            .keywordMetrics(resolved.locationCode, resolved.languageCode)
            .pipe(
              Effect.catchCause(() =>
                Effect.succeed([] as ReadonlyArray<KeywordMetricSummary>),
              ),
            )
          return new Map(rows.map((row) => [row.keyword, row]))
        }),

      refresh: Effect.fn("KeywordMetrics.refresh")(function* (
        candidates: ReadonlyArray<string>,
      ) {
        // A blank value counts as absent. `DATAFORSEO_API_KEY=` set to nothing
        // is a configured-but-empty key, which would otherwise sail past this
        // guard and come back as a DataForSEO 401 — an error, where the honest
        // answer is simply that no key is configured.
        if (Option.isNone(apiKey) || Redacted.value(apiKey.value).trim() === "")
          return null

        const { site, market: resolved } = yield* market

        const stored = yield* storage
          .keywordMetrics(resolved.locationCode, resolved.languageCode)
          .pipe(
            Effect.mapError(
              (cause) =>
                new KeywordMetricsError({
                  message: "Could not read the stored keyword metrics.",
                  cause,
                }),
            ),
          )

        const cutoff = new Date(
          Date.now() - refreshAfterDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        const fresh = new Set(
          stored
            .filter((row) => row.fetchedAt > cutoff)
            .map((row) => row.keyword),
        )

        // Folded, de-duplicated, and filtered in one pass. Every keyword that
        // survives costs money, so each exclusion below is a saving and not a
        // tidy-up.
        const asked = [
          ...new Set(
            candidates
              .map(fold)
              .filter(
                (keyword) =>
                  keyword !== "" &&
                  !fresh.has(keyword) &&
                  !isBrandQuery(keyword, site.brandTerms) &&
                  !isOperatorQuery(keyword),
              ),
          ),
        ]
        if (asked.length === 0)
          return { asked: 0, answered: 0, unreported: 0, requests: 0 }

        const call =
          resolved.provider === "google-ads"
            ? DataForSeo.adsSearchVolume
            : DataForSeo.keywordOverview
        const fetchedAt = new Date().toISOString()
        let answered = 0
        let unreported = 0
        let requests = 0

        // Batches run one after another, not in parallel. DataForSEO
        // rate-limits per account, and a rejected task is still a charged task,
        // so there is nothing to win by asking faster.
        for (let start = 0; start < asked.length; start += DataForSeo.batchSize) {
          const keywords = asked.slice(start, start + DataForSeo.batchSize)
          const metrics = yield* call(
            httpClient,
            apiKey.value,
            {
              keywords,
              locationCode: resolved.locationCode,
              languageCode: resolved.languageCode,
            },
            fetchedAt,
          )
          requests += 1

          // What came back, plus a row for every keyword that did not. Both are
          // answers: DataForSEO returns one item per keyword it knows, and it
          // simply omits the rest, so silence about a keyword is the vendor
          // saying it has no data for it.
          //
          // Recording that silence is not tidiness. Without a row the keyword
          // reads as `unmeasured` — "never asked" — which is a false statement
          // about a keyword just paid for, and it is the opposite conclusion:
          // unmeasured invites configuring a key, where the truth is that the
          // term is too rare for the vendor to report. And since the freshness
          // cutoff can only skip keywords that HAVE a row, an unrecorded
          // silence is re-asked and re-billed on every sync, for ever.
          //
          // The volume is null, never zero. Zero is a measurement — "nobody
          // searches this" — and this is the absence of one.
          const returned = new Set(metrics.map((metric) => fold(metric.keyword)))
          const silent = keywords.filter((keyword) => !returned.has(keyword))

          // Stored per batch rather than at the end: a later batch that fails
          // must not throw away an answer already paid for.
          yield* storage
            .saveKeywordMetrics([
              ...metrics.map((metric) => ({ ...metric, keyword: fold(metric.keyword) })),
              ...silent.map((keyword) => ({
                keyword,
                locationCode: resolved.locationCode,
                languageCode: resolved.languageCode,
                fetchedAt,
                searchVolume: null,
                difficulty: null,
                costPerClick: null,
                competition: null,
                intent: null,
                monthlySearches: [],
              })),
            ])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new KeywordMetricsError({
                    message: "Could not store the keyword metrics.",
                    cause,
                  }),
              ),
            )
          answered += metrics.length
          unreported += silent.length
        }

        return { asked: asked.length, answered, unreported, requests }
      }),
    }

    return impl
  }),
)

// The Site's planned Keywords asked about again: the Registry's own keywords
// offered to `refresh`, with the Market the answers are stored under.
//
// A module-level effect rather than a method on the service, so the service
// keeps its one rule — the caller decides which keywords are worth money —
// while the one set that is never a judgement call does not have to be
// assembled by each caller. The Registry *is* the plan; asking whether the plan
// aims at demand that exists is the reason this store exists at all.
//
// Sync offers these keywords plus the Queries its own run has just stored. This
// is the half a caller can ask for on its own, which is what a Market change
// needs: the store is keyed by location code and language code, so a Site that
// changes Market reads as unmeasured until its plan is asked again.
export const refreshPlanned = (): Effect.Effect<
  KeywordMetricsSync,
  KeywordMetricsError | UnservedMarketError | RegistryError,
  Service | Registry.Service | CurrentSite.Service
> =>
  Effect.gen(function* () {
    const site = yield* CurrentSite.use.current()
    const entries = yield* Registry.use.loadRegistry()
    // Folded and de-duplicated here as well as inside `refresh`, so
    // `candidates` counts keywords and not Registry rows: an inventory-only row
    // carries a blank keyword, and one keyword may target several pages.
    const candidates = [
      ...new Set(
        entries.map((entry) => fold(entry.keyword)).filter((keyword) => keyword !== ""),
      ),
    ]
    const refreshed = yield* use.refresh(candidates)
    return {
      market: site.market ?? Market.resolve(undefined),
      candidates: candidates.length,
      refreshed,
    }
  })

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as KeywordMetrics from "./keyword-metrics"
