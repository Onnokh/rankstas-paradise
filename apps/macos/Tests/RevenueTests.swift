import XCTest
@testable import RankstasParadise

final class RevenueTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testRevenueReportDecodesTheServersShape() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-08T07:00:00.000Z","mode":"live",
         "revenue":{"provider":"polar","accountId":null,"ready":true,"reason":null},
         "windowDays":7,
         "window":{"currentStart":"2026-09-01","currentEnd":"2026-09-07","previousStart":"2026-08-25","previousEnd":"2026-08-31"},
         "currency":"USD",
         "days":[{"date":"2026-09-06","orders":2,"revenue":3998,"net":3998,"currency":"USD"},
                 {"date":"2026-09-07","orders":0,"revenue":0,"net":0,"currency":"USD"}],
         "current":{"orders":2,"revenue":3998,"net":3998},
         "previous":{"orders":1,"revenue":1999,"net":1999},
         "delta":{"orders":1,"revenue":1999,"net":1999}}
        """, as: RevenueReport.self)

        XCTAssertEqual(report.revenue?.provider, "polar")
        XCTAssertEqual(report.revenue?.ready, true)
        XCTAssertEqual(report.currency, "USD")
        XCTAssertEqual(report.days.count, 2)
        XCTAssertEqual(report.days[0].revenue, 3998)
        XCTAssertEqual(report.current.orders, 2)
        XCTAssertEqual(report.delta.revenue, 1999)
        // The day plots at noon UTC, like the history days.
        XCTAssertEqual(report.days[0].day, ISODay.date("2026-09-06")?.addingTimeInterval(12 * 3600))
    }

    func testASiteWithoutACommerceProviderDecodesToNulls() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-08T07:00:00.000Z","mode":"debug","revenue":null,"windowDays":28,
         "window":{"currentStart":null,"currentEnd":null,"previousStart":null,"previousEnd":null},
         "currency":null,"days":[],
         "current":{"orders":0,"revenue":0,"net":0},"previous":{"orders":0,"revenue":0,"net":0},
         "delta":{"orders":0,"revenue":0,"net":0}}
        """, as: RevenueReport.self)

        XCTAssertNil(report.revenue)
        XCTAssertNil(report.currency)
        XCTAssertTrue(report.days.isEmpty)
    }

    func testMoneyShowsMinorUnitsInTheCurrency() {
        XCTAssertEqual(Money.format(123450, currency: "USD"), 1234.5.formatted(.currency(code: "USD").precision(.fractionLength(2))))
        XCTAssertEqual(Money.format(1999, currency: nil), 19.99.formatted(.number.precision(.fractionLength(2))))
        XCTAssertTrue(Money.signed(1999, currency: "USD").hasPrefix("+"))
        XCTAssertTrue(Money.signed(-1999, currency: "USD").hasPrefix("−"))
        XCTAssertEqual(Money.signed(-1999, currency: "USD").dropFirst(), Money.format(1999, currency: "USD")[...])
    }
}
