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

        // The moving variants are drawn a beat after the newest event, which is where their
        // rings and fresh spikes are: a still at the exact instant shows nothing travelling.
        let beat = now.addingTimeInterval(1)
        func log<Content: View>(@ViewBuilder _ content: () -> Content) -> AnyView {
            AnyView(FeedLogCard(title: "Feed", kinds: .constant(.all), isEmpty: false, windowMinutes: 30, waiting: false, content: content))
        }
        let stills: [(String, AnyView)] = [
            // A stand-in favicon, so the still shows the slot the app fills from its store.
            ("t-hierarchy", log { FeedHierarchyVariant(rows: rows, showsSite: true, now: now, icon: { _ in Image(systemName: "seal.fill") }) }),
            ("u-one-line", log { FeedOneLineVariant(rows: rows, showsSite: true, now: now, icon: { _ in Image(systemName: "seal.fill") }) }),
            ("q-quiet", log { FeedQuietVariant(rows: rows, showsSite: true, now: now) }),
            ("r-quiet-path", log { FeedQuietPathVariant(rows: rows, showsSite: true, now: now) }),
            ("r-quiet-path-hover", log {
                let lines = FeedQuiet.lines(grouping: rows, now: now)
                VStack(spacing: 0) {
                    ForEach(Array(lines.prefix(6).enumerated()), id: \.element.id) { index, line in
                        FeedQuietRow(line: line, showsSite: true, isHovered: index == 2)
                    }
                    Color.clear.frame(height: 200)
                }
            }),
            ("s-quiet-per-site", log { FeedQuietPerSiteVariant(rows: rows, shapes: shapes, now: now) }),
            ("j-grouped", log { FeedGroupedVariant(rows: rows, showsSite: true, now: now) }),
            ("o-trail", log { FeedTrailVariant(rows: rows, showsSite: true, now: now) }),
            ("p-folded", log { FeedFoldedVariant(rows: rows, showsSite: true, now: now) }),
            ("k-temperature", log { FeedTemperatureVariant(rows: rows, showsSite: true, now: now, isLive: false) }),
            ("l-per-site", log { FeedPerSiteVariant(rows: rows, shapes: shapes, now: now) }),
            ("m-transcript", log { FeedTranscriptVariant(rows: rows, showsSite: true, now: now) }),
            ("n-head", log { FeedHeadVariant(rows: rows, shapes: shapes, showsSite: true, now: now) }),
            ("f-pulse", AnyView(FeedVariantCard(title: "Pulse", note: note, isEmpty: false) {
                VStack(alignment: .leading, spacing: 10) {
                    FeedPulseField(shapes: shapes, at: beat).frame(height: 300)
                    Text("A point is a person, newest on the outside. It dims as they go quiet, and rings when they do something.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            })),
            ("g-trace", AnyView(FeedVariantCard(title: "Trace", note: note, isEmpty: false) {
                VStack(spacing: 0) {
                    ForEach(shapes.columns) { site in
                        FeedTraceStrip(shapes: shapes, site: site, at: beat)
                            .frame(height: 74)
                            .overlay(alignment: .bottom) { Palette.line.frame(height: 1) }
                    }
                }
            })),
            ("h-now", AnyView(FeedVariantCard(title: "Now", note: note, isEmpty: false) {
                FeedNowRoom(shapes: shapes, at: beat)
            })),
            ("i-stage", AnyView(FeedVariantCard(title: "Stage", note: note, isEmpty: false) {
                // Stage cross-fades, so a still of any instant is likely to catch a fade.
                // This lands the drawing in the middle of the newest moment's slot.
                FeedStageCard(shapes: shapes, at: Self.stageMidpoint(after: beat, moments: shapes.moments.prefix(12).count))
            })),
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

    /// The instant at which `FeedStageCard` is holding its newest moment at full opacity.
    private static func stageMidpoint(after date: Date, moments: Int) -> Date {
        let hold = 3.4
        var slot = (date.timeIntervalSinceReferenceDate / hold).rounded(.up)
        let count = Double(max(moments, 1))
        slot += (count - slot.truncatingRemainder(dividingBy: count)).truncatingRemainder(dividingBy: count)
        return Date(timeIntervalSinceReferenceDate: slot * hold + hold / 2)
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
        // Three things that happened in the last seconds: what the moving variants are for.
        shaderEvents.append(view(page: "/shaders/ferro", visitor: "dk-samsung", at: now.addingTimeInterval(-2), country: "DK", browser: "Samsung Internet", device: "mobile"))
        shaderEvents.append(view(page: "/shaders/strata", visitor: "us-chrome", at: now.addingTimeInterval(-6), country: "US", browser: "Chrome", device: "desktop"))
        mountEvents.append(action(
            name: "update-character",
            page: "/eu/silvermoon/dirith",
            visitor: "gb-opera",
            at: now.addingTimeInterval(-4),
            country: "GB",
            browser: "Opera",
            device: "desktop",
            properties: ["region": "eu", "result": "saved"]
        ))
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
