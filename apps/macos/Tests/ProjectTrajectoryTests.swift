import XCTest
@testable import RankstasParadise

final class ProjectTrajectoryTests: XCTestCase {
    // MARK: Growth

    func testGrowthRatioIsAgainstThePeriodBefore() {
        XCTAssertEqual(Growth(current: 130, previous: 100).ratio, 0.3)
        XCTAssertEqual(Growth(current: 70, previous: 100).ratio, -0.3)
    }

    func testGrowthHasNoRatioWithoutABase() {
        XCTAssertNil(Growth(current: 12, previous: nil).ratio, "no earlier period stored")
        XCTAssertNil(Growth(current: 12, previous: 0).ratio, "an earlier period of nothing is not a base")
    }

    // MARK: Runs

    func testBucketsSumFromTheEndSoBothRunsShareTheirLastDay() {
        let days = (1...10).map { (Date(timeIntervalSinceReferenceDate: Double($0) * 86_400), Double($0)) }
        let points = ComparisonRun.buckets(days, size: 7)
        // Ten days in sevens from the end: the newest seven, then the three left over.
        XCTAssertEqual(points.map(\.value), [6.0, 49.0])
        XCTAssertEqual(points.last?.date, days.last?.0, "a point is dated by the last day it sums")
    }

    func testSmoothingIsATrailingMean() {
        let smoothed = ComparisonRun.smoothed([0, 0, 0, 7, 7, 7, 7, 7, 7, 7], window: 7)
        XCTAssertEqual(smoothed[0], 0)
        XCTAssertEqual(smoothed[3], 7.0 / 4)
        XCTAssertEqual(smoothed[9], 7, accuracy: 0.0001, "a full window of sevens is seven")
        XCTAssertEqual(ComparisonRun.smoothed([1, 2, 3], window: 7), [1, 2, 3], "a run shorter than the window is left alone")
    }

    /// The line is drawn through the mean, but a point still knows its own day: two clicks
    /// on one day of a month are a bump at 0.29 and a label that says 2. Checked by
    /// neutering: let `smoothed` drop `measured` and this fails.
    func testASmoothedPointKeepsWhatItsDayMeasured() {
        var days = (0..<28).map { (Date(timeIntervalSinceReferenceDate: Double($0) * 86_400), 0.0) }
        days[20].1 = 2
        var before = Array(repeating: 0.0, count: 28)
        before[20] = 5
        let run = ComparisonRun.make(current: days, previous: before, period: .d28)

        XCTAssertEqual(run.current[20].value, 2.0 / 7, accuracy: 0.0001, "drawn at the seven-day mean")
        XCTAssertEqual(run.current[20].measured, 2, "but the day measured two")
        XCTAssertEqual(run.current[22].measured, 0, "and the days after it measured nothing, though the line is still up")
        XCTAssertEqual(run.previous[20], 5.0 / 7, accuracy: 0.0001)
        XCTAssertEqual(run.previousMeasured[20], 5)
        XCTAssertEqual(run.previousMeasured.count, run.previous.count)
    }

    func testADayIsAPointUpToAMonthAndAWeekBeyond() {
        XCTAssertEqual(ComparisonRun.bucketSize(for: .d7), 1)
        XCTAssertEqual(ComparisonRun.bucketSize(for: .d28), 1)
        XCTAssertEqual(ComparisonRun.bucketSize(for: .m3), 7)
        XCTAssertFalse(ComparisonRun.smooths(.d7), "a week has no room for a seven-day mean")
        XCTAssertTrue(ComparisonRun.smooths(.d28))
        XCTAssertFalse(ComparisonRun.smooths(.m6), "weekly points are already smooth")
    }

    func testAnEarlierTotalIsSpreadEvenlyAndMarked() {
        let days = (0..<4).map { (Date(timeIntervalSinceReferenceDate: Double($0) * 86_400), 10.0) }
        let run = ComparisonRun.make(current: days, previousTotal: 20, period: .d7)
        XCTAssertEqual(run.previous, [5, 5, 5, 5])
        XCTAssertTrue(run.previousIsAverage)
        XCTAssertEqual(ComparisonRun.make(current: [], previousTotal: 20, period: .d7).previous, [], "nothing to spread over")
    }

    // MARK: Plan

    func testTheFunnelCountsKeywordPagesOnly() {
        let targets = [
            target("/a", phase: "LIVE", indexed: "indexed", impressions: 40, clicks: 3, keywords: 1),
            target("/b", phase: "NONE", indexed: "indexed", impressions: 0, clicks: 0, keywords: 1),
            target("/c", phase: "NEW", indexed: nil, impressions: 0, clicks: 0, keywords: 1),
            target("/d", phase: "PAGE", indexed: "indexed", impressions: 90, clicks: 9, keywords: 0),
        ]
        let funnel = PlanFunnel(targets: targets)
        XCTAssertEqual(funnel.planned, 3, "the inventory page aims at nothing")
        XCTAssertEqual(funnel.published, 2)
        XCTAssertEqual(funnel.indexed, 2)
        XCTAssertEqual(funnel.reached, 1)
        XCTAssertEqual(funnel.clicked, 1)
    }

    func testTheIndexedMoveIsAgainstTheReadingAPeriodAgo() {
        let coverage = [
            IndexCoverageDay(date: "2026-08-10", keywordTargets: 10, indexed: 5, notIndexed: 2),
            IndexCoverageDay(date: "2026-08-20", keywordTargets: 10, indexed: 6, notIndexed: 2),
            IndexCoverageDay(date: "2026-09-12", keywordTargets: 10, indexed: 8, notIndexed: 1),
        ]
        // Seven days before the 12th is the 5th of September: the newest reading on or before
        // it is the 20th of August, at 60 percent.
        XCTAssertEqual(ProjectTrajectory.indexedMove(coverage, days: 7) ?? .nan, 20, accuracy: 0.0001)
        XCTAssertNil(ProjectTrajectory.indexedMove(coverage, days: 90), "the series does not reach back a quarter")
        XCTAssertNil(ProjectTrajectory.indexedMove([], days: 7))
    }

    // MARK: Make

    func testASiteWithoutProvidersHasNoVisitsSalesOrPlan() {
        let site = Site(id: "s", name: "S", origin: "https://s.test")
        let days = (1...56).map { HistoryReportDay(date: "2026-07-\(String(format: "%02d", min($0, 31)))", provisional: false, impressions: 10, clicks: 1, ctr: 0.1, position: 5) }
        let project = ProjectTrajectory.make(
            overview: SiteOverview(site: site, dashboard: nil, errorMessage: nil),
            series: days,
            revenue: RevenueReport(generatedAt: "", revenue: nil, windowDays: 28, currency: nil, days: [], current: .zero, previous: .zero, delta: .zero),
            targets: nil,
            coverage: [],
            period: .d28
        )
        XCTAssertEqual(project.clicks.current, 28)
        XCTAssertEqual(project.clicks.previous, 28)
        XCTAssertNil(project.visits, "no day carries visits")
        XCTAssertNil(project.sales, "the report names no provider")
        XCTAssertNil(project.plan, "no registry has landed")
        XCTAssertEqual(project.clicksRun.current.count, 28)
        XCTAssertEqual(project.clicksRun.previous.count, 28)
    }

    private func target(_ path: String, phase: String, indexed: String?, impressions: Double, clicks: Double, keywords: Int) -> RegistryTarget {
        RegistryTarget(
            targetUrl: path,
            phase: phase,
            status: "active",
            window: TidyMetrics(impressions: impressions, clicks: clicks, ctr: 0, position: 10),
            indexed: indexed,
            keywords: (0..<keywords).map { RegistryKeyword(keyword: "k\($0)", cluster: "c", intent: "info") }
        )
    }
}

private extension RevenueTotals {
    static let zero = RevenueTotals(orders: 0, revenue: 0, net: 0)
}
