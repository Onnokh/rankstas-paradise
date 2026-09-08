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
        name: String? = nil
    ) -> LiveEvent {
        LiveEvent(
            id: id, at: at, kind: kind, name: name, page: page, properties: [:], visitor: "v",
            country: nil, browser: nil, operatingSystem: nil, device: nil, referrer: nil
        )
    }

    func testLiveEventsReportDecodesTheServersShape() throws {
        let report = try decode("""
        {"generatedAt":"2026-09-08T10:21:15.000Z","mode":"live",
         "analytics":{"provider":"rybbit","siteId":"12","ready":true,"reason":null},
         "events":{"windowMinutes":30,"since":null,"fetchedAt":"2026-09-08T10:21:15.000Z","events":[
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
            properties: ["url": "https://github.com/onnokh/sleevy?tab=readme"], visitor: "v",
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

        let oneSite = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], only: mounts.id)
        XCTAssertEqual(oneSite.map(\.event.id), ["m1"])

        let noPageviews = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], hiding: [.pageview])
        XCTAssertEqual(noPageviews.map(\.event.id), ["s2"])

        let capped = LiveFeedRow.rows(feeds: feeds, sites: [sleevy, mounts], limit: 2)
        XCTAssertEqual(capped.count, 2)

        // Chip counts ignore the kind filter and follow the site filter.
        XCTAssertEqual(LiveFeedRow.kindCounts(feeds: feeds, sites: [sleevy, mounts]), [.pageview: 2, .event: 1])
        XCTAssertEqual(LiveFeedRow.kindCounts(feeds: feeds, sites: [sleevy, mounts], only: sleevy.id), [.pageview: 1, .event: 1])
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
