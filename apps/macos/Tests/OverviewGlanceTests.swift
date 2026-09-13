import XCTest
@testable import RankstasParadise

/// The Overview's rows and totals, checked on two sites: one with its long series loaded
/// and visits in it, one still on the dashboard's own days.
@MainActor
final class OverviewGlanceTests: XCTestCase {
    private let sleevy = Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.com")
    private let mounts = Site(id: "mounts", name: "Missing Mounts", origin: "https://missingmounts.com")

    /// `count` days ending on the 14th of September, every day the same, so a window's sum is
    /// the day times the window.
    private func series(_ count: Int, clicks: Double, impressions: Double, position: Double, visits: Double?) -> [HistoryReportDay] {
        (0..<count).reversed().map { back in
            let day = ISODay.string(ISODay.date("2026-09-14")!.addingTimeInterval(-Double(back) * 86_400))
            return HistoryReportDay(
                date: day,
                provisional: false,
                impressions: impressions,
                clicks: clicks,
                ctr: clicks / impressions,
                position: position,
                visits: visits.map { VisitsDay(pageviews: $0 * 2, visits: $0, visitors: $0) }
            )
        }
    }

    private func dashboard(_ days: [HistoryReportDay]) -> DashboardEnvelope {
        DashboardEnvelope(
            generatedAt: "2026-09-14T12:00:00Z",
            mode: "live",
            summary: Summary(rows: 0, dates: days.count),
            digest: OpportunityDigest(latestDate: "2026-09-14", signals: []),
            history: days.map(\.asHistoryDay)
        )
    }

    func testASiteReadsItsSeriesWhenLoadedAndTheDashboardUntilThen() {
        let overviews = [
            SiteOverview(site: sleevy, dashboard: dashboard(series(28, clicks: 1, impressions: 10, position: 5, visits: nil)), errorMessage: nil),
            SiteOverview(site: mounts, dashboard: dashboard(series(28, clicks: 2, impressions: 20, position: 8, visits: nil)), errorMessage: nil),
        ]
        // Sleevy's series is loaded, long and counted by the provider: 7 clicks a day now, 3 before.
        let loaded = series(7, clicks: 3, impressions: 30, position: 6, visits: 40) + series(7, clicks: 7, impressions: 70, position: 4, visits: 100)
        let rows = OverviewGlance.rows(overviews: overviews, series: [sleevy.id: loaded], period: .d7)

        XCTAssertEqual(rows.map(\.id), [sleevy.id, mounts.id], "The server's order, which is the tab bar's.")

        let first = rows[0]
        XCTAssertEqual(first.comparison.currentStats.clicks, 49, "Seven days of seven clicks, from the series.")
        XCTAssertEqual(first.comparison.clicks?.delta, 28, "Against seven days of three.")
        XCTAssertEqual(first.visits?.current, 700)
        XCTAssertEqual(first.visits?.previous, 280)

        let second = rows[1]
        XCTAssertEqual(second.comparison.currentStats.clicks, 14, "Seven days of two clicks, from the dashboard's own days.")
        XCTAssertEqual(second.comparison.clicks?.delta, 0, "The dashboard reaches back far enough for a 7-day comparison.")
        XCTAssertNil(second.visits, "The dashboard's days carry no visits.")
    }

    func testTotalsSumTheSitesAndWeightThePositionByImpressions() {
        let rows = [
            SiteGlance(
                site: sleevy,
                comparison: PeriodComparison(days: series(14, clicks: 1, impressions: 10, position: 2, visits: nil).map(\.asHistoryDay), window: 7),
                visits: VisitsComparison(current: 100, previous: 50),
                errorMessage: nil
            ),
            SiteGlance(
                site: mounts,
                comparison: PeriodComparison(days: series(14, clicks: 3, impressions: 30, position: 10, visits: nil).map(\.asHistoryDay), window: 7),
                visits: nil,
                errorMessage: nil
            ),
        ]

        let total = OverviewGlance.total(rows)
        XCTAssertEqual(total.currentStats.clicks, 28)
        XCTAssertEqual(total.currentStats.impressions, 280)
        XCTAssertEqual(total.currentStats.position, 8, accuracy: 0.0001, "10 impressions at 2 and 30 at 10 average to 8, not 6.")
        XCTAssertEqual(total.clicks?.delta, 0)

        let visits = OverviewGlance.totalVisits(rows)
        XCTAssertEqual(visits?.current, 100, "A site without a provider adds nothing and hides nothing.")
        XCTAssertEqual(visits?.previous, 50)
    }

    func testNoProviderAnywhereIsNoVisitsAndNoEarlierDayIsNoComparison() {
        let blind = SiteGlance(site: sleevy, comparison: PeriodComparison(current: [], previous: []), visits: nil, errorMessage: nil)
        XCTAssertNil(OverviewGlance.totalVisits([blind]))

        let young = SiteGlance(site: mounts, comparison: PeriodComparison(current: [], previous: []), visits: VisitsComparison(current: 12, previous: nil), errorMessage: nil)
        let visits = OverviewGlance.totalVisits([blind, young])
        XCTAssertEqual(visits?.current, 12)
        XCTAssertNil(visits?.previous, "Growth from nothing is not growth.")
        XCTAssertNil(visits?.trend)
    }

    func testTheOverviewOffersEveryStoredPeriodAndNotToday() {
        XCTAssertFalse(OverviewTabState.periods.contains(.today))
        XCTAssertEqual(OverviewTabState.periods.count, Period.allCases.count - 1)
    }
}
