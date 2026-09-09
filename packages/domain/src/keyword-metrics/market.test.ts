// Market table tests. Pure data and pure functions: no network, no database,
// no service. These are the checks that stop a charged DataForSEO failure, so
// they are worth more than their size suggests.
import { expect, test } from "bun:test"

import { Market } from "./market.ts"

test("the ported table holds every country and its provider split", () => {
  // The counts are the claim the table makes about DataForSEO's coverage: Labs
  // serves 94 countries and the Keywords Data API covers the other 49. A
  // change to either number means the table was re-ported, which is a decision
  // and not a tidy-up.
  expect(Market.locations.length).toBe(143)
  expect(Market.locations.filter((location) => !location.googleAdsOnly).length).toBe(94)
  expect(Market.locations.filter((location) => location.googleAdsOnly).length).toBe(49)

  // No two rows may claim the same location code: `locationFor` would silently
  // answer with whichever came first.
  const codes = new Set(Market.locations.map((location) => location.code))
  expect(codes.size).toBe(Market.locations.length)
})

test("the two markets the portfolio uses resolve to Labs", () => {
  // Three sites are English-language and one is Dutch, and both markets have
  // to reach Labs — Google Ads reports no keyword difficulty, which is half of
  // what the Registry wants the numbers for.
  expect(Market.providerFor(2840)).toBe("labs")
  expect(Market.languageFor(2840)).toBe("en")
  expect(Market.providerFor(2528)).toBe("labs")
  expect(Market.languageFor(2528)).toBe("nl")
  expect(Market.marketProblem(2840, "en")).toBeNull()
  expect(Market.marketProblem(2528, "nl")).toBeNull()
})

test("a Google-Ads-only country is routed there", () => {
  // Andorra (2020) is one of the 49. Routing it to Labs would spend a task on
  // a country Labs has no data for.
  expect(Market.locationFor(2020)?.googleAdsOnly).toBe(true)
  expect(Market.providerFor(2020)).toBe("google-ads")
  // And difficulty cannot arrive for it, which a client is entitled to know
  // before it renders a column for one.
  expect(Market.marketProblem(2020, "ca")).toBeNull()
})

test("an unknown location code routes to Google Ads and is refused", () => {
  // Labs is the shorter of the two lists, so a code that is not on the table
  // cannot be claimed as covered by it — but nothing should be sent for it
  // either, which is what `marketProblem` is for.
  expect(Market.locationFor(9999)).toBeNull()
  expect(Market.providerFor(9999)).toBe("google-ads")
  expect(Market.marketProblem(9999, "en")).toContain("9999")
})

test("a country's languages lead with its own default", () => {
  // Belgium is served in Dutch, French and German, and its primary search
  // market is Dutch. A caller taking the first entry must get Dutch rather
  // than whatever sorts first.
  expect(Market.languagesFor(2056)).toEqual(["nl", "de", "fr"])
  // A country with one language offers exactly that one.
  expect(Market.languagesFor(2528)).toEqual(["nl"])
})

test("a language the country is not served in is refused before it is billed", () => {
  // DataForSEO rejects an unserved location/language pair as a charged task
  // failure, so this is the check that pays for itself.
  const problem = Market.marketProblem(2528, "de")
  expect(problem).toContain("Netherlands")
  expect(problem).toContain("nl")

  // The same pair the other way round is fine: Belgium does serve German.
  expect(Market.marketProblem(2056, "de")).toBeNull()
})

test("every table row is served in its own language", () => {
  // A row whose default language is not in its own served list would make
  // every unconfigured Market for that country a charged failure.
  for (const location of Market.locations)
    expect(Market.marketProblem(location.code, location.languageCode)).toBeNull()
})

test("the default Market is the United States in English", () => {
  expect(Market.defaultLocationCode).toBe(2840)
  expect(Market.defaultLanguageCode).toBe("en")
  expect(Market.locationFor(Market.defaultLocationCode)?.label).toBe("United States")
  expect(
    Market.marketProblem(Market.defaultLocationCode, Market.defaultLanguageCode),
  ).toBeNull()
})

test("an absent Market resolves to the United States in English", () => {
  // The default nobody chooses, and the reason `configured` exists: this
  // resolves to a real country, so it reads exactly like a chosen Market.
  expect(Market.resolve(undefined)).toEqual({
    locationCode: 2840,
    languageCode: "en",
    label: "United States",
    provider: "labs",
  })
})

test("an absent language resolves to the country's primary search language", () => {
  // A caller that names only a country must get the language with the largest
  // keyword corpus there, not the default's English.
  expect(Market.resolve({ locationCode: 2528 })).toEqual({
    locationCode: 2528,
    languageCode: "nl",
    label: "Netherlands",
    provider: "labs",
  })
  expect(Market.setting(2528).languageCode).toBe("nl")
  expect(Market.setting(2528).problem).toBeNull()
  // Belgium is served in three languages and its primary is Dutch, so the
  // filled-in language must be the table's own default and not the first of
  // the extra ones.
  expect(Market.setting(2056).languageCode).toBe("nl")
})

test("a location DataForSEO does not serve keeps its own language", () => {
  // An unknown code has no primary language to take, so the default's English
  // stands in — and the pair is refused anyway, which is the point.
  const chosen = Market.setting(9999)
  expect(chosen.languageCode).toBe("en")
  expect(chosen.problem).toContain("9999")
})

test("an unserved location and language pair is refused before it is stored", () => {
  // The refusal that pays for itself: DataForSEO bills for a task it rejects,
  // so a pair it does not serve must never reach the Catalog or the wire.
  const chosen = Market.setting(2528, "de")
  expect(chosen.problem).toContain("Netherlands")
  expect(chosen.problem).toContain("nl")
  // And the named language is the one checked, not the country's primary — a
  // check on the primary would pass every pair a caller could send.
  expect(chosen.languageCode).toBe("de")
})

test("the served Markets carry every language of the table they come from", () => {
  const all = Market.served()
  expect(all.length).toBe(Market.locations.length)

  const belgium = all.find((entry) => entry.locationCode === 2056)
  expect(belgium).toEqual({
    locationCode: 2056,
    label: "Belgium",
    shortLabel: "BE",
    languageCodes: ["nl", "de", "fr"],
    provider: "labs",
  })

  // Every served pair the list offers must be one `marketProblem` accepts, or
  // the answer to "what may I set" would name pairs that cost money to try.
  for (const entry of all)
    for (const languageCode of entry.languageCodes)
      expect(Market.marketProblem(entry.locationCode, languageCode)).toBeNull()
})

test("a search narrows the served Markets by name or two-letter code", () => {
  expect(Market.served("nether").map((entry) => entry.locationCode)).toEqual([2528])
  expect(Market.served("NL").map((entry) => entry.locationCode)).toEqual([2528])
  // A two-letter code wins over the name match, so "nl" finds the Netherlands
  // and not Finland, and "de" finds Germany and not Bangladesh.
  expect(Market.served("de").map((entry) => entry.label)).toEqual(["Germany"])
  expect(Market.served("nowhere")).toEqual([])
})

test("the settings answer says whether anybody chose the Market", () => {
  const unset = Market.settingsFor(undefined)
  expect(unset.configured).toBe(false)
  expect(unset.market).toEqual(unset.default)

  const set = Market.settingsFor({ locationCode: 2528 }, "nether")
  expect(set.configured).toBe(true)
  expect(set.market.label).toBe("Netherlands")
  expect(set.market.languageCode).toBe("nl")
  // The default is still reported, so a reader can compare the two without
  // holding the rule in its head.
  expect(set.default.locationCode).toBe(2840)
  expect(set.served.map((entry) => entry.locationCode)).toEqual([2528])
})

test("a Market change reports the stored Keyword metrics as stale", () => {
  const result = Market.setResult(undefined, { locationCode: 2528, languageCode: "nl" })
  expect(result.previous.label).toBe("United States")
  expect(result.market.label).toBe("Netherlands")
  expect(result.changed).toBe(true)
  expect(result.demand.stale).toBe(true)
  // The note has to name both Markets: the reader is about to see every
  // planned Keyword read as unmeasured, and nothing else explains why.
  expect(result.demand.note).toContain("United States")
  expect(result.demand.note).toContain("Netherlands")
})

test("a write that names the Market a Site already has loses nothing", () => {
  // Writing the same pair again must not tell a reader to pay for a refresh it
  // does not need.
  const result = Market.setResult(
    { locationCode: 2528 },
    { locationCode: 2528, languageCode: "nl" },
  )
  expect(result.changed).toBe(false)
  expect(result.demand.stale).toBe(false)
})
