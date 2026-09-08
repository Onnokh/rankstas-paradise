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
