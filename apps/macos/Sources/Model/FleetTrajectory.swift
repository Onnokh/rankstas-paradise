import Foundation

/// A source the Overview can draw across every project: the three that carry a run of days.
///
/// Impressions, the click-through rate and the position have runs too, but they are read
/// from the same source as the clicks and never answer a different question about a project;
/// the plan has no daily run at all. So these three are what the page's chart offers.
enum OverviewSource: String, CaseIterable, Identifiable, Sendable {
    case clicks, impressions, ctr, visits, sales

    var id: String { rawValue }

    /// The word the strip writes over the figure, which is also the name of the choice.
    var label: String {
        switch self {
        case .clicks: "Clicks"
        case .impressions: "Impressions"
        case .ctr: "Click-through rate"
        case .visits: "Visits"
        case .sales: "Sales"
        }
    }

    /// What one of the source's units is called, for the line under a project's figure.
    var unit: String {
        switch self {
        case .clicks: "clicks"
        case .impressions: "impressions"
        case .ctr: ""
        case .visits: "visits"
        case .sales: "sold"
        }
    }

    /// Whether the figure is money, and so written in a currency rather than counted.
    var isMoney: Bool { self == .sales }

    /// Whether the figure is a rate. A rate is written in percent, moves in percentage
    /// points, is never added across projects or days (see `Rate`), and is drawn on its own
    /// range rather than from zero: a rate that moves between 8 and 9 percent would be a flat
    /// line over a floor of nothing.
    var isRate: Bool { self == .ctr }
}

extension ProjectTrajectory {
    /// The period's growth for one source. Nil when the project has no such source: no
    /// analytics provider, or no commerce provider.
    func growth(_ source: OverviewSource) -> Growth? {
        switch source {
        case .clicks: clicks
        case .impressions: impressions
        case .ctr: ctr
        case .visits: visits
        case .sales: sales?.growth
        }
    }

    /// The period against the period before for one source, as two runs on one axis. Empty
    /// for a source the project has not got.
    func run(_ source: OverviewSource) -> ComparisonRun {
        switch source {
        case .clicks: clicksRun
        case .impressions: impressionsRun
        case .ctr: ctrRun
        case .visits: visitsRun
        case .sales: sales?.run ?? ComparisonRun(current: [], previous: [], previousIsAverage: false)
        }
    }
}

/// Every project's trajectory added into one: the fleet read the way a project is read.
///
/// The sums are not a second arithmetic. Each project is already cut to the period and the
/// period before, so the fleet is those cuts added — which is what makes the figure over the
/// chart and the figures on the project tiles agree by construction rather than by care.
///
/// What the adding has to be careful about is the axis. The projects' runs do not all reach
/// back equally far: a site that started counting three weeks ago has a shorter run than one
/// measured for a year. They are therefore added from their last day backwards, so every
/// project contributes to the days it measured and none is stretched over days it did not.
struct FleetTrajectory: Equatable {
    let clicks: Growth
    let clicksRun: ComparisonRun
    let impressions: Growth
    let impressionsRun: ComparisonRun
    /// The fleet's clicks over the fleet's impressions — never the mean of the projects'
    /// rates. See `Rate`.
    let ctr: Growth?
    let ctrRun: ComparisonRun
    /// Nil when no project has an analytics provider with anything to show.
    let visits: Growth?
    let visitsRun: ComparisonRun
    /// Nil when no project sells.
    let sales: Growth?
    let salesRun: ComparisonRun
    /// The currency the sales are written in: the first a selling project names. The fleet
    /// is assumed to sell in one currency, which is true of every fleet the app has seen;
    /// a second currency would need its own figure rather than a sum.
    let currency: String?

    static func make(_ projects: [ProjectTrajectory]) -> FleetTrajectory {
        let clicks = total(projects, source: .clicks) ?? Growth(current: 0, previous: nil)
        let impressions = total(projects, source: .impressions) ?? Growth(current: 0, previous: nil)
        let clicksRun = ComparisonRun.sum(projects.map { $0.run(.clicks) })
        let impressionsRun = ComparisonRun.sum(projects.map { $0.run(.impressions) })
        return FleetTrajectory(
            clicks: clicks,
            clicksRun: clicksRun,
            impressions: impressions,
            impressionsRun: impressionsRun,
            ctr: Rate.over(clicks, impressions),
            ctrRun: ComparisonRun.rate(of: clicksRun, over: impressionsRun),
            visits: total(projects, source: .visits),
            visitsRun: ComparisonRun.sum(projects.map { $0.run(.visits) }),
            sales: total(projects, source: .sales),
            salesRun: ComparisonRun.sum(projects.map { $0.run(.sales) }),
            currency: projects.compactMap { $0.sales?.currency }.first
        )
    }

    /// The fleet's growth for one source. Nil when no project has the source at all, which
    /// the page says as "no provider" rather than as a zero.
    func growth(_ source: OverviewSource) -> Growth? {
        switch source {
        case .clicks: clicks
        case .impressions: impressions
        case .ctr: ctr
        case .visits: visits
        case .sales: sales
        }
    }

    func run(_ source: OverviewSource) -> ComparisonRun {
        switch source {
        case .clicks: clicksRun
        case .impressions: impressionsRun
        case .ctr: ctrRun
        case .visits: visitsRun
        case .sales: salesRun
        }
    }

    /// Every project's period added, against every project's period before. The earlier total
    /// is nil when no project has one, so a fleet that only started counting reads as "no
    /// comparison yet" rather than as growth from nothing.
    private static func total(_ projects: [ProjectTrajectory], source: OverviewSource) -> Growth? {
        assert(!source.isRate, "A rate is derived from its two counts, never added. See `Rate`.")
        let growths = projects.compactMap { $0.growth(source) }
        guard !growths.isEmpty else { return nil }
        let earlier = growths.compactMap(\.previous)
        return Growth(
            current: growths.reduce(0) { $0 + $1.current },
            previous: earlier.isEmpty ? nil : earlier.reduce(0, +)
        )
    }
}
