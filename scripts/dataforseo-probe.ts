// A live probe against DataForSEO. Run it by hand; it is not part `bun test`.
//
//   DATAFORSEO_API_KEY=… bun run scripts/dataforseo-probe.ts
//   DATAFORSEO_API_KEY=… bun run scripts/dataforseo-probe.ts 2528 nl "kado kopen"
//
// Why this exists. Every other test of the KeywordMetrics domain runs against a
// fake HttpClient returning payloads written by hand from open-seo's source. That
// proves the logic — batching, the brand and operator filters, the freshness
// cutoff, the null handling — and proves nothing at all about the contract with
// DataForSEO. An endpoint path, a request field name, or a level of response
// nesting could be wrong and every one of those tests would still pass, because
// the fake answers exactly what it was told to.
//
// This script closes that gap and only that gap. It calls the real wire module
// (../packages/domain/src/keyword-metrics/dataforseo.ts) over the real network
// and prints what came back, so what is verified is: the Basic auth format, the
// endpoint path, the request body field names, the two different response
// nestings, and the field mapping into a KeywordMetric.
//
// THIS SPENDS MONEY. One Labs task is $0.01 plus $0.0001 a row; one Google Ads
// request is a flat $0.075. The probe asks about three keywords, once.
//
// The key is read from the environment and never printed. Nothing here writes to
// a database: the probe does not touch the store, so running it cannot make a
// site look synced when it is not.
import { Effect, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

import { DataForSeo } from "../packages/domain/src/keyword-metrics/dataforseo.ts"
import { Market } from "../packages/domain/src/keyword-metrics/market.ts"

const [locationArg, languageArg, ...keywordArgs] = Bun.argv.slice(2)

const locationCode = locationArg ? Number(locationArg) : Market.defaultLocationCode
const languageCode = languageArg ?? Market.languageFor(locationCode)
// Three ordinary English terms with different demand profiles, so the answer is
// worth reading: a head term, a long tail one, and one that should be rare.
const keywords =
  keywordArgs.length > 0
    ? keywordArgs
    : ["seo tools", "wow mount tracker", "read later app for iphone"]

const apiKey = Bun.env.DATAFORSEO_API_KEY
if (!apiKey || apiKey.trim() === "") {
  console.error(
    "DATAFORSEO_API_KEY is not set. It is the base64 of \"<login>:<password>\"\n" +
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
console.log(`Asking about ${keywords.length}: ${keywords.join(", ")}`)
console.log(
  provider === "google-ads"
    ? "Google Ads reports no difficulty and no intent for this market."
    : "Labs should report difficulty and intent for this market.",
)
console.log("")

const call =
  provider === "google-ads" ? DataForSeo.adsSearchVolume : DataForSeo.keywordOverview

const program = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  return yield* call(
    httpClient,
    Redacted.make(apiKey),
    { keywords, locationCode, languageCode },
    new Date().toISOString(),
  )
})

const result = await Effect.runPromiseExit(
  program.pipe(Effect.provide(FetchHttpClient.layer)),
)

if (result._tag === "Failure") {
  // The error messages are the ones a sync would log, so a failure here is
  // worth reading rather than just a stack.
  console.error("FAILED.")
  console.error(String(result.cause))
  process.exit(1)
}

const rows = result.value
console.log(`Answered for ${rows.length} of ${keywords.length}.`)
console.log("")
for (const row of rows) {
  console.log(row.keyword)
  console.log(`  volume       ${row.searchVolume ?? "null (too rare to report)"}`)
  console.log(
    `  difficulty   ${row.difficulty ?? (provider === "google-ads" ? "null (as expected)" : "null")}`,
  )
  console.log(`  cost/click   ${row.costPerClick ?? "null"}`)
  console.log(`  competition  ${row.competition ?? "null"}`)
  console.log(`  intent       ${row.intent ?? "null"}`)
  console.log(`  months       ${row.monthlySearches.length}`)
}

// What the fakes could not check. Each line below is a claim the hand-written
// payloads asserted and only a live call can confirm.
console.log("")
console.log("Contract checks:")
const unanswered = keywords.filter(
  (keyword) => !rows.some((row) => row.keyword === keyword.toLowerCase()),
)
const check = (label: string, ok: boolean, note = "") =>
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${note ? ` — ${note}` : ""}`)

check("authenticated and the task succeeded", true)
check("keywords come back lower-cased", rows.every((row) => row.keyword === row.keyword.toLowerCase()))
check(
  "at least one volume arrived",
  rows.some((row) => row.searchVolume !== null),
  "a market where every volume is null would mean the response is being read wrong",
)
check(
  "monthly series arrived",
  rows.some((row) => row.monthlySearches.length > 0),
  "twelve months expected for a term with demand",
)
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
  check("Google Ads reported no difficulty", rows.every((row) => row.difficulty === null))
  check(
    "competition converted to a 0-1 ratio",
    rows.every((row) => row.competition === null || row.competition <= 1),
    "a value above 1 means the 0-100 index is not being divided down",
  )
}
if (unanswered.length > 0) {
  console.log(
    `  note  DataForSEO knows nothing about: ${unanswered.join(", ")} — expected for a rare term, and the reason a caller must not assume its input and the answer line up.`,
  )
}
