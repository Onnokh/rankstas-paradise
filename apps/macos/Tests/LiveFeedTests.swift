import XCTest
@testable import RankstasParadise

final class LiveFeedTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func event(
        _ id: String,
        at: String,
        kind: LiveEvent.Kind = .pageview,
        page: String = "/",
        name: String? = nil,
        visitor: String = "v"
    ) -> LiveEvent {
        LiveEvent(
            id: id, at: at, kind: kind, name: name, page: page, properties: [:], visitor: visitor,
            country: nil, browser: nil, operatingSystem: nil, device: nil, referrer: nil
        )
    }

    func testLiveEventsReportDecodesTheServersShape() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-08T10:21:15.000Z","mode":"live",
         "analytics":{"provider":"rybbit","siteId":"12","ready":true,"reason":null},
         "events":{"windowMinutes":30,"since":null,"fetchedAt":"2026-09-08T10:21:15.000Z",
          "visitors":[
           {"visitor":"u1","visits":7,"firstSeen":"2026-08-12T08:04:11.000Z","lastSeen":"2026-09-08T10:21:10.000Z"},
           {"visitor":"u2","visits":1,"firstSeen":null,"lastSeen":null}],
          "events":[
           {"id":"a1","at":"2026-09-08T10:21:10.000Z","kind":"event","name":"purchase","page":"/pricing",
            "properties":{"plan":"pro","amount":"29"},"visitor":"u1","country":"ES","browser":"Chrome",
            "operatingSystem":"Windows","device":"desktop","referrer":null},
           {"id":"a2","at":"2026-09-08T10:13:40.000Z","kind":"scroll_depth","name":null,"page":"/shaders/julia",
            "properties":{},"visitor":"u2","country":null,"browser":null,"operatingSystem":null,"device":null,"referrer":null}
         ]}}
        """, as: LiveEventsReport.self)

        let events = try XCTUnwrap(report.events)
        XCTAssertEqual(events.windowMinutes, 30)
        XCTAssertNil(events.since)
        XCTAssertEqual(events.events.count, 2)
        XCTAssertEqual(events.events[0].kind, .event)
        XCTAssertEqual(events.events[0].name, "purchase")
        XCTAssertEqual(events.events[0].properties["plan"], "pro")
        XCTAssertEqual(events.events[0].date, Instant.parse("2026-09-08T10:21:10.000Z"))
        // A kind this build does not know reads as a plain event, not a decoding failure.
        XCTAssertEqual(events.events[1].kind, .event)
        XCTAssertNil(events.events[1].country)
        XCTAssertEqual(events.visitors?.count, 2)
        XCTAssertEqual(events.visitors?.first?.visits, 7)
        XCTAssertEqual(events.visitors?.first?.firstSeenDate, Instant.parse("2026-08-12T08:04:11.000Z"))
        XCTAssertNil(events.visitors?.last?.firstSeen)
    }

    func testAServerWithoutVisitorHistoriesStillDecodes() throws {
        // The shape as it was before the histories: the feed must not need them.
        let report = try decode("""
        {"generatedAt":"2026-09-08T10:21:15.000Z","mode":"live","analytics":null,
         "events":{"windowMinutes":30,"since":null,"fetchedAt":"2026-09-08T10:21:15.000Z","events":[]}}
        """, as: LiveEventsReport.self)
        XCTAssertNil(report.events?.visitors)
    }

    func testASiteWithoutAProviderHasNoFeed() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-08T10:21:15.000Z","mode":"debug","analytics":null,"events":null}
        """, as: LiveEventsReport.self)
        XCTAssertNil(report.analytics)
        XCTAssertNil(report.events)
    }

    func testMergingFoldsAPollInByIdNewestFirstAndDropsTheWindowsEdge() {
        let first = LiveEvents(
            windowMinutes: 30, since: nil,
            events: [
                event("b", at: "2026-09-08T10:20:00.000Z"),
                event("a", at: "2026-09-08T10:05:00.000Z"),
            ],
            fetchedAt: "2026-09-08T10:30:00.000Z"
        )
        let feed = LiveFeed(windowMinutes: 30).merging(first)
        XCTAssertEqual(feed.events.map(\.id), ["b", "a"])
        XCTAssertEqual(feed.newestAt, "2026-09-08T10:20:00.000Z")
        XCTAssertEqual(feed.fetchedAt, Instant.parse("2026-09-08T10:30:00.000Z"))

        // Five minutes on: one new row, "b" sent again, and "a" now older than the window.
        let second = LiveEvents(
            windowMinutes: 30, since: "2026-09-08T10:20:00.000Z",
            events: [
                event("c", at: "2026-09-08T10:35:00.000Z"),
                event("b", at: "2026-09-08T10:20:00.000Z"),
            ],
            fetchedAt: "2026-09-08T10:36:00.000Z"
        )
        let merged = feed.merging(second)
        XCTAssertEqual(merged.events.map(\.id), ["c", "b"])
        XCTAssertEqual(merged.newestAt, "2026-09-08T10:35:00.000Z")
    }

    func testMergingKeepsAtMostTheServersCap() {
        let many = (0..<(LiveFeed.limit + 20)).map { index in
            event("e\(index)", at: String(format: "2026-09-08T10:%02d:%02d.000Z", index / 60, index % 60))
        }
        let feed = LiveFeed(windowMinutes: 30).merging(
            LiveEvents(windowMinutes: 30, since: nil, events: many, fetchedAt: "2026-09-08T10:09:00.000Z")
        )
        XCTAssertEqual(feed.events.count, LiveFeed.limit)
        // The newest survive.
        XCTAssertEqual(feed.events.first?.id, "e\(LiveFeed.limit + 19)")
    }

    func testMergingFoldsHistoriesInAndForgetsThePeopleWhoseRowsAreGone() {
        let visitor = { (id: String, visits: Int) in
            VisitorHistory(visitor: id, visits: visits, firstSeen: nil, lastSeen: nil)
        }
        let first = LiveFeed(windowMinutes: 30).merging(
            LiveEvents(
                windowMinutes: 30, since: nil,
                events: [
                    event("b", at: "2026-09-08T10:20:00.000Z", visitor: "v1"),
                    event("a", at: "2026-09-08T10:05:00.000Z", visitor: "v2"),
                ],
                visitors: [visitor("v1", 7), visitor("v2", 1)],
                fetchedAt: "2026-09-08T10:30:00.000Z"
            )
        )
        XCTAssertEqual(first.visitors.count, 2)
        XCTAssertEqual(first.history(of: first.events[0])?.visits, 7)

        // Five minutes on: v1 is back for another row with a higher count, and v2's only row
        // has left the window, so nothing can ask for v2's figures again.
        let second = first.merging(
            LiveEvents(
                windowMinutes: 30, since: "2026-09-08T10:20:00.000Z",
                events: [event("c", at: "2026-09-08T10:35:00.000Z", visitor: "v1")],
                visitors: [visitor("v1", 8)],
                fetchedAt: "2026-09-08T10:36:00.000Z"
            )
        )
        XCTAssertEqual(second.visitors.keys.sorted(), ["v1"])
        XCTAssertEqual(second.history(of: second.events[0])?.visits, 8)

        // An answer that carries no histories at all leaves the ones already held.
        let third = second.merging(
            LiveEvents(
                windowMinutes: 30, since: "2026-09-08T10:35:00.000Z",
                events: [event("d", at: "2026-09-08T10:37:00.000Z", visitor: "v1")],
                fetchedAt: "2026-09-08T10:37:30.000Z"
            )
        )
        XCTAssertEqual(third.history(of: third.events[0])?.visits, 8)
    }

    func testARowSaysHowManyVisitsThePersonHasMade() {
        let seen = LiveEvent(
            id: "p", at: "2026-09-08T10:21:10.000Z", kind: .pageview, name: nil, page: "/",
            properties: [:], visitor: "v", country: nil, browser: nil, operatingSystem: nil,
            device: nil, referrer: nil
        )
        let returning = LiveFeedRow(
            siteID: "shadertown", siteName: "Shadertown", event: seen,
            history: VisitorHistory(
                visitor: "v", visits: 7, firstSeen: "2026-08-12T08:04:11.000Z", lastSeen: nil
            )
        )
        XCTAssertEqual(returning.visits, "\u{00D7}7")
        XCTAssertEqual(returning.visitsHelp?.hasPrefix("7 visits since "), true)

        // A first visit is the ordinary case and carries no mark, so an empty column never
        // says anything: it means "not a return", not "first time".
        let firstTime = LiveFeedRow(
            siteID: "shadertown", siteName: "Shadertown", event: seen,
            history: VisitorHistory(visitor: "v", visits: 1, firstSeen: nil, lastSeen: nil)
        )
        XCTAssertNil(firstTime.visits)
        XCTAssertNil(firstTime.visitsHelp)

        // The same for a provider that cannot count visitors at all.
        XCTAssertNil(LiveFeedRow(siteID: "shadertown", siteName: "Shadertown", event: seen).visits)
        XCTAssertNil(
            LiveFeedRow(
                siteID: "shadertown", siteName: "Shadertown", event: seen,
                history: VisitorHistory(visitor: "v", visits: nil, firstSeen: nil, lastSeen: nil)
            ).visits
        )
    }

    func testARowsWordsAreWorkedOutOnce() {
        let purchase = LiveEvent(
            id: "p", at: "2026-09-08T10:21:10.000Z", kind: .event, name: "purchase", page: "/pricing",
            properties: ["plan": "pro", "amount": "29"], visitor: "v",
            country: "ES", browser: "Chrome", operatingSystem: "Windows", device: "desktop", referrer: nil
        )
        let row = LiveFeedRow(siteID: "sleevy", siteName: "Sleevy", event: purchase)
        XCTAssertEqual(row.primary, "purchase")
        XCTAssertEqual(row.detail, "amount 29, plan pro")
        XCTAssertTrue(row.who.hasSuffix("· Chrome · Desktop"))
        XCTAssertTrue(row.who.contains("🇪🇸"))
        XCTAssertNotEqual(row.time, "—")

        let view = LiveEvent(
            id: "v", at: "2026-09-08T10:21:10.000Z", kind: .pageview, name: nil, page: "/shaders/julia",
            properties: [:], visitor: "v", country: nil, browser: nil, operatingSystem: nil, device: nil,
            referrer: "https://www.x.com/onnokh/status/1"
        )
        let viewRow = LiveFeedRow(siteID: "sleevy", siteName: "Sleevy", event: view)
        XCTAssertEqual(viewRow.primary, "/shaders/julia")
        XCTAssertEqual(viewRow.detail, "from x.com")
        XCTAssertEqual(viewRow.who, "")

        let outbound = LiveEvent(
            id: "o", at: "2026-09-08T10:21:10.000Z", kind: .outbound, name: nil, page: "/pricing",
            properties: ["url": "https://www.github.com/onnokh/sleevy?tab=readme"], visitor: "v",
            country: nil, browser: nil, operatingSystem: nil, device: nil, referrer: nil
        )
        let outRow = LiveFeedRow(siteID: "sleevy", siteName: "Sleevy", event: outbound)
        XCTAssertEqual(outRow.primary, "github.com/onnokh/sleevy")
        XCTAssertEqual(outRow.detail, "on /pricing")
    }

    func testRowsMergeSitesNewestFirstAndHonourTheFilters() {
        let sleevy = Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.com")
        let mounts = Site(id: "mounts", name: "Missing Mounts", origin: "https://missingmounts.com")
        let feeds: [Site.ID: LiveFeed] = [
            sleevy.id: LiveFeed(windowMinutes: 30, events: [
                event("s2", at: "2026-09-08T10:20:00.000Z", kind: .event, name: "purchase"),
                event("s1", at: "2026-09-08T10:10:00.000Z"),
            ]),
            mounts.id: LiveFeed(windowMinutes: 30, events: [
                event("m1", at: "2026-09-08T10:15:00.000Z"),
            ]),
        ]

        let all = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts])
        XCTAssertEqual(all.map(\.event.id), ["s2", "m1", "s1"])
        XCTAssertEqual(all.map(\.siteName), ["Sleevy", "Missing Mounts", "Sleevy"])
        XCTAssertEqual(all.first?.id, "sleevy|s2")

        let oneSite = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], only: [mounts.id])
        XCTAssertEqual(oneSite.map(\.event.id), ["m1"])

        let noPageviews = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], hiding: [.pageview])
        XCTAssertEqual(noPageviews.map(\.event.id), ["s2"])

        let capped = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], limit: 2)
        XCTAssertEqual(capped.count, 2)

        // Chip counts ignore the kind filter and follow the site filter.
        XCTAssertEqual(LiveFeedRow.kindCounts(feeds: feeds, sites: [sleevy, mounts]), [.pageview: 2, .event: 1])
        XCTAssertEqual(LiveFeedRow.kindCounts(feeds: feeds, sites: [sleevy, mounts], only: [sleevy.id]), [.pageview: 1, .event: 1])
    }
}

final class RelativeAgeTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testInsideAMinuteIsJustNow() {
        XCTAssertEqual(RelativeAge.label(from: now, to: now), "just now")
        XCTAssertEqual(RelativeAge.label(from: now.addingTimeInterval(-59), to: now), "just now")
    }

    func testWholeMinutesUpToAnHour() {
        XCTAssertEqual(RelativeAge.label(from: now.addingTimeInterval(-60), to: now), "1m ago")
        XCTAssertEqual(RelativeAge.label(from: now.addingTimeInterval(-149), to: now), "2m ago")
        XCTAssertEqual(RelativeAge.label(from: now.addingTimeInterval(-3599), to: now), "59m ago")
    }

    func testAnHourOrMoreHandsBackToTheClock() {
        XCTAssertNil(RelativeAge.label(from: now.addingTimeInterval(-3600), to: now))
        let shown = RelativeAge.labelOrTime(from: now.addingTimeInterval(-7200), to: now)
        XCTAssertNotEqual(shown, "just now")
        XCTAssertFalse(shown.hasSuffix("ago"))
    }
}
