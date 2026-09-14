import XCTest
@testable import RankstasParadise

/// The tab bar says how current the pane in front is, for every page. What "current" means
/// depends on the pane, and the two readings that are easy to get wrong are here.
@MainActor
final class FreshnessTests: XCTestCase {
    private func overview(_ id: String, generatedAt: String?) -> SiteOverview {
        SiteOverview(
            site: Site(id: id, name: id, origin: "https://\(id).test"),
            dashboard: generatedAt.map { generatedAt in
                DashboardEnvelope(
                    generatedAt: generatedAt,
                    mode: "live",
                    summary: Summary(rows: 1, dates: 1),
                    digest: OpportunityDigest(latestDate: "2026-09-13", signals: []),
                    history: [HistoryDay(date: "2026-09-13", impressions: 10, clicks: 1, ctr: 0.1, position: 4)]
                )
            },
            errorMessage: nil
        )
    }

    /// The whole fleet is on the Overview, so the page is only as current as the project that
    /// has waited longest: the oldest reading, not the newest.
    func testTheOverviewIsAsCurrentAsItsStalestProject() {
        let overviews = [
            overview("fresh", generatedAt: "2026-09-14T12:00:00Z"),
            overview("stale", generatedAt: "2026-09-14T08:00:00Z"),
        ]
        XCTAssertEqual(
            Freshness.updatedAt(.overview, overviews: overviews, feeds: [:]),
            Instant.parse("2026-09-14T08:00:00Z")
        )
    }

    func testAProjectNamesItsOwnDashboard() {
        let overviews = [
            overview("a", generatedAt: "2026-09-14T12:00:00Z"),
            overview("b", generatedAt: "2026-09-14T08:00:00Z"),
        ]
        XCTAssertEqual(
            Freshness.updatedAt(.site("b"), overviews: overviews, feeds: [:]),
            Instant.parse("2026-09-14T08:00:00Z")
        )
    }

    /// The Realtime is drawn from the feed the server polls, so it names the newest answer.
    func testTheRealtimeNamesTheNewestFeedAnswer() {
        let newest = Date(timeIntervalSince1970: 1_757_000_000)
        let feeds = [
            "a": LiveFeed(windowMinutes: 30, fetchedAt: newest.addingTimeInterval(-600)),
            "b": LiveFeed(windowMinutes: 30, fetchedAt: newest),
        ]
        XCTAssertEqual(Freshness.updatedAt(.realtime, overviews: [], feeds: feeds), newest)
    }

    /// Nothing loaded is not a date, and the bar says nothing rather than "just now".
    func testNothingLoadedIsNoReading() {
        XCTAssertNil(Freshness.updatedAt(.overview, overviews: [overview("a", generatedAt: nil)], feeds: [:]))
        XCTAssertNil(Freshness.updatedAt(.realtime, overviews: [], feeds: [:]))
        XCTAssertNil(Freshness.updatedAt(.site("nobody"), overviews: [], feeds: [:]))
    }
}
