import XCTest
@testable import RankstasParadise

final class FeedArrivalsTests: XCTestCase {
    private let now = Instant.parse("2026-09-13T10:00:00.000Z")!

    /// A row of one visitor's events on one site, from ids and instants, oldest first.
    private func row(_ visitor: String, _ events: [(id: String, at: String)], site: Site.ID = "shadertown") -> LiveFeedRow {
        LiveFeedRow(
            siteID: site,
            siteName: site.capitalized,
            events: events.map {
                LiveEvent(
                    id: $0.id, at: $0.at, kind: .pageview, name: nil, page: "/\($0.id)", properties: [:],
                    visitor: visitor, country: nil, browser: nil, operatingSystem: nil, device: nil, referrer: nil
                )
            }
        )
    }

    func testTheFirstFillArrivesQuietly() {
        var arrivals = FeedArrivals()
        arrivals.note([row("a", [("a1", "2026-09-13T09:59:58.000Z")])], kinds: .all, at: now)
        XCTAssertTrue(arrivals.fresh.isEmpty, "the rows were there before this client looked")
    }

    func testANewVisitorArrivesAndThenSettles() {
        let old = row("a", [("a1", "2026-09-13T09:50:00.000Z")])
        let new = row("b", [("b1", "2026-09-13T09:59:58.000Z")])
        var arrivals = FeedArrivals()
        arrivals.note([old], kinds: .all, at: now)

        arrivals.note([new, old], kinds: .all, at: now)
        XCTAssertEqual(arrivals.fresh, [new.id])

        arrivals.settle()
        XCTAssertTrue(arrivals.fresh.isEmpty)

        // The same rows again, a poll later: nothing new to say.
        arrivals.note([new, old], kinds: .all, at: now.addingTimeInterval(5))
        XCTAssertTrue(arrivals.fresh.isEmpty)
    }

    func testAKnownVisitorsNewStepArrives() {
        // The row keeps its id — the run's oldest event names it — but says something new.
        let before = row("a", [("a1", "2026-09-13T09:55:00.000Z")])
        let after = row("a", [("a1", "2026-09-13T09:55:00.000Z"), ("a2", "2026-09-13T09:59:58.000Z")])
        XCTAssertEqual(before.id, after.id)
        var arrivals = FeedArrivals()
        arrivals.note([before], kinds: .all, at: now)

        arrivals.note([after], kinds: .all, at: now)
        XCTAssertEqual(arrivals.fresh, [after.id])
    }

    func testARunThatOnlyLostItsOldestEventDoesNotArrive() {
        let whole = row("a", [("a1", "2026-09-13T09:30:00.000Z"), ("a2", "2026-09-13T09:59:58.000Z")])
        let cut = row("a", [("a2", "2026-09-13T09:59:58.000Z")])
        XCTAssertNotEqual(whole.id, cut.id)
        var arrivals = FeedArrivals()
        arrivals.note([whole], kinds: .all, at: now)

        arrivals.note([cut], kinds: .all, at: now)
        XCTAssertTrue(arrivals.fresh.isEmpty, "a new id with nothing new to say is not an arrival")
    }

    func testASecondRunOfTheSameVisitorArrivesOnItsOwn() {
        let earlier = row("a", [("a1", "2026-09-13T09:30:00.000Z")])
        let later = row("a", [("a2", "2026-09-13T09:59:58.000Z")])
        var arrivals = FeedArrivals()
        arrivals.note([earlier], kinds: .all, at: now)

        arrivals.note([later, earlier], kinds: .all, at: now)
        XCTAssertEqual(arrivals.fresh, [later.id], "the run that is new arrives; the old one stays put")
    }

    func testAChangeOfKindsUncoversRowsQuietly() {
        let seen = row("a", [("a1", "2026-09-13T09:59:50.000Z")])
        let uncovered = row("b", [("b1", "2026-09-13T09:59:58.000Z")])
        var arrivals = FeedArrivals()
        arrivals.note([seen], kinds: .events, at: now)

        arrivals.note([uncovered, seen], kinds: .all, at: now)
        XCTAssertTrue(arrivals.fresh.isEmpty, "the rows were there; the filter hid them")

        // The kinds kept, the next new row arrives as usual.
        let new = row("c", [("c1", "2026-09-13T10:00:03.000Z")])
        arrivals.note([new, uncovered, seen], kinds: .all, at: now.addingTimeInterval(5))
        XCTAssertEqual(arrivals.fresh, [new.id])
    }

    func testARowFromLongAgoDoesNotArrive() {
        // A site that answered its first poll late: its rows are unseen, but not new.
        let stale = row("a", [("a1", "2026-09-13T09:55:00.000Z")], site: "sleevy")
        let seen = row("b", [("b1", "2026-09-13T09:59:00.000Z")])
        var arrivals = FeedArrivals()
        arrivals.note([seen], kinds: .all, at: now)

        arrivals.note([seen, stale], kinds: .all, at: now)
        XCTAssertTrue(arrivals.fresh.isEmpty)
    }

    func testAPollWithNothingNewClearsWhatWasFresh() {
        let old = row("a", [("a1", "2026-09-13T09:50:00.000Z")])
        let new = row("b", [("b1", "2026-09-13T09:59:58.000Z")])
        var arrivals = FeedArrivals()
        arrivals.note([old], kinds: .all, at: now)
        arrivals.note([new, old], kinds: .all, at: now)
        XCTAssertFalse(arrivals.fresh.isEmpty)

        arrivals.note([new, old], kinds: .all, at: now.addingTimeInterval(5))
        XCTAssertTrue(arrivals.fresh.isEmpty, "a row is fresh for one note, not until somebody looks")
    }
}
