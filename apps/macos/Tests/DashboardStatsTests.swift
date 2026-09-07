import XCTest
@testable import RankstasParadise

final class DashboardStatsTests: XCTestCase {
    func testAggregatesHistoryUsingImpressionWeightedPosition() {
        let stats = DashboardStats(days: [
            HistoryDay(date: "2026-09-01", impressions: 100, clicks: 10, ctr: 0.1, position: 4),
            HistoryDay(date: "2026-09-02", impressions: 300, clicks: 15, ctr: 0.05, position: 8)
        ])

        XCTAssertEqual(stats.clicks, 25)
        XCTAssertEqual(stats.impressions, 400)
        XCTAssertEqual(stats.ctr, 0.0625)
        XCTAssertEqual(stats.position, 7)
    }

    func testEmptyHistoryProducesZeroMetrics() {
        let stats = DashboardStats(days: [])

        XCTAssertEqual(stats.clicks, 0)
        XCTAssertEqual(stats.impressions, 0)
        XCTAssertEqual(stats.ctr, 0)
        XCTAssertEqual(stats.position, 0)
    }
}
