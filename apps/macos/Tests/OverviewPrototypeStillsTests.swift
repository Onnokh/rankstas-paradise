import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

// PROTOTYPE — throwaway. Not for main.
//
// Draws every Overview variant to /tmp/overview-prototype so the shapes can be looked at
// without the server. The fixture is the fleet in the screenshot that started this: one site
// that carries the numbers, one that barely registers, and two that started counting a few
// weeks ago.
@MainActor
final class OverviewPrototypeStillsTests: XCTestCase {
    func testEveryVariantDrawsSomething() throws {
        let sites = Self.fleet()
        XCTAssertEqual(sites.count, 4)
        XCTAssertFalse(OverviewSeries.total(sites).isEmpty)

        let directory = URL(fileURLWithPath: "/tmp/overview-prototype")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for variant in OverviewPrototype.Variant.allCases {
            let body = OverviewPrototypeBody(
                variant: variant,
                sites: sites,
                icon: { _ in Image(systemName: "seal.fill") },
                onOpen: { _ in },
                header: AnyView(Self.header),
                footer: AnyView(Self.footer)
            )
            let image = try XCTUnwrap(Self.draw(AnyView(body), height: variant == .cards ? 1500 : 1700))
            let url = directory.appendingPathComponent("\(variant.key.lowercased())-\(variant.rawValue).png")
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("STILL \(variant.key) → \(url.path) — \(Int(image.size.width))x\(Int(image.size.height))")
            XCTAssertGreaterThan(image.size.height, 80, "\(variant.key) came out empty")
        }
    }

    // MARK: Drawing

    /// The pane as the app shows it: the panel, dark, the reading column in a fixed frame so
    /// the still is the page and not an empty scroll view.
    private static func draw(_ body: AnyView, height: CGFloat) -> NSImage? {
        let appearance = NSAppearance(named: .darkAqua)!
        let content = body
            .environment(\.isTabPreview, true)
            .frame(width: 1180, height: height, alignment: .top)
            .background(Palette.panel)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        var image: NSImage?
        appearance.performAsCurrentDrawingAppearance {
            image = renderer.nsImage
        }
        return image
    }

    private static var header: some View {
        HStack(spacing: 10) {
            Image(systemName: ScreenRail.overviewSymbol)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
            Text("Overview")
                .font(.title3.weight(.semibold))
            Spacer()
            WordSwitch(options: OverviewTabState.periods, selection: .constant(.d28), label: \.label)
            Image(systemName: "arrow.clockwise")
                .foregroundStyle(.secondary)
        }
    }

    private static var footer: some View {
        HStack {
            Spacer()
            Text("4 of 4 sites loaded")
            Text("Updated 13m ago")
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    // MARK: The fixture

    /// Fifty-six days per site, ending yesterday, so a 28-day period has the 28 before it.
    private static func fleet() -> [PrototypeSiteSeries] {
        let calendar = Calendar(identifier: .gregorian)
        let end = ISODay.date("2026-09-12")!
        let dates = (0..<56).reversed().map { ISODay.string(calendar.date(byAdding: .day, value: -$0, to: end)!) }

        struct Shape {
            let site: Site
            let clicks: Double
            let impressions: Double
            let position: Double
            let visits: Double?
            /// The day counting started, as an index into the run; nil for the whole run.
            let from: Int?
            /// How the second half stands against the first: 1 is flat.
            let growth: Double
        }
        let shapes = [
            Shape(site: Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.com"),
                  clicks: 0.7, impressions: 6, position: 23.5, visits: 5, from: nil, growth: 1.2),
            Shape(site: Site(id: "missingmounts", name: "Missingmounts", origin: "https://missingmounts.com"),
                  clicks: 63, impressions: 720, position: 7.1, visits: 1050, from: nil, growth: 1.4),
            Shape(site: Site(id: "printfeest", name: "Printfeest", origin: "https://printfeest.nl"),
                  clicks: 0.3, impressions: 4, position: 25, visits: 5, from: 38, growth: 1),
            Shape(site: Site(id: "shadertown", name: "Shadertown", origin: "https://shadertown.dev"),
                  clicks: 1, impressions: 10, position: 7, visits: 70, from: 34, growth: 1),
        ]

        var seed: UInt64 = 7
        func noise() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double((seed >> 33) % 1000) / 1000
        }

        var overviews: [SiteOverview] = []
        var series: [Site.ID: [HistoryReportDay]] = [:]
        for shape in shapes {
            var days: [HistoryReportDay] = []
            for (index, date) in dates.enumerated() {
                let counting = shape.from.map { index >= $0 } ?? true
                let weekday = calendar.component(.weekday, from: ISODay.date(date)!)
                let weekend = weekday == 1 || weekday == 7 ? 0.7 : 1
                let ramp = index < 28 ? 1 : shape.growth
                let wobble = 0.7 + noise() * 0.6
                let impressions = counting ? (shape.impressions * weekend * ramp * wobble).rounded() : 0
                let clicks = counting ? min((shape.clicks * weekend * ramp * (0.5 + noise())).rounded(), impressions) : 0
                let visits: VisitsDay? = counting && shape.visits != nil
                    ? VisitsDay(
                        pageviews: (shape.visits! * 1.8 * weekend * ramp * wobble).rounded(),
                        visits: (shape.visits! * weekend * ramp * wobble).rounded(),
                        visitors: (shape.visits! * 0.8 * weekend * ramp * wobble).rounded()
                    )
                    : nil
                days.append(HistoryReportDay(
                    date: date,
                    provisional: index >= dates.count - 2,
                    impressions: impressions,
                    clicks: clicks,
                    ctr: impressions > 0 ? clicks / impressions : 0,
                    position: counting ? shape.position + (noise() - 0.5) * 2 : 0,
                    visits: visits
                ))
            }
            series[shape.site.id] = days
            overviews.append(SiteOverview(site: shape.site, dashboard: nil, errorMessage: nil))
        }
        return OverviewSeries.sites(overviews: overviews, series: series, period: .d28)
    }
}
