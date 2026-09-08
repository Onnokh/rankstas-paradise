// The Market table: which countries DataForSEO serves keyword data for, which
// of its two APIs serves each one, and which language each country searches in.
//
// Pure data and pure functions — no Effect, no network, no service. A Market is
// a Site property (see ../config/schema.ts), so this module is what validates
// one before it is stored and what routes a request once it is.
//
// DataForSEO answers keyword data from two different products, and which one
// applies is decided by the country alone:
//
//   - DataForSEO Labs covers 94 countries and is the better answer. It reports
//     search volume, cost per click, competition, keyword difficulty, and
//     search intent, and it bills per task plus per row.
//   - The Keywords Data API (Google Ads endpoints) covers every Google
//     geotarget, so it is the only answer for the other 49 countries. It
//     reports volume, cost per click, and competition, but no keyword
//     difficulty and no search intent, and it bills a flat rate per request.
//
// A caller must therefore never assume difficulty is present. `providerFor`
// says which product a location gets, and the two nullable fields on a
// KeywordMetric are nullable because of this split, not because of an error.
//
// The country table and the multi-language list are ported from open-seo
// (https://github.com/every-app/open-seo, MIT, (c) 2026 Ben Senescu),
// src/shared/keyword-locations.ts. Their source is DataForSEO's own
// /v3/dataforseo_labs/locations_and_languages endpoint. Ported rather than
// derived at run time: the list changes about once a year, and a Market must be
// checkable without a network call and without a key.

// One country DataForSEO serves keyword data for. `code` is DataForSEO's
// `location_code`, `shortLabel` is the ISO 3166-1 alpha-2 code (except the
// United Kingdom, which open-seo's table carries as the friendlier "UK"), and
// `languageCode` is the country's primary search language — the one with the
// largest keyword corpus, which is what a request uses when nobody chose.
export interface Location {
  readonly code: number
  readonly label: string
  readonly shortLabel: string
  readonly languageCode: string
  // Set when Labs does not cover this country, so it must go to Google Ads and
  // comes back with no keyword difficulty and no search intent.
  readonly googleAdsOnly?: true
}

export const locations: ReadonlyArray<Location> = [
  { code: 2008, label: "Albania", shortLabel: "AL", languageCode: "sq" },
  { code: 2012, label: "Algeria", shortLabel: "DZ", languageCode: "fr" },
  { code: 2020, label: "Andorra", shortLabel: "AD", languageCode: "ca", googleAdsOnly: true },
  { code: 2024, label: "Angola", shortLabel: "AO", languageCode: "pt" },
  { code: 2032, label: "Argentina", shortLabel: "AR", languageCode: "es" },
  { code: 2051, label: "Armenia", shortLabel: "AM", languageCode: "hy" },
  { code: 2036, label: "Australia", shortLabel: "AU", languageCode: "en" },
  { code: 2040, label: "Austria", shortLabel: "AT", languageCode: "de" },
  { code: 2031, label: "Azerbaijan", shortLabel: "AZ", languageCode: "az" },
  { code: 2044, label: "Bahamas", shortLabel: "BS", languageCode: "en", googleAdsOnly: true },
  { code: 2048, label: "Bahrain", shortLabel: "BH", languageCode: "ar" },
  { code: 2050, label: "Bangladesh", shortLabel: "BD", languageCode: "bn" },
  { code: 2052, label: "Barbados", shortLabel: "BB", languageCode: "en", googleAdsOnly: true },
  { code: 2056, label: "Belgium", shortLabel: "BE", languageCode: "nl" },
  { code: 2084, label: "Belize", shortLabel: "BZ", languageCode: "en", googleAdsOnly: true },
  { code: 2068, label: "Bolivia", shortLabel: "BO", languageCode: "es" },
  { code: 2070, label: "Bosnia and Herzegovina", shortLabel: "BA", languageCode: "bs" },
  { code: 2072, label: "Botswana", shortLabel: "BW", languageCode: "en", googleAdsOnly: true },
  { code: 2076, label: "Brazil", shortLabel: "BR", languageCode: "pt" },
  { code: 2096, label: "Brunei", shortLabel: "BN", languageCode: "ms", googleAdsOnly: true },
  { code: 2100, label: "Bulgaria", shortLabel: "BG", languageCode: "bg" },
  { code: 2854, label: "Burkina Faso", shortLabel: "BF", languageCode: "fr" },
  { code: 2116, label: "Cambodia", shortLabel: "KH", languageCode: "en" },
  { code: 2120, label: "Cameroon", shortLabel: "CM", languageCode: "fr" },
  { code: 2124, label: "Canada", shortLabel: "CA", languageCode: "en" },
  { code: 2152, label: "Chile", shortLabel: "CL", languageCode: "es" },
  { code: 2170, label: "Colombia", shortLabel: "CO", languageCode: "es" },
  { code: 2188, label: "Costa Rica", shortLabel: "CR", languageCode: "es" },
  { code: 2384, label: "Cote d'Ivoire", shortLabel: "CI", languageCode: "fr" },
  { code: 2191, label: "Croatia", shortLabel: "HR", languageCode: "hr" },
  { code: 2196, label: "Cyprus", shortLabel: "CY", languageCode: "el" },
  { code: 2203, label: "Czechia", shortLabel: "CZ", languageCode: "cs" },
  { code: 2208, label: "Denmark", shortLabel: "DK", languageCode: "da" },
  { code: 2214, label: "Dominican Republic", shortLabel: "DO", languageCode: "es", googleAdsOnly: true },
  { code: 2218, label: "Ecuador", shortLabel: "EC", languageCode: "es" },
  { code: 2818, label: "Egypt", shortLabel: "EG", languageCode: "ar" },
  { code: 2222, label: "El Salvador", shortLabel: "SV", languageCode: "es" },
  { code: 2233, label: "Estonia", shortLabel: "EE", languageCode: "et" },
  { code: 2231, label: "Ethiopia", shortLabel: "ET", languageCode: "en", googleAdsOnly: true },
  { code: 2242, label: "Fiji", shortLabel: "FJ", languageCode: "en", googleAdsOnly: true },
  { code: 2246, label: "Finland", shortLabel: "FI", languageCode: "fi" },
  { code: 2250, label: "France", shortLabel: "FR", languageCode: "fr" },
  { code: 2268, label: "Georgia", shortLabel: "GE", languageCode: "en", googleAdsOnly: true },
  { code: 2276, label: "Germany", shortLabel: "DE", languageCode: "de" },
  { code: 2288, label: "Ghana", shortLabel: "GH", languageCode: "en" },
  { code: 2300, label: "Greece", shortLabel: "GR", languageCode: "el" },
  { code: 2320, label: "Guatemala", shortLabel: "GT", languageCode: "es" },
  { code: 2831, label: "Guernsey", shortLabel: "GG", languageCode: "en", googleAdsOnly: true },
  { code: 2328, label: "Guyana", shortLabel: "GY", languageCode: "en", googleAdsOnly: true },
  { code: 2332, label: "Haiti", shortLabel: "HT", languageCode: "fr", googleAdsOnly: true },
  { code: 2340, label: "Honduras", shortLabel: "HN", languageCode: "es", googleAdsOnly: true },
  { code: 2344, label: "Hong Kong", shortLabel: "HK", languageCode: "zh-TW" },
  { code: 2348, label: "Hungary", shortLabel: "HU", languageCode: "hu" },
  { code: 2352, label: "Iceland", shortLabel: "IS", languageCode: "is", googleAdsOnly: true },
  { code: 2356, label: "India", shortLabel: "IN", languageCode: "en" },
  { code: 2360, label: "Indonesia", shortLabel: "ID", languageCode: "id" },
  { code: 2368, label: "Iraq", shortLabel: "IQ", languageCode: "ar", googleAdsOnly: true },
  { code: 2372, label: "Ireland", shortLabel: "IE", languageCode: "en" },
  { code: 2833, label: "Isle of Man", shortLabel: "IM", languageCode: "en", googleAdsOnly: true },
  { code: 2376, label: "Israel", shortLabel: "IL", languageCode: "he" },
  { code: 2380, label: "Italy", shortLabel: "IT", languageCode: "it" },
  { code: 2388, label: "Jamaica", shortLabel: "JM", languageCode: "en", googleAdsOnly: true },
  { code: 2392, label: "Japan", shortLabel: "JP", languageCode: "ja" },
  { code: 2832, label: "Jersey", shortLabel: "JE", languageCode: "en", googleAdsOnly: true },
  { code: 2400, label: "Jordan", shortLabel: "JO", languageCode: "ar" },
  { code: 2398, label: "Kazakhstan", shortLabel: "KZ", languageCode: "ru" },
  { code: 2404, label: "Kenya", shortLabel: "KE", languageCode: "en" },
  { code: 2414, label: "Kuwait", shortLabel: "KW", languageCode: "ar", googleAdsOnly: true },
  { code: 2417, label: "Kyrgyzstan", shortLabel: "KG", languageCode: "ru", googleAdsOnly: true },
  { code: 2418, label: "Laos", shortLabel: "LA", languageCode: "en", googleAdsOnly: true },
  { code: 2428, label: "Latvia", shortLabel: "LV", languageCode: "lv" },
  { code: 2422, label: "Lebanon", shortLabel: "LB", languageCode: "ar", googleAdsOnly: true },
  { code: 2438, label: "Liechtenstein", shortLabel: "LI", languageCode: "de", googleAdsOnly: true },
  { code: 2440, label: "Lithuania", shortLabel: "LT", languageCode: "lt" },
  { code: 2442, label: "Luxembourg", shortLabel: "LU", languageCode: "fr", googleAdsOnly: true },
  { code: 2450, label: "Madagascar", shortLabel: "MG", languageCode: "fr", googleAdsOnly: true },
  { code: 2454, label: "Malawi", shortLabel: "MW", languageCode: "en", googleAdsOnly: true },
  { code: 2458, label: "Malaysia", shortLabel: "MY", languageCode: "en" },
  { code: 2462, label: "Maldives", shortLabel: "MV", languageCode: "en", googleAdsOnly: true },
  { code: 2470, label: "Malta", shortLabel: "MT", languageCode: "en" },
  { code: 2480, label: "Mauritius", shortLabel: "MU", languageCode: "en", googleAdsOnly: true },
  { code: 2484, label: "Mexico", shortLabel: "MX", languageCode: "es" },
  { code: 2498, label: "Moldova", shortLabel: "MD", languageCode: "ro" },
  { code: 2492, label: "Monaco", shortLabel: "MC", languageCode: "fr" },
  { code: 2496, label: "Mongolia", shortLabel: "MN", languageCode: "en", googleAdsOnly: true },
  { code: 2499, label: "Montenegro", shortLabel: "ME", languageCode: "sr", googleAdsOnly: true },
  { code: 2504, label: "Morocco", shortLabel: "MA", languageCode: "ar" },
  { code: 2508, label: "Mozambique", shortLabel: "MZ", languageCode: "pt", googleAdsOnly: true },
  { code: 2104, label: "Myanmar (Burma)", shortLabel: "MM", languageCode: "en" },
  { code: 2516, label: "Namibia", shortLabel: "NA", languageCode: "en", googleAdsOnly: true },
  { code: 2524, label: "Nepal", shortLabel: "NP", languageCode: "en", googleAdsOnly: true },
  { code: 2528, label: "Netherlands", shortLabel: "NL", languageCode: "nl" },
  { code: 2554, label: "New Zealand", shortLabel: "NZ", languageCode: "en" },
  { code: 2558, label: "Nicaragua", shortLabel: "NI", languageCode: "es" },
  { code: 2566, label: "Nigeria", shortLabel: "NG", languageCode: "en" },
  { code: 2807, label: "North Macedonia", shortLabel: "MK", languageCode: "mk" },
  { code: 2578, label: "Norway", shortLabel: "NO", languageCode: "nb" },
  { code: 2512, label: "Oman", shortLabel: "OM", languageCode: "ar", googleAdsOnly: true },
  { code: 2586, label: "Pakistan", shortLabel: "PK", languageCode: "en" },
  { code: 2275, label: "Palestine", shortLabel: "PS", languageCode: "ar", googleAdsOnly: true },
  { code: 2591, label: "Panama", shortLabel: "PA", languageCode: "es" },
  { code: 2598, label: "Papua New Guinea", shortLabel: "PG", languageCode: "en", googleAdsOnly: true },
  { code: 2600, label: "Paraguay", shortLabel: "PY", languageCode: "es" },
  { code: 2604, label: "Peru", shortLabel: "PE", languageCode: "es" },
  { code: 2608, label: "Philippines", shortLabel: "PH", languageCode: "en" },
  { code: 2616, label: "Poland", shortLabel: "PL", languageCode: "pl" },
  { code: 2620, label: "Portugal", shortLabel: "PT", languageCode: "pt" },
  { code: 2634, label: "Qatar", shortLabel: "QA", languageCode: "ar", googleAdsOnly: true },
  { code: 2642, label: "Romania", shortLabel: "RO", languageCode: "ro" },
  { code: 2646, label: "Rwanda", shortLabel: "RW", languageCode: "en", googleAdsOnly: true },
  { code: 2674, label: "San Marino", shortLabel: "SM", languageCode: "it", googleAdsOnly: true },
  { code: 2682, label: "Saudi Arabia", shortLabel: "SA", languageCode: "ar" },
  { code: 2686, label: "Senegal", shortLabel: "SN", languageCode: "fr" },
  { code: 2688, label: "Serbia", shortLabel: "RS", languageCode: "sr" },
  { code: 2702, label: "Singapore", shortLabel: "SG", languageCode: "en" },
  { code: 2703, label: "Slovakia", shortLabel: "SK", languageCode: "sk" },
  { code: 2705, label: "Slovenia", shortLabel: "SI", languageCode: "sl" },
  { code: 2710, label: "South Africa", shortLabel: "ZA", languageCode: "en" },
  { code: 2410, label: "South Korea", shortLabel: "KR", languageCode: "ko" },
  { code: 2724, label: "Spain", shortLabel: "ES", languageCode: "es" },
  { code: 2144, label: "Sri Lanka", shortLabel: "LK", languageCode: "en" },
  { code: 2740, label: "Suriname", shortLabel: "SR", languageCode: "nl", googleAdsOnly: true },
  { code: 2752, label: "Sweden", shortLabel: "SE", languageCode: "sv" },
  { code: 2756, label: "Switzerland", shortLabel: "CH", languageCode: "de" },
  { code: 2158, label: "Taiwan", shortLabel: "TW", languageCode: "zh-TW" },
  { code: 2762, label: "Tajikistan", shortLabel: "TJ", languageCode: "ru", googleAdsOnly: true },
  { code: 2834, label: "Tanzania", shortLabel: "TZ", languageCode: "en", googleAdsOnly: true },
  { code: 2764, label: "Thailand", shortLabel: "TH", languageCode: "th" },
  { code: 2780, label: "Trinidad and Tobago", shortLabel: "TT", languageCode: "en", googleAdsOnly: true },
  { code: 2788, label: "Tunisia", shortLabel: "TN", languageCode: "ar" },
  { code: 2792, label: "Turkiye", shortLabel: "TR", languageCode: "tr" },
  { code: 2795, label: "Turkmenistan", shortLabel: "TM", languageCode: "ru", googleAdsOnly: true },
  { code: 2800, label: "Uganda", shortLabel: "UG", languageCode: "en", googleAdsOnly: true },
  { code: 2804, label: "Ukraine", shortLabel: "UA", languageCode: "uk" },
  { code: 2784, label: "United Arab Emirates", shortLabel: "AE", languageCode: "en" },
  { code: 2826, label: "United Kingdom", shortLabel: "UK", languageCode: "en" },
  { code: 2840, label: "United States", shortLabel: "US", languageCode: "en" },
  { code: 2858, label: "Uruguay", shortLabel: "UY", languageCode: "es" },
  { code: 2860, label: "Uzbekistan", shortLabel: "UZ", languageCode: "ru", googleAdsOnly: true },
  { code: 2862, label: "Venezuela", shortLabel: "VE", languageCode: "es" },
  { code: 2704, label: "Vietnam", shortLabel: "VN", languageCode: "vi" },
  { code: 2894, label: "Zambia", shortLabel: "ZM", languageCode: "en", googleAdsOnly: true },
  { code: 2716, label: "Zimbabwe", shortLabel: "ZW", languageCode: "en", googleAdsOnly: true },
]

// Countries DataForSEO serves in more than one language, each country's own
// default included. Every country absent from this list offers only the
// `languageCode` on its table row, and a Google-Ads-only country has no
// per-country language data at all, so it offers only its default too.
//
// This list is the whole reason a Market is checkable offline. DataForSEO
// rejects a location/language pair it does not serve as a *charged* task
// failure, so an unchecked pair costs money and returns nothing.
const multiLanguageLocations: Record<number, ReadonlyArray<string>> = {
  2012: ["ar", "fr"], // Algeria
  2056: ["de", "fr", "nl"], // Belgium
  2124: ["en", "fr"], // Canada
  2196: ["el", "en"], // Cyprus
  2300: ["el", "en"], // Greece
  2344: ["en", "zh-TW"], // Hong Kong
  2356: ["en", "hi"], // India
  2360: ["en", "id"], // Indonesia
  2376: ["ar", "he"], // Israel
  2458: ["en", "ms"], // Malaysia
  2504: ["ar", "fr"], // Morocco
  2586: ["en", "ur"], // Pakistan
  2608: ["en", "tl"], // Philippines
  2702: ["en", "zh-CN"], // Singapore
  2704: ["en", "vi"], // Vietnam
  2756: ["de", "fr", "it"], // Switzerland
  2784: ["ar", "en"], // United Arab Emirates
  2804: ["ru", "uk"], // Ukraine
  2818: ["ar", "en"], // Egypt
  2840: ["en", "es"], // United States
}

// Which DataForSEO product serves a country's keyword data.
export type KeywordDataProvider = "labs" | "google-ads"

// The Market a Site gets when its settings name none. The United States in
// English: it is the largest English keyword corpus, and a site with no stated
// market is far more likely to be an English one than anything else. A site
// that is not English must say so — a wrong market is worse than no data,
// because the numbers look right and describe a different country.
export const defaultLocationCode = 2840
export const defaultLanguageCode = "en"

const byCode = new Map(locations.map((location) => [location.code, location]))

// The table row for a location code, or null when DataForSEO does not serve it.
export const locationFor = (locationCode: number): Location | null =>
  byCode.get(locationCode) ?? null

// Which product answers for this country. An unknown code reports Google Ads —
// the honest answer, because Labs is the shorter of the two lists and a code
// that is not on our table cannot be claimed as covered by it. A caller still
// has to check the Market first; this is a router, not a guard.
export const providerFor = (locationCode: number): KeywordDataProvider => {
  const location = byCode.get(locationCode)
  return !location || location.googleAdsOnly ? "google-ads" : "labs"
}

// Every language DataForSEO serves for this country, its default first.
export const languagesFor = (
  locationCode: number,
): ReadonlyArray<string> => {
  const location = byCode.get(locationCode)
  if (!location) return []
  const served = multiLanguageLocations[locationCode]
  if (!served) return [location.languageCode]
  // The table's own default leads, so a caller that takes the first entry gets
  // the primary search market rather than whatever sorts first alphabetically.
  return [
    location.languageCode,
    ...served.filter((code) => code !== location.languageCode),
  ]
}

// The language to use for a country when nobody chose one.
export const languageFor = (locationCode: number): string =>
  byCode.get(locationCode)?.languageCode ?? defaultLanguageCode

// Why this location/language pair cannot be used, or null when it can. Checked
// before a Market is stored and again before a request is paid for, because
// DataForSEO charges for rejecting a pair it does not serve.
export const marketProblem = (
  locationCode: number,
  languageCode: string,
): string | null => {
  const location = byCode.get(locationCode)
  if (!location)
    return `DataForSEO serves no keyword data for location code ${locationCode}.`
  const served = languagesFor(locationCode)
  if (!served.includes(languageCode))
    return `DataForSEO serves ${location.label} in ${served.join(", ")}, not "${languageCode}".`
  return null
}

export * as Market from "./market"
