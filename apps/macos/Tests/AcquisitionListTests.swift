import XCTest
@testable import RankstasParadise

/// The acquisition cards' reading of the server's rows: one dimension at a time, strongest
/// first, capped, and never failed by a dimension this build does not know.
final class AcquisitionListTests: XCTestCase {
    private func row(_ dimension: String, _ value: String, current: Double, previous: Double = 0) -> AcquisitionRow {
        AcquisitionRow(dimension: dimension, value: value, current: current, previous: previous, delta: current - previous)
    }

    func testRowsAreCutToOneDimensionStrongestFirstAndCapped() {
        var report = (1...12).map { row("referrer", "host\($0).com", current: Double($0)) }
        report.append(row("channel", "Organic Search", current: 100))
        report.append(row("utm_source", "newsletter", current: 3))

        let referrers = AcquisitionList.rows(AcquisitionList.rows(from: report), for: .referrer)

        XCTAssertEqual(referrers.count, RankingStore.rowLimit, "Ten rows, however many the server sent.")
        XCTAssertEqual(referrers.first?.value, "host12.com")
        XCTAssertEqual(referrers.last?.value, "host3.com")
        XCTAssertTrue(referrers.allSatisfy { $0.dimension == .referrer })
        XCTAssertEqual(
            AcquisitionList.rows(AcquisitionList.rows(from: report), for: .channel).map(\.value),
            ["Organic Search"]
        )
    }

    func testEqualCountsKeepTheServersOrder() {
        let report = [
            row("channel", "Direct", current: 5),
            row("channel", "Organic Search", current: 5),
            row("channel", "Referral", current: 5),
        ]

        let channels = AcquisitionList.rows(AcquisitionList.rows(from: report), for: .channel)

        XCTAssertEqual(channels.map(\.value), ["Direct", "Organic Search", "Referral"])
    }

    func testADimensionThisBuildDoesNotKnowIsSetAsideNotFatal() {
        let report = [
            row("referrer", "google.com", current: 8, previous: 6),
            row("utm_term", "shader", current: 1),
        ]

        let rows = AcquisitionList.rows(from: report)

        XCTAssertEqual(rows.map(\.value), ["google.com"], "The strange row goes, the others stay.")
        XCTAssertEqual(rows.first?.delta, 2, "A stored period carries its move.")
    }

    func testTodayHasNoPreviousPeriod() {
        let rows = AcquisitionList.rows(fromToday: [
            TodayAcquisition(dimension: "utm_campaign", value: "launch", visits: 4),
            TodayAcquisition(dimension: "utm_term", value: "x", visits: 1),
        ])

        XCTAssertEqual(rows.map(\.value), ["launch"])
        XCTAssertNil(rows.first?.previous)
        XCTAssertNil(rows.first?.delta, "There is no previous today to move from.")
    }

    func testTheTwoCardsCoverEveryDimensionOnce() {
        XCTAssertEqual(
            Set(AcquisitionDimension.origins + AcquisitionDimension.tags),
            Set(AcquisitionDimension.allCases)
        )
        XCTAssertEqual((AcquisitionDimension.origins + AcquisitionDimension.tags).count, AcquisitionDimension.allCases.count)
    }
}
