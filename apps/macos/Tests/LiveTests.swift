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

    func testRegistryTargetDecodesEveryFieldTheServerSends() throws {
        // The shape of one target as `/api/registry` sends it, fields and all.
        let target = try decode("""
        {"targetUrl":"/chrome-extension","phase":"LIVE","state":"measuring",
         "indexed":"indexed","coverageState":"Submitted and indexed",
         "inspectedAt":"2026-09-08 14:58:33","priority":"P0","intent":"product-solution",
         "publishedAt":"2026-07-16","baselineDate":"2026-07-16","status":"Published",
         "whyOpportunity":"Read-later extension demand is established.",
         "measuredFrom":"2026-08-09",
         "window":{"impressions":15,"clicks":0,"ctr":0,"position":41.5},
         "baseline":{"impressions":0,"clicks":0,"ctr":0,"position":0},
         "visits":{"current":{"pageviews":16,"visits":10},"previous":{"pageviews":0,"visits":0},
                   "deltaPageviews":16,"deltaVisits":10},
         "keywords":[{"keyword":"Chrome read later extension","cluster":"Chrome capture",
                      "intent":"product-solution","country":"nld"}]}
        """, as: RegistryTarget.self)

        XCTAssertEqual(target.priority, "P0")
        XCTAssertEqual(target.publishedAt, "2026-07-16")
        XCTAssertEqual(target.measuredFrom, "2026-08-09")
        XCTAssertEqual(target.baseline?.impressions, 0)
        XCTAssertEqual(target.mappedKeywords.count, 1)
        XCTAssertEqual(target.mappedKeywords.first?.cluster, "Chrome capture")
        XCTAssertEqual(RegistryPhase(rawValue: target.phase), .live)
        // The registry's own words are the sitemap page's too, with nulls where it has none.
        let inventory = try decode("""
        {"targetUrl":"/support","phase":"PAGE","state":"measuring","indexed":"not-indexed",
         "coverageState":"URL is unknown to Google","inspectedAt":"2026-09-08 14:58:33",
         "priority":null,"intent":"site-inventory","publishedAt":"2026-07-18","baselineDate":null,
         "status":"Inventory only","whyOpportunity":null,"measuredFrom":"2026-08-09",
         "window":{"impressions":0,"clicks":0,"ctr":0,"position":0},"baseline":null,
         "visits":null,"keywords":[]}
        """, as: RegistryTarget.self)

        XCTAssertTrue(inventory.isUnindexed)
        XCTAssertNil(inventory.priority)
        XCTAssertNil(inventory.baseline)
        XCTAssertTrue(inventory.mappedKeywords.isEmpty)
    }

    func testOnlyANotIndexedVerdictDimsARegistryRow() throws {
        let targets = try decode("""
        [{"targetUrl":"/","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5},
          "indexed":"indexed","coverageState":"Submitted and indexed"},
         {"targetUrl":"/waiting","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5},
          "indexed":"not-indexed","coverageState":"Discovered - currently not indexed"},
         {"targetUrl":"/never-inspected","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5},
          "indexed":"unknown","coverageState":null},
         {"targetUrl":"/older-server","phase":"live","status":"published",
          "window":{"impressions":10,"clicks":1,"ctr":0.1,"position":5}}]
        """, as: [RegistryTarget].self)

        XCTAssertFalse(targets[0].isUnindexed)
        XCTAssertTrue(targets[1].isUnindexed)
        XCTAssertEqual(targets[1].coverageState, "Discovered - currently not indexed")
        // A verdict Google has not given, and a server that sends none, are not "not indexed".
        XCTAssertFalse(targets[2].isUnindexed)
        XCTAssertFalse(targets[3].isUnindexed)
        XCTAssertNil(targets[3].indexed)
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
                  "syncedAt":null},
         "revenue":{"provider":"polar","accountId":null,"ready":true,"reason":null},
         "sales":{"date":"2026-09-07","timeZone":"Europe/Amsterdam","orders":2,"revenue":2665,
                  "net":2370,"currency":"USD","syncedAt":"2026-09-07T19:45:02Z"}}
        """, as: TodayReport.self)

        XCTAssertEqual(report.today?.site?.visits, 40)
        XCTAssertEqual(report.today?.hoursElapsed, 22)
        XCTAssertEqual(report.today?.pages.first?.page, "/")
        XCTAssertEqual(report.today?.eventCount, 7)
        XCTAssertEqual(report.sales?.orders, 2)
        XCTAssertEqual(report.sales?.revenue, 2665)
        XCTAssertEqual(report.sales?.currency, "USD")
        XCTAssertEqual(report.revenue?.provider, "polar")

        let none = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"debug","analytics":null,"today":null,
         "revenue":null,"sales":null}
        """, as: TodayReport.self)
        XCTAssertNil(none.today)
        XCTAssertNil(none.sales)

        // A day the server has not written yet: the totals are zeros, and only the null
        // syncedAt says they are not a measurement.
        let unsynced = try decode("""
        {"generatedAt":"2026-09-07T19:51:20.381Z","mode":"live","analytics":null,"today":null,
         "revenue":{"provider":"polar","accountId":null,"ready":true,"reason":null},
         "sales":{"date":"2026-09-07","timeZone":"Europe/Amsterdam","orders":0,"revenue":0,
                  "net":0,"currency":null,"syncedAt":null}}
        """, as: TodayReport.self)
        XCTAssertNil(unsynced.sales?.syncedAt)
        XCTAssertNil(unsynced.sales?.currency)
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
