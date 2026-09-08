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
            keywords: keywords.map { RegistryKeyword(keyword: $0, cluster: "c", intent: "informational", country: "nl") }
        )
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
