import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

// PROTOTYPE — throwaway. Not for main.
//
// Draws every feed variant to /tmp/feed-prototype so the shapes can be looked at without the
// server running and without waiting for a busy half hour. The fixture is the half hour in
// the screenshot that started this: one visitor reloading shader pages, two product actions,
// and a scatter of arrivals.
@MainActor
final class FeedPrototypeStillsTests: XCTestCase {
    /// The Feed card's own width on the Overview: the reading column, less its inset.
    private static let cardWidth: CGFloat = SiteTabScreen.columnWidth - SiteTabScreen.columnInset * 2

    func testEveryVariantDrawsSomething() throws {
        let now = Date()
        let world = Self.world(now: now)
        let shapes = FeedShapes.make(feeds: world.feeds, sites: world.sites, now: now)

        XCTAssertFalse(shapes.visits.isEmpty, "the fixture has visitors")
        XCTAssertFalse(shapes.columns.isEmpty, "the fixture has pages")
        XCTAssertFalse(shapes.transitions.isEmpty, "the fixture has walks")
        XCTAssertFalse(shapes.signals.isEmpty, "the fixture has actions")

        let rows = LiveFeedRow.rows(feeds: world.feeds, sites: world.sites, limit: 50)
        let note = "\(shapes.visits.count) people · \(shapes.eventCount) events · last \(shapes.windowMinutes)m"

        let stills: [(String, AnyView)] = [
            ("current", AnyView(FeedCard(rows: rows, showsSite: true, kinds: .constant(.all), windowMinutes: 30, waiting: false, now: now))),
            ("a-visits", AnyView(FeedVariantCard(title: "Visits", note: note, isEmpty: false) {
                FeedVisitsVariant(shapes: shapes, showsSite: true)
            })),
            ("b-lanes", AnyView(FeedVariantCard(title: "Lanes", note: note, isEmpty: false) {
                FeedLanesVariant(shapes: shapes, showsSite: true)
            })),
            ("c-pressure", AnyView(FeedVariantCard(title: "Pressure", note: note, isEmpty: false) {
                FeedPressureVariant(shapes: shapes)
            })),
            ("d-paths", AnyView(FeedVariantCard(title: "Paths", note: note, isEmpty: false) {
                FeedPathsVariant(shapes: shapes)
            })),
            ("e-signals", AnyView(FeedVariantCard(title: "Signals", note: note, isEmpty: false) {
                FeedSignalsVariant(shapes: shapes, showsSite: true)
            })),
        ]

        let directory = URL(fileURLWithPath: "/tmp/feed-prototype")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for (name, card) in stills {
            let image = try XCTUnwrap(Self.draw(card))
            let url = directory.appendingPathComponent("\(name).png")
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("STILL \(name) → \(url.path) — \(Int(image.size.width))x\(Int(image.size.height))")
            XCTAssertGreaterThan(image.size.height, 80, "\(name) came out empty")
        }
    }

    /// Renders a card the way the app would: dark, on the panel, at the column's width.
    private static func draw(_ card: AnyView) -> NSImage? {
        let appearance = NSAppearance(named: .darkAqua)!
        let content = card
            .frame(width: cardWidth)
            .padding(SiteTabScreen.columnInset)
            .background(Palette.void)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        var image: NSImage?
        appearance.performAsCurrentDrawingAppearance {
            image = renderer.nsImage
        }
        return image
    }

    // MARK: The fixture

    private struct World {
        let sites: [Site]
        let feeds: [Site.ID: LiveFeed]
    }

    private static func world(now: Date) -> World {
        let shadertown = Site(id: "shadertown", name: "Shadertown", origin: "https://shadertown.com")
        let mounts = Site(id: "missingmounts", name: "Missingmounts", origin: "https://missingmounts.com")
        let sleevy = Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.com")

        var shaderEvents: [LiveEvent] = []
        var mountEvents: [LiveEvent] = []
        var sleevyEvents: [LiveEvent] = []

        // The reloader: one person, twenty rows of the shipped log.
        var minute = 9.0
        for page in ["/", "/shaders", "/shaders/strata", "/shaders/strata", "/shaders/strata", "/shaders/strata", "/shaders", "/shaders/ferro", "/shaders/ferro", "/shaders/ferro", "/shaders/ferro", "/shaders/duotone", "/shaders/duotone", "/shaders/duotone"] {
            shaderEvents.append(view(page: page, visitor: "us-chrome", at: now.addingTimeInterval(-minute * 60), country: "US", browser: "Chrome", device: "desktop"))
            minute -= 0.6
        }
        shaderEvents.append(view(page: "/", visitor: "dk-samsung", at: now.addingTimeInterval(-70), country: "DK", browser: "Samsung Internet", device: "mobile"))
        shaderEvents.append(view(page: "/shaders", visitor: "dk-samsung", at: now.addingTimeInterval(-40), country: "DK", browser: "Samsung Internet", device: "mobile"))
        for (index, country) in ["FR", "JP", "BR", "SE", "ES", "IN"].enumerated() {
            let at = now.addingTimeInterval(-Double(index + 1) * 220)
            shaderEvents.append(view(page: "/shaders", visitor: "guest-\(country)", at: at, country: country, browser: "Safari", device: index.isMultiple(of: 2) ? "mobile" : "desktop"))
            shaderEvents.append(view(page: "/shaders/duotone", visitor: "guest-\(country)", at: at.addingTimeInterval(35), country: country, browser: "Safari", device: index.isMultiple(of: 2) ? "mobile" : "desktop"))
        }

        // The product: page loads, and the two actions that matter.
        mountEvents.append(view(page: "/eu/silvermoon/dirith", visitor: "de-chrome", at: now.addingTimeInterval(-300), country: "DE", browser: "Chrome", device: "desktop"))
        mountEvents.append(action(
            name: "update-character",
            page: "/eu/silvermoon/dirith",
            visitor: "de-chrome",
            at: now.addingTimeInterval(-140),
            country: "DE",
            browser: "Chrome",
            device: "desktop",
            properties: ["region": "eu", "result": "queued"]
        ))
        mountEvents.append(view(page: "/eu/silvermoon", visitor: "de-chrome", at: now.addingTimeInterval(-60), country: "DE", browser: "Chrome", device: "desktop"))
        mountEvents.append(view(page: "/", visitor: "us-firefox", at: now.addingTimeInterval(-420), country: "US", browser: "Firefox", device: "desktop"))
        mountEvents.append(action(
            name: "toggle-complete-daily",
            page: "/eu/silvermoon/dirith",
            visitor: "us-firefox",
            at: now.addingTimeInterval(-360),
            country: "US",
            browser: "Firefox",
            device: "desktop",
            properties: ["frequency": "weekly"]
        ))
        mountEvents.append(view(page: "/eu/silvermoon/dirith", visitor: "gb-opera", at: now.addingTimeInterval(-90), country: "GB", browser: "Opera", device: "desktop"))
        mountEvents.append(view(page: "/", visitor: "gb-opera", at: now.addingTimeInterval(-700), country: "GB", browser: "Opera", device: "desktop"))

        sleevyEvents.append(view(page: "/", visitor: "nl-safari", at: now.addingTimeInterval(-500), country: "NL", browser: "Safari", device: "mobile"))
        sleevyEvents.append(view(page: "/sleeves", visitor: "nl-safari", at: now.addingTimeInterval(-460), country: "NL", browser: "Safari", device: "mobile"))
        sleevyEvents.append(action(
            name: "add-to-cart",
            page: "/sleeves/a5",
            visitor: "nl-safari",
            at: now.addingTimeInterval(-400),
            country: "NL",
            browser: "Safari",
            device: "mobile",
            properties: ["size": "a5", "quantity": "2"]
        ))

        let histories: [String: Int] = ["us-chrome": 2, "de-chrome": 7, "us-firefox": 2, "gb-opera": 3, "nl-safari": 4]
        func feed(_ events: [LiveEvent]) -> LiveFeed {
            LiveFeed(
                windowMinutes: 30,
                events: events.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) },
                visitors: Dictionary(
                    uniqueKeysWithValues: Set(events.map(\.visitor)).map { visitor in
                        (visitor, VisitorHistory(
                            visitor: visitor,
                            visits: histories[visitor] ?? 1,
                            firstSeen: "2026-08-12T09:00:00Z",
                            lastSeen: nil
                        ))
                    }
                ),
                fetchedAt: now
            )
        }

        return World(
            sites: [shadertown, mounts, sleevy],
            feeds: [
                shadertown.id: feed(shaderEvents),
                mounts.id: feed(mountEvents),
                sleevy.id: feed(sleevyEvents),
            ]
        )
    }

    private static func view(page: String, visitor: String, at: Date, country: String, browser: String, device: String) -> LiveEvent {
        LiveEvent(
            id: "\(visitor)-\(page)-\(at.timeIntervalSince1970)",
            at: at.formatted(.iso8601),
            kind: .pageview,
            name: nil,
            page: page,
            properties: [:],
            visitor: visitor,
            country: country,
            browser: browser,
            operatingSystem: "macOS",
            device: device,
            referrer: "https://www.google.com/"
        )
    }

    private static func action(
        name: String,
        page: String,
        visitor: String,
        at: Date,
        country: String,
        browser: String,
        device: String,
        properties: [String: String]
    ) -> LiveEvent {
        LiveEvent(
            id: "\(visitor)-\(name)-\(at.timeIntervalSince1970)",
            at: at.formatted(.iso8601),
            kind: .event,
            name: name,
            page: page,
            properties: properties,
            visitor: visitor,
            country: country,
            browser: browser,
            operatingSystem: "macOS",
            device: device,
            referrer: nil
        )
    }
}
