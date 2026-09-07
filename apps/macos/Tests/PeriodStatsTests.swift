import XCTest
@testable import RankstasParadise

final class PeriodStatsTests: XCTestCase {
    private func day(_ n: Int, clicks: Double, impressions: Double, position: Double = 5) -> HistoryDay {
        HistoryDay(date: String(format: "2026-01-%02d", n), impressions: impressions, clicks: clicks, ctr: impressions > 0 ? clicks / impressions : 0, position: position)
    }

    func testPeriodsCoverTheSketchAndNeedTwiceTheLongestSpan() {
        XCTAssertEqual(Period.allCases.map(\.label), ["Today", "7d", "14d", "28d", "3m", "6m"])
        XCTAssertEqual(Period.allCases.map(\.days), [1, 7, 14, 28, 90, 180])
        XCTAssertEqual(Period.historyLimit, 360)
    }

    func testComparisonCutsCurrentAndPreviousFromTheEndOfTheSeries() {
        let days = (1...10).map { day($0, clicks: Double($0), impressions: 10) }
        let comparison = PeriodComparison(days: days, window: 3)
        XCTAssertEqual(comparison.current.map(\.clicks), [8, 9, 10])
        XCTAssertEqual(comparison.previous.map(\.clicks), [5, 6, 7])
        XCTAssertEqual(comparison.clicks?.delta, 9)
        XCTAssertEqual(comparison.clicks?.ratio ?? 0, 0.5, accuracy: 0.0001)
    }

    func testShortSeriesStillYieldsCurrentAndAPartialPrevious() {
        let days = (1...4).map { day($0, clicks: 1, impressions: 10) }
        let comparison = PeriodComparison(days: days, window: 3)
        XCTAssertEqual(comparison.current.count, 3)
        XCTAssertEqual(comparison.previous.count, 1)
        XCTAssertNil(PeriodComparison(days: Array(days.prefix(2)), window: 3).previousStats)
    }

    func testTrendLabelShowsPercentOnlyWithABase() {
        let expected = "\(Trend.signed(-1, fractionDigits: 0)) (\(Trend.signed(-100.0 / 3, fractionDigits: 1))%)"
        XCTAssertEqual(Trend(current: 2, previous: 3).label, expected)
        XCTAssertTrue(expected.hasPrefix("−1 (−33"))
        XCTAssertEqual(Trend(current: 4, previous: 0).label, "+4")
        XCTAssertEqual(Trend(current: 0, previous: 0).label, "+0")
    }

    func testCtrMoveIsInPercentagePoints() {
        let previous = [day(1, clicks: 1, impressions: 100)]
        let current = [day(2, clicks: 3, impressions: 100)]
        let comparison = PeriodComparison(days: previous + current, window: 1)
        XCTAssertEqual(comparison.ctrPointsDelta ?? 0, 2, accuracy: 0.0001)
    }

    func testRatingMoveUsesTheNewestReadingAtLeastTheWindowOld() {
        let history = [
            DomainRatingDay(date: "2026-08-01", rating: 0.1),
            DomainRatingDay(date: "2026-08-20", rating: 0.3),
            DomainRatingDay(date: "2026-09-03", rating: 0.4),
        ]
        let week = RatingMove(history: history, days: 7)
        XCTAssertEqual(week?.current, 0.4)
        XCTAssertEqual(week?.delta ?? 0, 0.1, accuracy: 0.0001)
        XCTAssertEqual(week?.since, "2026-08-20")

        let halfYear = RatingMove(history: history, days: 180)
        XCTAssertEqual(halfYear?.current, 0.4)
        XCTAssertNil(halfYear?.delta, "The series does not reach back far enough for a baseline.")
        XCTAssertNil(RatingMove(history: [], days: 7))
    }
}
