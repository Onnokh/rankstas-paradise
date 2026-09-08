// A live probe of the DataForSEO *expansions*. Run it by hand; it is not part of
// `bun test`.
//
//   DATAFORSEO_API_KEY=… bun run scripts/dataforseo-expansion-probe.ts
//   DATAFORSEO_API_KEY=… bun run scripts/dataforseo-expansion-probe.ts "kado kopen" 2528 nl
//
// The companion to dataforseo-probe.ts, and it exists for the same reason: the
// KeywordDiscovery tests run against a fake HttpClient answering payloads
// written by hand, which proves the filtering and proves nothing about the
// vendor contract. The last time that gap was closed by hand, the fakes had been
// wrong about the length of the monthly series for the whole life of the
// feature — every test passed, because a fake answers what it was told to.
//
// One risk is specific to these three endpoints and is why this probe is worth
// its cost: `related_keywords` wraps each item's payload one level deeper than
// every other Labs endpoint (`items[].keyword_data`), and `keywords_for_keywords`
// takes no `limit` at all. Reading either one wrong yields an EMPTY ANSWER FROM A
// CHARGED REQUEST — which looks exactly like "the vendor knows nothing about this
// seed". Only a live call can tell the two apart, so this probe asks about a seed
// the vendor certainly knows and treats an empty answer as a failure.
//
// THIS SPENDS MONEY, and more than the metric probe does. A Labs expansion is
// $0.01 for the task plus $0.0001 a row; the Google Ads expansion is a flat
// $0.075 however many rows it returns. At the default limit of 25 rows the two
// Labs runs together cost about three cents.
//
// The key is read from the environment and never printed. Nothing here writes to
// a database, so running it cannot leave a site holding proposals nobody asked
// for.
import { Effect, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { DataForSeo } from "../packages/domain/src/keyword-metrics/dataforseo.ts"
import { Market } from "../packages/domain/src/keyword-metrics/market.ts"
import { foldKeyword } from "../packages/domain/src/keyword-metrics/schema.ts"

const [seedArg, locationArg, languageArg] = Bun.argv.slice(2)

// A seed with obvious demand and obvious neighbours, so an empty answer is
// evidence about this code and not about the seed.
const seed = seedArg ?? "seo tools"
const locationCode = locationArg ? Number(locationArg) : Market.defaultLocationCode
const languageCode = languageArg ?? Market.languageFor(locationCode)
// Deliberately small. The limit is the price on the two Labs endpoints, and 25
// rows is enough to see the shape of an answer.
const limit = 25

const apiKey = Bun.env.DATAFORSEO_API_KEY
if (!apiKey || apiKey.trim() === "") {
  console.error(
    'DATAFORSEO_API_KEY is not set. It is the base64 of "<login>:<password>"\n' +
      "that the DataForSEO dashboard shows as the API key — one value, not two.\n" +
      "Export it for this one command; do not commit it.",
  )
  process.exit(1)
}

const problem = Market.marketProblem(locationCode, languageCode)
if (problem) {
  // The same check the service makes before it spends anything.
  console.error(`Refusing to send: ${problem}`)
  process.exit(1)
}

const provider = Market.providerFor(locationCode)
const location = Market.locationFor(locationCode)

console.log(
  `Market: ${location?.label ?? locationCode} · ${languageCode} · served by ${provider}`,
)
console.log(`Seed: "${seed}" · limit ${limit}`)
console.log("")

// Which expansions this Market can answer. A Google Ads Market has exactly one,
// which is the whole reason the country table is held locally.
const expansions =
  provider === "google-ads"
    ? [{ name: "keywords_for_keywords", call: DataForSeo.adsKeywordsForKeywords }]
    : [
        { name: "keyword_suggestions", call: DataForSeo.keywordSuggestions },
        { name: "related_keywords", call: DataForSeo.relatedKeywords },
      ]

const check = (label: string, ok: boolean, note = "") =>
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${note ? ` — ${note}` : ""}`)

const folded = foldKeyword(seed)
let failures = 0
const fail = (label: string, note = "") => {
  failures += 1
  check(label, false, note)
}

for (const expansion of expansions) {
  console.log(`--- ${expansion.name} ---`)

  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient
      return yield* expansion.call(
        httpClient,
        Redacted.make(apiKey),
        { keyword: seed, locationCode, languageCode, limit },
        new Date().toISOString(),
      )
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  )

  if (result._tag === "Failure") {
    // The error messages are the ones a run would report, so a failure here is
    // worth reading rather than just a stack.
    fail(`${expansion.name} request`, String(result.cause))
    console.log("")
    continue
  }

  const rows = result.value
  console.log(`  ${rows.length} rows`)
  for (const row of rows.slice(0, 8))
    console.log(
      `    ${row.keyword} · vol ${row.searchVolume ?? "null"} · kd ${row.difficulty ?? "null"} · ${row.intent ?? "no intent"}`,
    )
  if (rows.length > 8) console.log(`    … and ${rows.length - 8} more`)

  // An empty answer is the failure this probe was written for: it is what a
  // misread nesting looks like, and it is indistinguishable from an unknown
  // seed unless the seed is one the vendor obviously knows.
  if (rows.length === 0)
    fail(
      "the expansion returned keywords",
      "empty from a charged request. Either the response nesting is being read at the wrong level, or this seed really has no neighbours — try a broader one before believing the second",
    )
  else check("the expansion returned keywords", true)

  if (rows.length > 0) {
    check(
      "the seed's own row is not among them",
      rows.every((row) => foldKeyword(row.keyword) !== folded),
      "the wire layer drops it; a hit here means the drop is not working",
    )
    check(
      "the limit was respected",
      rows.length <= limit,
      expansion.name === "keywords_for_keywords"
        ? "this endpoint has no limit parameter, so the cut happens on the way out — more rows than the limit means the slice is gone"
        : "more rows than asked for means `limit` is not reaching the vendor",
    )
    check(
      "at least one volume arrived",
      rows.some((row) => row.searchVolume !== null),
      "null everywhere means keyword_info is nested differently than assumed",
    )
    check(
      "no duplicate keywords in one answer",
      new Set(rows.map((row) => foldKeyword(row.keyword))).size === rows.length,
      "duplicates are tolerated by the service, which folds and de-duplicates — this only records whether the vendor sends them",
    )

    if (expansion.name === "keyword_suggestions")
      check(
        "every suggestion contains the seed",
        rows.every((row) => foldKeyword(row.keyword).includes(folded)),
        "this endpoint's whole promise. A miss means it is behaving like related_keywords, and the two are described differently to callers",
      )

    if (expansion.name === "related_keywords") {
      // Depth 2 branches by up to eight a level: 8 at depth 1, 72 at depth 2.
      // More than 72 would mean the depth is not arriving.
      check("depth 2 could not have branched past 72", rows.length <= 72)
      const contained = rows.filter((row) => foldKeyword(row.keyword).includes(folded))
      console.log(
        `  note  ${contained.length} of ${rows.length} rows contain the seed. Some overlap with keyword_suggestions is expected; all of them would mean this endpoint is adding nothing over it.`,
      )
    }

    if (provider === "labs") {
      check(
        "Labs reported difficulty",
        rows.some((row) => row.difficulty !== null),
        "null everywhere means keyword_properties is nested differently than assumed",
      )
      check(
        "Labs reported intent",
        rows.some((row) => row.intent !== null),
        "null everywhere means search_intent_info is nested differently than assumed",
      )
    } else {
      check(
        "Google Ads reported no difficulty",
        rows.every((row) => row.difficulty === null),
      )
      check(
        "competition converted to a 0-1 ratio",
        rows.every((row) => row.competition === null || row.competition <= 1),
        "a value above 1 means the 0-100 index is not being divided down",
      )
      check(
        "sorted by volume, strongest first",
        rows.every(
          (row, index) =>
            index === 0 || (rows[index - 1]!.searchVolume ?? 0) >= (row.searchVolume ?? 0),
        ),
        "the limit cuts this list on the way out, so an unsorted answer means the limit is discarding the best rows",
      )
    }
  }
  console.log("")
}

console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
