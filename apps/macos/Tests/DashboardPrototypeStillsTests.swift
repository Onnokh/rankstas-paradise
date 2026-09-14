import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

// PROTOTYPE — throwaway. Not for main.
//
// Draws every dashboard variant to /tmp/dashboard-prototype so the shapes can be looked at
// without the server. The fixture is the fleet in the screenshot that started this: one site
// that carries the numbers and sells, one that barely registers, and two that started
// counting a few weeks ago.
@MainActor
final class DashboardPrototypeStillsTests: XCTestCase {
    func testEveryVariantDrawsSomething() throws {
        let projects = Self.fleet()
        XCTAssertEqual(projects.count, 4)
        XCTAssertFalse(ProtoSeries.total(projects, metric: .clicks).current.isEmpty)

        let directory = URL(fileURLWithPath: "/tmp/dashboard-prototype")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for variant in DashboardPrototype.Variant.allCases {
            let prototype = DashboardPrototype()
            prototype.variant = variant
            let body = DashboardPrototypeBody(
                prototype: prototype,
                projects: projects,
                period: .d28,
                icon: { _ in nil },
                onOpen: { _ in },
                header: AnyView(Self.header),
                footer: AnyView(Self.footer)
            )
            let image = try XCTUnwrap(Self.draw(AnyView(body), height: Self.height(variant)))
            let url = directory.appendingPathComponent("\(variant.key.lowercased())-\(variant.rawValue).png")
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("STILL \(variant.key) → \(url.path) — \(Int(image.size.width))x\(Int(image.size.height))")
            XCTAssertGreaterThan(image.size.height, 80, "\(variant.key) came out empty")
        }
    }

    /// The Sales view of the two shapes that carry a source switch, so the source a site may
    /// not have is judged too.
    func testSalesAndVisitorsViews() throws {
        let projects = Self.fleet()
        let directory = URL(fileURLWithPath: "/tmp/dashboard-prototype")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for (variant, metric) in [(DashboardPrototype.Variant.hero, ProtoMetric.sales), (.calendar, .visits)] {
            let prototype = DashboardPrototype()
            prototype.variant = variant
            prototype.metric = metric
            let body = DashboardPrototypeBody(
                prototype: prototype,
                projects: projects,
                period: .d28,
                icon: { _ in nil },
                onOpen: { _ in },
                header: AnyView(Self.header),
                footer: AnyView(Self.footer)
            )
            let image = try XCTUnwrap(Self.draw(AnyView(body), height: Self.height(variant)))
            let url = directory.appendingPathComponent("\(variant.key.lowercased())-\(metric.rawValue).png")
            let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("STILL \(variant.key)/\(metric.rawValue) → \(url.path)")
        }
    }

    // MARK: Drawing

    /// The pane as the app shows it: the panel, dark, the page in a fixed frame so the still
    /// is the page and not an empty scroll view.
    private static func draw(_ body: AnyView, height: CGFloat) -> NSImage? {
        let appearance = NSAppearance(named: .darkAqua)!
        let content = body
            .environment(\.isTabPreview, true)
            .foregroundStyle(Palette.text)
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

    private static func height(_ variant: DashboardPrototype.Variant) -> CGFloat {
        switch variant {
        case .hero: 860
        case .mosaic: 900
        case .calendar: 620
        case .league: 540
        }
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

    /// A registry whose keyword pages fall through the funnel at the given counts.
    private static func targets(planned: Int, published: Int, indexed: Int, reached: Int, clicked: Int) -> [RegistryTarget] {
        (0..<planned).map { index in
            RegistryTarget(
                targetUrl: "/page-\(index)",
                phase: index < clicked || index < reached ? RegistryPhase.live.rawValue
                    : index < published ? RegistryPhase.measuring.rawValue : RegistryPhase.new.rawValue,
                status: "active",
                window: TidyMetrics(impressions: index < reached ? 40 : 0, clicks: index < clicked ? 3 : 0, ctr: 0, position: 12),
                indexed: index < indexed ? "indexed" : (index < published ? "not-indexed" : "unknown"),
                keywords: [RegistryKeyword(keyword: "keyword \(index)", cluster: "c", intent: "info")]
            )
        }
    }

    /// Two hundred days per site, ending yesterday: a 28-day period with the 28 before it,
    /// and enough behind them for a longer period.
    static func fleet() -> [ProtoProject] {
        let calendar = Calendar(identifier: .gregorian)
        let end = ISODay.date("2026-09-13")!
        let dates = (0..<200).reversed().map { ISODay.string(calendar.date(byAdding: .day, value: -$0, to: end)!) }

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
            Shape(site: Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.app"),
                  clicks: 0.7, impressions: 6, position: 23.5, visits: 5, from: nil, growth: 1.2),
            Shape(site: Site(id: "missingmounts", name: "Missingmounts", origin: "https://www.missingmounts.com"),
                  clicks: 63, impressions: 720, position: 7.1, visits: 1050, from: nil, growth: 1.25),
            Shape(site: Site(id: "printfeest", name: "Printfeest", origin: "https://www.printfeest.nl"),
                  clicks: 0.3, impressions: 4, position: 25, visits: 5, from: 182, growth: 1),
            Shape(site: Site(id: "shadertown", name: "Shadertown", origin: "https://www.shadertown.com"),
                  clicks: 1, impressions: 10, position: 7, visits: 70, from: 150, growth: 0.9),
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
                let ramp = index < 172 ? 0.55 + 0.45 * Double(index) / 172 : shape.growth
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

        // What the ranking store would hold: Missingmounts and Shadertown sell, every site
        // has a registry, and the two young ones have a short indexing series.
        let glances = OverviewGlance.rows(overviews: overviews, series: series, period: .d28)
        return zip(overviews, glances).map { overview, glance in
            var revenue: RevenueReport?
            var registry: [RegistryTarget]?
            var coverage: [IndexCoverageDay] = []
            switch overview.id {
            case "missingmounts":
                revenue = Self.revenue(dates: dates, perDay: 4_850, orders: 3, growth: 1.28, noise: noise)
                registry = targets(planned: 11, published: 11, indexed: 11, reached: 9, clicked: 7)
                coverage = dates.suffix(40).enumerated().map { index, date in
                    IndexCoverageDay(date: date, keywordTargets: 11, indexed: min(11, 8 + index / 12), notIndexed: 0)
                }
            case "shadertown":
                revenue = Self.revenue(dates: dates, perDay: 190, orders: 1, growth: 2.4, noise: noise)
                registry = targets(planned: 27, published: 24, indexed: 22, reached: 10, clicked: 0)
                coverage = dates.suffix(30).enumerated().map { index, date in
                    IndexCoverageDay(date: date, keywordTargets: 27, indexed: 18 + index / 8, notIndexed: 3)
                }
            case "sleevy":
                registry = targets(planned: 19, published: 19, indexed: 17, reached: 6, clicked: 0)
                coverage = dates.suffix(36).enumerated().map { index, date in
                    IndexCoverageDay(date: date, keywordTargets: 19, indexed: 15 + index / 18, notIndexed: 2)
                }
            default:
                registry = targets(planned: 23, published: 20, indexed: 19, reached: 4, clicked: 0)
                coverage = dates.suffix(20).enumerated().map { index, date in
                    IndexCoverageDay(date: date, keywordTargets: 23, indexed: 17 + index / 10, notIndexed: 3)
                }
            }
            return ProtoProject(
                trajectory: ProjectTrajectory.make(
                    overview: overview,
                    series: series[overview.id],
                    revenue: revenue,
                    targets: registry,
                    coverage: coverage,
                    period: .d28
                ),
                glance: glance
            )
        }
    }

    /// A 28-day revenue report in euro cents, with the period before as one total.
    private static func revenue(dates: [String], perDay: Double, orders: Double, growth: Double, noise: () -> Double) -> RevenueReport {
        let days = dates.suffix(28).map { date -> RevenueDay in
            let count = (orders * (0.4 + noise() * 1.6)).rounded()
            return RevenueDay(date: date, orders: count, revenue: count * perDay, net: count * perDay * 0.86, currency: "EUR")
        }
        let current = RevenueTotals(
            orders: days.reduce(0) { $0 + $1.orders },
            revenue: days.reduce(0) { $0 + $1.revenue },
            net: days.reduce(0) { $0 + $1.net }
        )
        let previous = RevenueTotals(orders: current.orders / growth, revenue: current.revenue / growth, net: current.net / growth)
        return RevenueReport(
            generatedAt: "2026-09-14T09:00:00Z",
            revenue: RevenueStatus(provider: "polar", accountId: nil, ready: true, reason: nil),
            windowDays: 28,
            currency: "EUR",
            days: days,
            current: current,
            previous: previous,
            delta: RevenueTotals(
                orders: current.orders - previous.orders,
                revenue: current.revenue - previous.revenue,
                net: current.net - previous.net
            )
        )
    }
}
