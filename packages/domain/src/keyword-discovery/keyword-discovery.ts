// KeywordDiscovery service: keywords the Site does not have yet.
//
// The opposite question to KeywordMetrics'. That service asks "what is this
// keyword worth" about keywords the Registry already holds; this one asks "what
// else is there" and answers with keywords nobody named. The two share the wire
// layer and the Market, and nothing else.
//
// Three things make this its own service rather than another method there:
//
//   1. It is never a Sync. Every run is asked for by a person, so an absent API
//      key is an error here where it is a silent no-op there.
//   2. Its output has a lifecycle. A metric is a fact that gets re-asked; a
//      Proposal is a suggestion that a person accepts or dismisses, and that
//      decision has to outlive the next run that finds the same keyword.
//   3. Its cost is not knowable in advance. A metric lookup is priced by the
//      keywords you name. An expansion is priced by the rows the vendor decides
//      to return, so `limit` is the only thing between one call and a
//      four-figure row count — see DataForSeo.expansionLimit.
//
// The filtering lives here rather than in the caller because every filter is a
// statement about what is worth a reader's attention, and those are the same
// whether the caller is the MCP server or a screen. What is *not* here is a
// difficulty ceiling by default: see ./schema.ts for why that one belongs on a
// screen with a slider, not in a service.
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { DataForSeo } from "../keyword-metrics/dataforseo.ts"
import { Market } from "../keyword-metrics/market.ts"
import { foldKeyword as fold, UnservedMarketError } from "../keyword-metrics/schema.ts"
import { Registry } from "../registry/registry.ts"
import { serviceUse } from "../service-use.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { isOperatorQuery, Storage } from "../storage/storage.ts"
import {
  KeywordDiscoveryError,
  type DiscoveryRequest,
  type DiscoveryResult,
  type DiscoverySource,
  type KeywordProposal,
} from "./schema.ts"

export interface Interface {
  // Expand one seed at DataForSEO, keep what passes every filter, and store it
  // as Proposals. Costs money on every call — there is no cache to hit, because
  // the question is "what is out there now", not "what is this worth".
  readonly discover: (
    request: DiscoveryRequest,
  ) => Effect.Effect<DiscoveryResult, KeywordDiscoveryError | UnservedMarketError>
  // The Proposals still waiting on a decision, strongest demand first. Excludes
  // the dismissed ones, and also any keyword the Registry has since taken —
  // whether it was taken from this list or typed in by hand.
  readonly proposed: () => Effect.Effect<
    ReadonlyArray<KeywordProposal>,
    KeywordDiscoveryError
  >
  // Set aside Proposals by keyword; returns how many changed. A dismissal is
  // permanent in the sense that matters: a later run that finds the same
  // keyword will not propose it again.
  readonly dismiss: (
    keywords: ReadonlyArray<string>,
  ) => Effect.Effect<number, KeywordDiscoveryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/KeywordDiscovery",
) {}

export const use = serviceUse(Service)

// The volume a keyword must report to be worth proposing. Not a rule of thumb
// about what ranks — it is the line under which the vendor is telling you it has
// no evidence of demand. Ten rather than one because DataForSEO rounds low
// volumes hard, so the numbers below it carry no information.
export const defaultMinVolume = 10

// The most rows one run may ask for. The Labs expansions cap `limit` at 1000
// themselves; this repeats the cap so a mistyped request fails here, before it
// is billed, rather than as a charged task failure at their end.
export const maxLimit = 1000

// Which expansion answers a seed. `related` is offered because it is the only
// one that can find a subject the Site does not cover at all — its answers need
// not contain the seed term. `suggestions` is the default because its answers
// always do, which makes a run predictable, and because the Market decides
// nothing about relevance while the reader still has to read every row.
const expansionFor = (
  provider: string,
  source: DiscoveryRequest["source"],
): { readonly call: typeof DataForSeo.keywordSuggestions; readonly source: DiscoverySource } =>
  provider === "google-ads"
    ? // The 49 Markets Labs does not serve get the Google Ads expansion, and
      // `source` is ignored rather than refused: the caller asked for keywords,
      // not for a particular endpoint, and this is the only one that answers
      // here. The recorded source says which one ran, so the missing difficulty
      // and intent on those rows have a visible cause.
      { call: DataForSeo.adsKeywordsForKeywords, source: "google-ads" }
    : source === "related"
      ? { call: DataForSeo.relatedKeywords, source: "related" }
      : { call: DataForSeo.keywordSuggestions, source: "suggestions" }

// Whether any of the Site's brand terms appears in the keyword. The same test
// KeywordMetrics applies before spending money, applied here after: an
// expansion of your own subject returns your own name, and volume on that is
// not an opportunity.
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
    const registry = yield* Registry.Service
    const storage = yield* Storage.Service

    const apiKey = yield* EffectConfig.redacted("DATAFORSEO_API_KEY").pipe(
      EffectConfig.option,
    )

    const fail = (message: string, cause?: unknown) =>
      new KeywordDiscoveryError({ message, cause })

    // The Site's Market, or the reason DataForSEO will not answer for it.
    // Mirrors KeywordMetrics' own check, and for the same reason: an unserved
    // location/language pair is a charged task failure, so it has to be caught
    // before the request and not after.
    const market = Effect.gen(function* () {
      const site = yield* currentSite.current().pipe(
        Effect.mapError((cause) => fail("Could not read the current site.", cause)),
      )
      const resolved = site.market ?? {
        locationCode: Market.defaultLocationCode,
        languageCode: Market.defaultLanguageCode,
        label: "United States",
        provider: "labs" as const,
      }
      const problem = Market.marketProblem(resolved.locationCode, resolved.languageCode)
      if (problem)
        return yield* new UnservedMarketError({
          locationCode: resolved.locationCode,
          languageCode: resolved.languageCode,
          reason: problem,
        })
      return { site, market: resolved }
    })

    // Every folded keyword this Site has an opinion about: in the Registry, or
    // already proposed, or already dismissed. One set because the three mean
    // the same thing to a discovery run — do not offer this again.
    const known = (locationCode: number, languageCode: string) =>
      Effect.gen(function* () {
        const entries = yield* registry
          .loadRegistry()
          .pipe(Effect.mapError((cause) => fail("Could not read the registry.", cause)))
        const proposals = yield* storage
          .keywordProposals(locationCode, languageCode)
          .pipe(
            Effect.mapError((cause) =>
              fail("Could not read the stored keyword proposals.", cause),
            ),
          )
        return new Set([
          ...entries.map((entry) => fold(entry.keyword)).filter((keyword) => keyword !== ""),
          ...proposals.map((proposal) => proposal.keyword),
        ])
      })

    const impl: Interface = {
      discover: Effect.fn("KeywordDiscovery.discover")(function* (
        request: DiscoveryRequest,
      ) {
        const seed = request.seed.trim()
        if (seed === "") return yield* fail("A discovery run needs a seed keyword.")

        // An absent key is an error here, unlike in KeywordMetrics.refresh: a
        // run is always asked for, so answering "nothing found" would report a
        // configuration problem as an empty result.
        if (Option.isNone(apiKey) || Redacted.value(apiKey.value).trim() === "")
          return yield* fail(
            "No DataForSEO API key is configured, so no keywords can be discovered.",
          )

        const limit = Math.trunc(request.limit ?? DataForSeo.expansionLimit)
        if (limit < 1 || limit > maxLimit)
          return yield* fail(`The limit must be between 1 and ${maxLimit}, not ${limit}.`)

        const { site, market: resolved } = yield* market
        const { call, source } = expansionFor(resolved.provider, request.source)
        const alreadyKnown = yield* known(resolved.locationCode, resolved.languageCode)

        const discoveredAt = new Date().toISOString()
        const rows = yield* call(
          httpClient,
          apiKey.value,
          {
            keyword: seed,
            locationCode: resolved.locationCode,
            languageCode: resolved.languageCode,
            limit,
          },
          discoveredAt,
        ).pipe(Effect.mapError((cause) => fail(cause.message, cause)))

        const minVolume = request.minVolume ?? defaultMinVolume
        const maxDifficulty = request.maxDifficulty
        const intents = request.intents?.map((intent) => intent.trim().toLowerCase())

        const drops = {
          known: 0,
          brandOrOperator: 0,
          belowVolume: 0,
          aboveDifficulty: 0,
          byIntent: 0,
        }
        // Folded here rather than trusted: DataForSEO can answer with the same
        // keyword twice across the branches of a related-searches walk, and a
        // duplicate would otherwise overwrite its own row and be counted twice.
        const seen = new Set<string>()
        const proposals: Array<KeywordProposal> = []

        for (const row of rows) {
          const keyword = fold(row.keyword)
          if (keyword === "" || seen.has(keyword)) continue
          seen.add(keyword)

          // The order is the order the counts are read in: a row is charged to
          // the first reason it was dropped, so the numbers add up to the rows
          // returned.
          if (alreadyKnown.has(keyword)) {
            drops.known += 1
            continue
          }
          if (isBrandQuery(keyword, site.brandTerms) || isOperatorQuery(keyword)) {
            drops.brandOrOperator += 1
            continue
          }
          // A null volume counts as below the floor. The vendor answered and
          // reported nothing, which is weaker evidence than a small number.
          if ((row.searchVolume ?? 0) < minVolume) {
            drops.belowVolume += 1
            continue
          }
          if (
            maxDifficulty !== undefined &&
            row.difficulty !== null &&
            row.difficulty > maxDifficulty
          ) {
            drops.aboveDifficulty += 1
            continue
          }
          // A row with no intent survives an intent filter. Google Ads reports
          // none at all, so dropping the unknown would empty the list in half
          // the world's Markets rather than narrow it.
          if (intents && intents.length > 0 && row.intent !== null) {
            if (!intents.includes(row.intent.toLowerCase())) {
              drops.byIntent += 1
              continue
            }
          }

          proposals.push({
            keyword,
            seed: fold(seed),
            source,
            locationCode: resolved.locationCode,
            languageCode: resolved.languageCode,
            searchVolume: row.searchVolume,
            difficulty: row.difficulty,
            costPerClick: row.costPerClick,
            competition: row.competition,
            intent: row.intent,
            status: "proposed",
            discoveredAt,
            // The monthly series is not carried. It is on the wire and paid
            // for, but a Proposal is read as a list of one-line judgements, and
            // the seasonality it would answer is a question for a keyword that
            // is already in the plan.
          })
        }

        // Strongest demand first, so a reader who stops after ten rows has read
        // the ten that matter.
        proposals.sort((left, right) => (right.searchVolume ?? 0) - (left.searchVolume ?? 0))

        yield* storage
          .saveKeywordProposals(proposals)
          .pipe(
            Effect.mapError((cause) =>
              fail("Could not store the keyword proposals.", cause),
            ),
          )

        return {
          seed,
          source,
          returned: rows.length,
          droppedKnown: drops.known,
          droppedBrandOrOperator: drops.brandOrOperator,
          droppedBelowVolume: drops.belowVolume,
          droppedAboveDifficulty: drops.aboveDifficulty,
          droppedByIntent: drops.byIntent,
          proposals,
        } satisfies DiscoveryResult
      }),

      proposed: Effect.fn("KeywordDiscovery.proposed")(function* () {
        const site = yield* currentSite.current().pipe(
          Effect.mapError((cause) => fail("Could not read the current site.", cause)),
        )
        const resolved = site.market
        // No Market means no Proposal can have been stored: every row is keyed
        // by the location and language it was found in.
        if (!resolved) return []

        const proposals = yield* storage
          .keywordProposals(resolved.locationCode, resolved.languageCode)
          .pipe(
            Effect.mapError((cause) =>
              fail("Could not read the stored keyword proposals.", cause),
            ),
          )
        const entries = yield* registry
          .loadRegistry()
          .pipe(Effect.mapError((cause) => fail("Could not read the registry.", cause)))
        const planned = new Set(entries.map((entry) => fold(entry.keyword)))

        return proposals.filter(
          (proposal) => proposal.status === "proposed" && !planned.has(proposal.keyword),
        )
      }),

      dismiss: Effect.fn("KeywordDiscovery.dismiss")(function* (
        keywords: ReadonlyArray<string>,
      ) {
        const site = yield* currentSite.current().pipe(
          Effect.mapError((cause) => fail("Could not read the current site.", cause)),
        )
        const resolved = site.market
        if (!resolved) return 0

        return yield* storage
          .dismissKeywordProposals(
            keywords.map(fold).filter((keyword) => keyword !== ""),
            resolved.locationCode,
            resolved.languageCode,
          )
          .pipe(
            Effect.mapError((cause) =>
              fail("Could not dismiss the keyword proposals.", cause),
            ),
          )
      }),
    }

    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Registry.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as KeywordDiscovery from "./keyword-discovery"
