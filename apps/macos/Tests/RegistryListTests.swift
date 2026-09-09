import XCTest
@testable import RankstasParadise

/// The registry screen holds no list of its own: what it shows is a pure function of the
/// targets the store holds, the sort, the filter and the search.
final class RegistryListTests: XCTestCase {
    private func target(
        _ path: String,
        impressions: Double = 0,
        clicks: Double = 0,
        visits: Double? = nil,
        indexed: String? = nil,
        keywords: [String] = []
    ) -> RegistryTarget {
        RegistryTarget(
            targetUrl: path,
            phase: "LIVE",
            status: "published",
            window: TidyMetrics(impressions: impressions, clicks: clicks, ctr: 0, position: 0),
            visits: visits.map {
                VisitsWindow(
                    current: .init(pageviews: $0, visits: $0),
                    previous: .init(pageviews: 0, visits: 0),
                    deltaPageviews: $0,
                    deltaVisits: $0
                )
            },
            indexed: indexed,
            keywords: keywords.map { RegistryKeyword(keyword: $0, cluster: "c", intent: "informational") }
        )
    }

    func testHasDemandIsTrueOnlyWhenSomeKeywordCarriesAnAnswer() {
        // Drives whether the screen names the market. A market label beside no numbers
        // would be a promise the screen does not keep.
        XCTAssertFalse(RegistryList.hasDemand([target("/a", keywords: ["one", "two"])]))
        XCTAssertFalse(RegistryList.hasDemand([]))

        var withDemand = target("/b", keywords: ["one", "two"])
        withDemand.keywords = [
            RegistryKeyword(keyword: "one", cluster: "c", intent: "informational"),
            RegistryKeyword(
                keyword: "two",
                cluster: "c",
                intent: "informational",
                demand: KeywordDemand(
                    searchVolume: 1_900,
                    difficulty: 31,
                    costPerClick: nil,
                    competition: nil,
                    intent: nil,
                    fetchedAt: "2026-09-08T00:00:00.000Z"
                )
            ),
        ]
        // One answered keyword among many is enough: the market describes them all.
        XCTAssertTrue(RegistryList.hasDemand([target("/a", keywords: ["x"]), withDemand]))
    }

    func testRanksByTheChosenMetricAndKeepsTheServersOrderAmongEquals() {
        let targets = [
            target("/a", impressions: 0, clicks: 0),
            target("/b", impressions: 40, clicks: 1),
            target("/c", impressions: 0, clicks: 0),
            target("/d", impressions: 10, clicks: 9),
        ]

        XCTAssertEqual(RegistryList.rows(targets, sort: .impressions).map(\.targetUrl), ["/b", "/d", "/a", "/c"])
        XCTAssertEqual(RegistryList.rows(targets, sort: .clicks).map(\.targetUrl), ["/d", "/b", "/a", "/c"])
    }

    func testVisitsRankTreatsAPageWithoutThemAsZero() {
        let targets = [target("/none", impressions: 99), target("/seen", visits: 12)]

        XCTAssertEqual(RegistryList.rows(targets, sort: .visits).map(\.targetUrl), ["/seen", "/none"])
    }

    func testPathSortsInNaturalOrder() {
        let targets = [target("/page-10"), target("/page-2"), target("/about")]

        XCTAssertEqual(
            RegistryList.rows(targets, sort: .path).map(\.targetUrl),
            ["/about", "/page-2", "/page-10"]
        )
    }

    func testTheFilterKeepsOnlyThePagesGoogleReportsAsNotIndexed() {
        let targets = [
            target("/held", indexed: "indexed"),
            target("/waiting", indexed: "not-indexed"),
            target("/never-inspected", indexed: "unknown"),
            target("/older-server"),
        ]

        XCTAssertEqual(
            RegistryList.rows(targets, sort: .path, unindexedOnly: true).map(\.targetUrl),
            ["/waiting"]
        )
        XCTAssertEqual(RegistryList.unindexedCount(targets), 1)
    }

    func testTotalsCountEveryTargetTheServerSentAndTheirShares() {
        let targets = [
            target("/held", indexed: "indexed", keywords: ["one", "two"]),
            target("/waiting", indexed: "not-indexed", keywords: ["three"]),
            target("/never-inspected", indexed: "unknown", keywords: ["four"]),
            // An inventory-only page: tracked, with nothing planned to rank on it.
            target("/sitemap-only", indexed: "indexed"),
        ]

        let totals = RegistryList.totals(targets)

        XCTAssertEqual(totals.pages, 4)
        XCTAssertEqual(totals.withKeywords, 3)
        XCTAssertEqual(totals.keywords, 4)
        XCTAssertEqual(totals.indexed, 2)
        XCTAssertEqual(totals.notIndexed, 1)
        // The page Google answered "unknown" about is neither indexed nor not indexed.
        XCTAssertEqual(totals.unknown, 1)
        XCTAssertEqual(totals.indexedShare, 0.5)
        XCTAssertEqual(totals.keywordShare, 0.75)
    }

    func testAnEmptyRegistryHasNoSharesRatherThanZeroOnes() {
        // Nothing is 0% indexed: a share of nothing is a division by nothing, and the strip
        // shows a dash where the screen would otherwise claim a reading.
        let totals = RegistryList.totals([])

        XCTAssertEqual(totals.pages, 0)
        XCTAssertNil(totals.indexedShare)
        XCTAssertNil(totals.keywordShare)
        XCTAssertEqual(totals.unknown, 0)
    }

    func testAPageFromAnOlderServerCountsAsNeitherIndexedNorNot() {
        // No verdict at all is the same reading as "unknown": Google has not spoken.
        let totals = RegistryList.totals([target("/older-server")])

        XCTAssertEqual(totals.indexed, 0)
        XCTAssertEqual(totals.notIndexed, 0)
        XCTAssertEqual(totals.unknown, 1)
        XCTAssertEqual(totals.indexedShare, 0)
    }

    func testCoverageDaysKeepTheServersOrderAndDropWhatIsNotADay() {
        let days = [
            IndexCoverageDay(date: "2026-09-07", tracked: 27, indexed: 3, notIndexed: 24),
            IndexCoverageDay(date: "not-a-day", tracked: 27, indexed: 9, notIndexed: 18),
            IndexCoverageDay(date: "2026-09-09", tracked: 30, indexed: 12, notIndexed: 15),
        ]

        let plotted = RegistryList.coverageDays(days)

        XCTAssertEqual(plotted.map(\.date), ["2026-09-07", "2026-09-09"])
        XCTAssertEqual(plotted.first?.indexedShare, 3.0 / 27.0)
        // Tracked is the denominator, so the pages Google said nothing about are the rest.
        XCTAssertEqual(plotted.last?.unknown, 3)
    }

    func testSearchMatchesThePathAndTheMappedKeywords() {
        let targets = [
            target("/sleeves", keywords: ["card sleeves"]),
            target("/mounts", keywords: ["Wall Mount", "bracket"]),
            target("/about"),
        ]

        XCTAssertEqual(RegistryList.rows(targets, sort: .path, search: "SLEEV").map(\.targetUrl), ["/sleeves"])
        // The keyword is enough; the path need not carry the word at all.
        XCTAssertEqual(RegistryList.rows(targets, sort: .path, search: "wall").map(\.targetUrl), ["/mounts"])
        XCTAssertEqual(RegistryList.rows(targets, sort: .path, search: "  ").count, 3)
    }

    func testTheFilterAndTheSearchNarrowTogether() {
        let targets = [
            target("/sleeves", indexed: "not-indexed"),
            target("/sleeve-guide", indexed: "indexed"),
            target("/mounts", indexed: "not-indexed"),
        ]

        XCTAssertEqual(
            RegistryList.rows(targets, sort: .path, unindexedOnly: true, search: "sleeve").map(\.targetUrl),
            ["/sleeves"]
        )
    }
}
