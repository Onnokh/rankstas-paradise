import XCTest
@testable import RankstasParadise

final class VisitsComparisonTests: XCTestCase {
    private func day(_ n: Int, visits: Double?) -> HistoryReportDay {
        HistoryReportDay(
            date: String(format: "2026-01-%02d", n),
            provisional: false,
            impressions: 10,
            clicks: 1,
            ctr: 0.1,
            position: 5,
            visits: visits.map { VisitsDay(pageviews: $0 * 3, visits: $0, visitors: $0 - 1) }
        )
    }

    func testNoDayWithVisitsMeansNoComparison() {
        let days = (1...6).map { day($0, visits: nil) }
        XCTAssertNil(VisitsComparison(days: days, window: 3))
    }

    func testSumsVisitsOverBothPeriods() {
        let days = (1...6).map { day($0, visits: Double($0 * 10)) }
        let comparison = VisitsComparison(days: days, window: 3)
        XCTAssertEqual(comparison?.current, 150)
        XCTAssertEqual(comparison?.previous, 60)
        XCTAssertEqual(comparison?.trend?.delta, 90)
    }

    func testASeriesThatOnlyJustStartedHasNoPreviousToCompareWith() {
        // Three days of visits at the end of a longer Search Console series: the previous
        // period has no synced day, so there is a total but no delta.
        let days = (1...3).map { day($0, visits: nil) } + (4...6).map { day($0, visits: 20) }
        let comparison = VisitsComparison(days: days, window: 3)
        XCTAssertEqual(comparison?.current, 60)
        XCTAssertNil(comparison?.previous)
        XCTAssertNil(comparison?.trend)
    }
}
