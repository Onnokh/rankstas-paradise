#if DEBUG
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: the Overview ships as a stack of one identical card per project — name zone,
// then Search, Visitors and Plan, each a percentage over a small chart. Onno brought two
// dashboards to look at: a light commerce one (a hero chart with a highlighted column, a
// gauge, an hourly heat grid, a top-products table) and a dark admin one (small figure
// tiles with bar sparks, one large block chart, a transactions table). What both have and
// the shipped page has not is *composition*: tiles of different size and different kind,
// with one of them plainly first.
//
// So: what does the Overview look like when it is a dashboard — a composition with a lead —
// rather than four copies of one row? Four shapes, each disagreeing about what comes first:
//
//   H — Hero: the fleet's own chart is the page's lead, large, the period over the period
//       before; the four projects sit under it as small tiles. Fleet first, sites second.
//   M — Mosaic: the page is cut by *source*, not by site — Search, Visitors, Sales, Plan,
//       one tile each, and inside a tile the four sites are ranked against one another with
//       a share bar. The only shape that answers "which site carries this". Full pane width,
//       so it also tests leaving the 880pt reading column.
//   C — Calendar: no lines at all. One band per site, one cell per day of the period, tinted
//       by how strong that day was for the site. Answers *when* — weekday rhythm, the day a
//       site started counting, the week nothing happened.
//   L — League: the densest and quietest — one table, one row per site, fixed columns,
//       figures right-aligned and monospaced, the fleet as a foot row. The reference's
//       transactions table, read as a scoreboard.
//
// Every variant reads `ProtoProject` — the shipped `ProjectTrajectory` beside the strip's
// `SiteGlance`, which is what carries impressions and position. Nothing here fetches, and
// nothing here is meant to survive: the winner gets rewritten into `OverviewScreen`.

// MARK: - Variant

/// Which shape the Overview is drawn in. Held once, in the environment; remembered across
/// launches so a variant can be judged after a restart.
@MainActor
@Observable
final class DashboardPrototype {
    enum Variant: String, CaseIterable, Identifiable {
        // Declaration order is the order the floating bar cycles through.
        case hero, mosaic, calendar, league

        var id: String { rawValue }

        var key: String {
            switch self {
            case .hero: "H"
            case .mosaic: "M"
            case .calendar: "C"
            case .league: "L"
            }
        }

        var name: String {
            switch self {
            case .hero: "Hero — the fleet's chart leads, the projects are tiles under it"
            case .mosaic: "Mosaic — one tile per source, the sites ranked inside it"
            case .calendar: "Calendar — one cell per day per site, tinted by the day"
            case .league: "League — one table, fixed columns, the fleet as a foot row"
            }
        }
    }

    private static let defaultsKey = "prototype.dashboard.variant"

    var variant: Variant {
        didSet { UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey) }
    }

    /// Which source the shapes that show one at a time are showing. The Calendar's switch;
    /// the Hero's too, so the same choice is kept when the bar cycles.
    var metric: ProtoMetric = .clicks

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .hero
    }

    func cycle(_ step: Int) {
        let all = Variant.allCases
        let index = all.firstIndex(of: variant) ?? 0
        let count = all.count
        variant = all[((index + step) % count + count) % count]
    }
}

// MARK: - Switcher

/// The floating bar: obviously not part of the design being judged. Shown while the Overview
/// is the tab in front, since that is the only tab it changes.
struct DashboardPrototypeSwitcher: View {
    let prototype: DashboardPrototype
    let isVisible: Bool

    var body: some View {
        if isVisible {
            HStack(spacing: 12) {
                Text("PROTOTYPE")
                    .font(.caption2.weight(.heavy))
                    .tracking(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.black, in: .rect(cornerRadius: 3))
                    .foregroundStyle(.yellow)

                Button { prototype.cycle(-1) } label: {
                    Image(systemName: "chevron.left")
                }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])

                Text("\(prototype.variant.key) — \(prototype.variant.name)")
                    .font(.callout.weight(.semibold))
                    .frame(minWidth: 380)

                Button { prototype.cycle(1) } label: {
                    Image(systemName: "chevron.right")
                }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])

                Text("⌘⌥← ⌘⌥→")
                    .font(.caption)
                    .opacity(0.6)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: .capsule)
            .overlay(Capsule().strokeBorder(.separator))
            .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
            .fixedSize()
        }
    }
}

// MARK: - What a variant reads

/// One project as the prototype draws it: the shipped trajectory — the growths, the runs,
/// the sales and the plan — beside the glance the strip is built from, which is what carries
/// impressions, the click-through rate and the position.
struct ProtoProject: Identifiable {
    let trajectory: ProjectTrajectory
    let glance: SiteGlance

    var id: Site.ID { trajectory.id }
    var site: Site { trajectory.site }

    /// The run for a source, or an empty one for a source the site has not got.
    func run(_ metric: ProtoMetric) -> ComparisonRun {
        switch metric {
        case .clicks: trajectory.clicksRun
        case .visits: trajectory.visitsRun
        case .sales: trajectory.sales?.run ?? ComparisonRun(current: [], previous: [], previousIsAverage: false)
        }
    }

    /// The period's growth for a source. Nil when the site has no such source.
    func growth(_ metric: ProtoMetric) -> Growth? {
        switch metric {
        case .clicks: trajectory.clicks
        case .visits: trajectory.visits
        case .sales: trajectory.sales?.growth
        }
    }

    /// The period's figure, written the way the source writes it.
    func figure(_ metric: ProtoMetric) -> String {
        guard let growth = growth(metric) else { return "—" }
        switch metric {
        case .clicks, .visits: return GlanceFigure.count(growth.current)
        case .sales: return Money.format(growth.current, currency: trajectory.sales?.currency)
        }
    }
}

/// A source a variant can draw, with the one colour that source has everywhere in the app.
enum ProtoMetric: String, CaseIterable, Identifiable {
    case clicks, visits, sales

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clicks: "Search"
        case .visits: "Visitors"
        case .sales: "Sales"
        }
    }

    var unit: String {
        switch self {
        case .clicks: "clicks"
        case .visits: "visits"
        case .sales: "sold"
        }
    }

    var color: Color {
        switch self {
        case .clicks: Palette.blue
        case .visits: visitsColor
        case .sales: Palette.mint
        }
    }
}

/// The arithmetic the variants share: sums over the fleet. Kept out of the views so a shape
/// can be judged on its shape and not on whether its numbers add up.
enum ProtoSeries {
    /// One project per site, in the server's order, from what the stores hold.
    @MainActor
    static func projects(
        overviews: [SiteOverview],
        series: [Site.ID: [HistoryReportDay]],
        rankings: RankingStore?,
        period: Period
    ) -> [ProtoProject] {
        let glances = OverviewGlance.rows(overviews: overviews, series: series, period: period)
        return zip(overviews, glances).map { overview, glance in
            let key = RankingStore.KeywordsKey(siteID: overview.id, period: period)
            return ProtoProject(
                trajectory: ProjectTrajectory.make(
                    overview: overview,
                    series: series[overview.id],
                    revenue: rankings?.revenue[key],
                    targets: rankings?.registry[overview.id],
                    coverage: rankings?.coverage[overview.id] ?? [],
                    period: period
                ),
                glance: glance
            )
        }
    }

    /// Every site's run for a source laid on one axis and added, point for point from the
    /// last day back, so a site whose series is shorter simply stops contributing. The
    /// earlier run is added the same way and reads as measured only when every site's did.
    static func total(_ projects: [ProtoProject], metric: ProtoMetric) -> ComparisonRun {
        let runs = projects.map { $0.run(metric) }.filter { !$0.current.isEmpty }
        guard let longest = runs.max(by: { $0.current.count < $1.current.count }) else {
            return ComparisonRun(current: [], previous: [], previousIsAverage: false)
        }
        let count = longest.current.count
        var now: [ComparisonRun.Point] = []
        for index in 0..<count {
            var value = 0.0
            var measured = 0.0
            for run in runs {
                let offset = run.current.count - count + index
                guard offset >= 0 else { continue }
                value += run.current[offset].value
                measured += run.current[offset].measured
            }
            now.append(ComparisonRun.Point(date: longest.current[index].date, value: value, measured: measured))
        }
        var was: [Double] = []
        var wasMeasured: [Double] = []
        for index in 0..<count {
            var value = 0.0
            var measured = 0.0
            for run in runs {
                let offset = run.previous.count - count + index
                guard offset >= 0 else { continue }
                value += run.previous[offset]
                measured += run.previousMeasured[offset]
            }
            was.append(value)
            wasMeasured.append(measured)
        }
        return ComparisonRun(
            current: now,
            previous: was.contains(where: { $0 > 0 }) ? was : [],
            previousMeasured: wasMeasured,
            previousIsAverage: runs.contains { $0.previousIsAverage }
        )
    }

    /// The fleet's growth for a source: every site's period added, against every site's
    /// period before. Nil when no site has the source at all.
    static func growth(_ projects: [ProtoProject], metric: ProtoMetric) -> Growth? {
        let growths = projects.compactMap { $0.growth(metric) }
        guard !growths.isEmpty else { return nil }
        let earlier = growths.compactMap(\.previous)
        return Growth(
            current: growths.reduce(0) { $0 + $1.current },
            previous: earlier.isEmpty ? nil : earlier.reduce(0, +)
        )
    }

    /// The currency the fleet's sales are written in: the first one a selling site names.
    static func currency(_ projects: [ProtoProject]) -> String? {
        projects.compactMap { $0.trajectory.sales?.currency }.first
    }

    /// A site's share of the fleet's total for a source, 0…1. Zero when the fleet has none.
    static func share(_ project: ProtoProject, of projects: [ProtoProject], metric: ProtoMetric) -> Double {
        let total = projects.compactMap { $0.growth(metric)?.current }.reduce(0, +)
        guard total > 0, let mine = project.growth(metric)?.current else { return 0 }
        return mine / total
    }
}

// MARK: - Body

/// Draws the Overview in the chosen variant, under the page's own header and over its own
/// footer. Each variant owns everything between the two: no shared strip, no shared column,
/// because what comes first is the thing being judged.
struct DashboardPrototypeBody: View {
    let prototype: DashboardPrototype
    let projects: [ProtoProject]
    let period: Period
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void
    let header: AnyView
    let footer: AnyView

    var body: some View {
        @Bindable var prototype = prototype
        VStack(alignment: .leading, spacing: 0) {
            header
                .column()
                .padding(.top, SiteTabScreen.columnInset)
                .padding(.bottom, 28)

            switch prototype.variant {
            case .hero:
                HeroVariant(projects: projects, period: period, metric: $prototype.metric, icon: icon, onOpen: onOpen)
            case .mosaic:
                MosaicVariant(projects: projects, period: period, icon: icon, onOpen: onOpen)
            case .calendar:
                CalendarVariant(projects: projects, period: period, metric: $prototype.metric, icon: icon, onOpen: onOpen)
            case .league:
                LeagueVariant(projects: projects, period: period, icon: icon, onOpen: onOpen)
            }

            footer
                .column()
                .padding(.top, 24)
                .padding(.bottom, SiteTabScreen.columnInset)
        }
        .readingColumn()
    }
}
#endif
