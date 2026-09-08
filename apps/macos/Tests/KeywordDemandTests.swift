import XCTest
@testable import RankstasParadise

/// What the registry screen shows about a keyword's demand, and — more to the point — what
/// it refuses to show. Two absences mean different things here: no `demand` block means
/// nobody has asked the vendor yet, and a null number inside one means the vendor was asked
/// and had nothing. Neither is a zero, and neither may be displayed as one.
final class KeywordDemandTests: XCTestCase {
    private func demand(
        searchVolume: Double? = 1_900,
        difficulty: Double? = 31,
        costPerClick: Double? = 2.4,
        intent: String? = "commercial"
    ) -> KeywordDemand {
        KeywordDemand(
            searchVolume: searchVolume,
            difficulty: difficulty,
            costPerClick: costPerClick,
            competition: 0.18,
            intent: intent,
            fetchedAt: "2026-09-08T00:00:00.000Z"
        )
    }

    func testVolumeAndDifficultyReadAsTheNumbersTheVendorGave() {
        // Asserted on a value below the grouping threshold, because the label formats in
        // the reader's locale — a Dutch Mac groups thousands with a "." and an American one
        // with a "," — and pinning either would be asserting the locale, not the label.
        XCTAssertEqual(demand(searchVolume: 480).volumeLabel, "480/mo")
        XCTAssertEqual(demand(difficulty: 31).difficultyLabel, "KD 31")

        // A grouped value still carries its digits and its unit, whatever the separator.
        let grouped = demand(searchVolume: 1_900).volumeLabel
        XCTAssertTrue(grouped?.hasSuffix("/mo") == true, "got \(grouped ?? "nil")")
        XCTAssertTrue(grouped?.contains("900") == true, "got \(grouped ?? "nil")")
    }

    func testAVolumeIsRoundedToWholeSearches() {
        // The vendor averages the newest twelve months, so it arrives fractional. Half a search
        // a month is not a number worth showing.
        XCTAssertEqual(demand(searchVolume: 480.4).volumeLabel, "480/mo")
        XCTAssertEqual(demand(difficulty: 30.7).difficultyLabel, "KD 31")
    }

    func testANullNumberHasNoLabelRatherThanAZeroOne() {
        // A term too rare for the vendor to report has no volume. "0/mo" would claim it was
        // measured at nothing, which is a different — and much stronger — statement.
        XCTAssertNil(demand(searchVolume: nil).volumeLabel)
        // Difficulty is null for a whole market when Google Ads serves it, so this is the
        // ordinary case for 49 countries rather than an edge one.
        XCTAssertNil(demand(difficulty: nil).difficultyLabel)
    }

    func testAZeroVolumeIsShownBecauseTheVendorDidSayIt() {
        // The case the whole feature exists to surface: a planned keyword the vendor
        // measured and found no demand for. That must be visible, not hidden with the nulls.
        XCTAssertEqual(demand(searchVolume: 0).volumeLabel, "0/mo")
    }

    func testAKeywordIsIdentifiedByItselfNowThatCountryIsGone() {
        // The registry holds one row per keyword, so the keyword identifies it. This used to
        // be "keyword|country", which meant dropping the column changed the identity.
        let keyword = RegistryKeyword(keyword: "pocket alternative", cluster: "c", intent: "comparison")
        XCTAssertEqual(keyword.id, "pocket alternative")
    }

    func testAMarketNamesItselfAndSaysWhetherDifficultyCanArrive() {
        let labs = ResolvedMarket(locationCode: 2840, languageCode: "en", label: "United States", provider: "labs")
        XCTAssertEqual(labs.summary, "United States · EN")
        XCTAssertTrue(labs.hasDifficulty)

        // A Google-Ads market reports no difficulty at all, so a screen can leave the number
        // out rather than show every keyword with a blank.
        let ads = ResolvedMarket(locationCode: 2020, languageCode: "ca", label: "Andorra", provider: "google-ads")
        XCTAssertFalse(ads.hasDifficulty)
    }

    // MARK: Decoding

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testAKeywordWithDemandDecodes() throws {
        let keyword = try decode(RegistryKeyword.self, """
        {
          "keyword": "pocket alternative",
          "cluster": "Alternatives",
          "intent": "comparison",
          "demand": {
            "searchVolume": 1900,
            "difficulty": 31,
            "costPerClick": 2.4,
            "competition": 0.18,
            "intent": "commercial",
            "fetchedAt": "2026-09-08T00:00:00.000Z"
          }
        }
        """)
        XCTAssertEqual(keyword.demand?.searchVolume, 1_900)
        XCTAssertEqual(keyword.demand?.difficulty, 31)
    }

    func testAKeywordWithoutDemandStillDecodes() throws {
        // A server with no DataForSEO key, and every server before this build. The screen
        // shows such a keyword exactly as it did before demand existed.
        let keyword = try decode(RegistryKeyword.self, """
        { "keyword": "chrome read later", "cluster": "Extension", "intent": "product-solution" }
        """)
        XCTAssertNil(keyword.demand)
    }

    func testExplicitNullsInsideDemandDecodeAsNulls() throws {
        // The Google-Ads shape: asked, answered, and no difficulty or intent in the answer.
        let keyword = try decode(RegistryKeyword.self, """
        {
          "keyword": "kado",
          "cluster": "Gifts",
          "intent": "commercial",
          "demand": {
            "searchVolume": null,
            "difficulty": null,
            "costPerClick": null,
            "competition": null,
            "intent": null,
            "fetchedAt": "2026-09-08T00:00:00.000Z"
          }
        }
        """)
        XCTAssertNotNil(keyword.demand)
        XCTAssertNil(keyword.demand?.searchVolume)
        XCTAssertNil(keyword.demand?.volumeLabel)
    }

    func testASiteWithoutAMarketStillDecodes() throws {
        let site = try decode(Site.self, """
        { "id": "sleevy", "name": "Sleevy", "origin": "https://sleevy.app" }
        """)
        XCTAssertNil(site.market)

        let withMarket = try decode(Site.self, """
        {
          "id": "printfeest",
          "name": "Printfeest",
          "origin": "https://printfeest.nl",
          "market": { "locationCode": 2528, "languageCode": "nl", "label": "Netherlands", "provider": "labs" }
        }
        """)
        XCTAssertEqual(withMarket.market?.summary, "Netherlands · NL")
    }
}
