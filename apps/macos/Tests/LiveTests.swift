import XCTest
@testable import RankstasParadise

final class LiveTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testLiveReportDecodesTheServersShape() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"live",
         "analytics":{"provider":"rybbit","siteId":"11ce3965208b","ready":true,"reason":null},
         "live":{"visitors":20,"windowMinutes":30,"online":3,"onlineWindowMinutes":5,
                 "series":[0,1,0,2],"fetchedAt":"2026-09-07T19:51:20.381Z"}}
        """, as: LiveReport.self)

        XCTAssertEqual(report.analytics?.provider, "rybbit")
        XCTAssertEqual(report.analytics?.ready, true)
        XCTAssertEqual(report.live?.visitors, 20)
        XCTAssertEqual(report.live?.windowMinutes, 30)
        XCTAssertEqual(report.live?.series, [0, 1, 0, 2])
        // The header shows the tight count, and says which window it is.
        XCTAssertEqual(report.live?.onlineNow, 3)
        XCTAssertEqual(report.live?.onlineMinutes, 5)
    }

    func testASiteWithoutAnalyticsDecodesToNulls() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"debug","analytics":null,"live":null}
        """, as: LiveReport.self)

        XCTAssertNil(report.analytics)
        XCTAssertNil(report.live)
    }

    func testAnOlderServerWithoutTheSeriesStillDecodes() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"live","analytics":null,
         "live":{"visitors":2,"windowMinutes":5,"fetchedAt":"2026-09-07T19:51:20.381Z"}}
        """, as: LiveReport.self)

        XCTAssertEqual(report.live?.visitors, 2)
        XCTAssertNil(report.live?.series)
        // Without an online count the whole window stands in, and is labelled as such.
        XCTAssertEqual(report.live?.onlineNow, 2)
        XCTAssertEqual(report.live?.onlineMinutes, 5)
        // The card still draws its bars, all empty, over the window it was told.
        XCTAssertEqual(report.live?.bars.count, 5)
        XCTAssertEqual(report.live?.bars.reduce(0, +), 0)
    }

    func testBarsAreExactlyTheWindowLong() throws {
        let short = LiveVisitors(visitors: 3, windowMinutes: 6, series: [1, 2], fetchedAt: "2026-09-07T19:51:20Z")
        XCTAssertEqual(short.bars, [0, 0, 0, 0, 1, 2])

        let long = LiveVisitors(visitors: 3, windowMinutes: 3, series: [9, 1, 2, 3], fetchedAt: "2026-09-07T19:51:20Z")
        XCTAssertEqual(long.bars, [1, 2, 3])
    }

    func testRegistryTargetsDecodeWithAndWithoutVisits() throws {
        let targets = try decode("""
        [{"targetUrl":"/","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5},
          "visits":{"current":{"pageviews":840,"visits":560},"previous":{"pageviews":800,"visits":500},
                    "deltaPageviews":40,"deltaVisits":60}},
         {"targetUrl":"/old","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5},"visits":null},
         {"targetUrl":"/older-server","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5}}]
        """, as: [RegistryTarget].self)

        XCTAssertEqual(targets[0].visits?.current.visits, 560)
        XCTAssertEqual(targets[0].visits?.deltaVisits, 60)
        XCTAssertNil(targets[1].visits)
        XCTAssertNil(targets[2].visits)
    }

    func testTodayReportDecodes() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"live",
         "analytics":{"provider":"rybbit","siteId":"x","ready":true,"reason":null},
         "today":{"date":"2026-09-07","timeZone":"Europe/Amsterdam","hoursElapsed":22,
                  "site":{"date":"2026-09-07","pageviews":120,"visits":40,"visitors":33},
                  "hours":[{"hour":0,"pageviews":1,"visits":1,"visitors":1}],
                  "pages":[{"date":"2026-09-07","page":"/","pageviews":60,"visits":30}],
                  "events":[{"date":"2026-09-07","name":"purchase","count":2},{"date":"2026-09-07","name":"login","count":5}],
                  "syncedAt":null}}
        """, as: TodayReport.self)

        XCTAssertEqual(report.today?.site?.visits, 40)
        XCTAssertEqual(report.today?.hoursElapsed, 22)
        XCTAssertEqual(report.today?.pages.first?.page, "/")
        XCTAssertEqual(report.today?.eventCount, 7)

        let none = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"debug","analytics":null,"today":null}
        """, as: TodayReport.self)
        XCTAssertNil(none.today)
    }

    func testEventsReportDecodes() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"live",
         "analytics":{"provider":"rybbit","siteId":"x","ready":true,"reason":null},
         "windowDays":28,
         "window":{"currentStart":"2026-08-10","currentEnd":"2026-09-06","previousStart":"2026-07-13","previousEnd":"2026-08-09"},
         "events":[{"name":"purchase","current":12,"previous":9,"delta":3}]}
        """, as: EventsReport.self)

        XCTAssertEqual(report.windowDays, 28)
        XCTAssertEqual(report.events.first?.name, "purchase")
        XCTAssertEqual(report.events.first?.delta, 3)
    }

    func testHistoryDaysDecodeWithAndWithoutVisits() throws {
        let days = try decode("""
        [{"date":"2026-09-06","provisional":false,"impressions":10,"clicks":1,"ctr":0.1,"position":5,
          "visits":{"pageviews":1078,"visits":109,"visitors":92}},
         {"date":"2026-09-05","provisional":true,"impressions":10,"clicks":1,"ctr":0.1,"position":5}]
        """, as: [HistoryReportDay].self)

        XCTAssertEqual(days[0].visits?.visitors, 92)
        XCTAssertNil(days[1].visits)
    }
}
