import Foundation

/// How one project does over the period: for each of its sources — Search Console, the
/// analytics provider, the commerce provider, the plan — the period against the period
/// before, as a ratio and as two runs of days laid on one axis. Built from what the
/// stores hold; nothing here fetches.
///
/// A ratio is what makes a site with 26 clicks comparable to one with 2,400, and two runs
/// on one axis are what let the eye see the growth the ratio names. Bands for the words
/// ("Growing", "Slipping") belong to the screen, not here: see `GrowthReading`.
struct ProjectTrajectory: Identifiable, Equatable {
    let site: Site
    /// Why the site's dashboard could not be loaded, when it could not.
    let errorMessage: String?
    let clicks: Growth
    let clicksRun: ComparisonRun
    let impressions: Growth
    let impressionsRun: ComparisonRun
    /// Clicks over impressions, over the whole period. Nil when nothing was shown at all:
    /// a rate over no impressions is undefined, and a zero would read as "nobody clicked".
    let ctr: Growth?
    let ctrRun: ComparisonRun
    /// Nil for a site without an analytics provider, or one whose series has not synced.
    let visits: Growth?
    let visitsRun: ComparisonRun
    /// Nil for a site without a commerce provider, or before its report has landed.
    let sales: Sales?
    /// Nil before the site's registry has landed.
    let plan: Plan?

    var id: Site.ID { site.id }

    struct Sales: Equatable {
        let growth: Growth
        let currency: String?
        let run: ComparisonRun
    }

    /// The registry, read as progress. Indexing is measured over the keyword pages, as on
    /// the registry screen.
    struct Plan: Equatable {
        let totals: RegistryTotals
        let funnel: PlanFunnel
        /// The Indexed series, oldest first, for the picture.
        let coverage: [IndexCoverageDay]
        /// The indexed share's move over the period, in percentage points: the newest
        /// reading against the newest one at least `period.days` old. Nil when the series
        /// does not reach that far.
        let indexedMove: Double?

        var indexedShare: Double? { totals.indexedShare }
    }

    /// One project from what is held for it. `series` is the site's long daily series, or nil
    /// until it lands; the dashboard's 28 days stand in, as on the Overview's strip.
    static func make(
        overview: SiteOverview,
        series: [HistoryReportDay]?,
        revenue: RevenueReport?,
        targets: [RegistryTarget]?,
        coverage: [IndexCoverageDay],
        period: Period
    ) -> ProjectTrajectory {
        let days = OverviewGlance.days(for: overview, series: series)
        let count = days.count
        let window = period.days
        let current = Array(days.suffix(window))
        let previous = Array(days[max(0, count - window * 2)..<max(0, count - window)])

        let clicks = Growth(
            current: current.reduce(0) { $0 + $1.clicks },
            previous: previous.isEmpty ? nil : previous.reduce(0) { $0 + $1.clicks }
        )
        let impressions = Growth(
            current: current.reduce(0) { $0 + $1.impressions },
            previous: previous.isEmpty ? nil : previous.reduce(0) { $0 + $1.impressions }
        )
        let visitsComparison = VisitsComparison(days: days, window: window)
        let visits = visitsComparison.map { Growth(current: $0.current, previous: $0.previous) }

        var sales: Sales?
        if let revenue, revenue.revenue != nil {
            let now = revenue.days.map { ($0.day, $0.revenue / 100) }
            // The report carries only the window's days, and the period before as one
            // total: that total is spread over the same days, and the run says so.
            sales = Sales(
                growth: Growth(current: revenue.current.revenue, previous: revenue.previous.revenue),
                currency: revenue.currency,
                run: ComparisonRun.make(
                    current: now,
                    previousTotal: revenue.previous.revenue / 100,
                    period: period
                )
            )
        }

        var plan: Plan?
        if let targets {
            let totals = RegistryList.totals(targets)
            let series = RegistryList.coverageDays(coverage)
            plan = Plan(
                totals: totals,
                funnel: PlanFunnel(targets: targets),
                coverage: series,
                indexedMove: indexedMove(series, days: window)
            )
        }

        let clicksRun = ComparisonRun.make(
            current: current.map { ($0.day, $0.clicks) },
            previous: previous.map(\.clicks),
            period: period
        )
        let impressionsRun = ComparisonRun.make(
            current: current.map { ($0.day, $0.impressions) },
            previous: previous.map(\.impressions),
            period: period
        )

        return ProjectTrajectory(
            site: overview.site,
            errorMessage: overview.errorMessage,
            clicks: clicks,
            clicksRun: clicksRun,
            impressions: impressions,
            impressionsRun: impressionsRun,
            ctr: Rate.over(clicks, impressions),
            ctrRun: ComparisonRun.rate(of: clicksRun, over: impressionsRun),
            visits: visits,
            visitsRun: ComparisonRun.make(
                current: current.map { ($0.day, $0.visits?.visits ?? 0) },
                previous: previous.map { $0.visits?.visits ?? 0 },
                period: period
            ),
            sales: sales,
            plan: plan
        )
    }

    /// The indexed share's move over `days`, in percentage points, read the way the Domain
    /// Rating's is: the newest reading against the newest one on or before the cutoff, and
    /// nothing when the series does not reach back that far.
    static func indexedMove(_ coverage: [IndexCoverageDay], days: Int) -> Double? {
        guard let latest = coverage.last, let latestShare = latest.indexedShare,
              let latestDate = ISODay.date(latest.date),
              let cutoff = Calendar(identifier: .gregorian).date(byAdding: .day, value: -days, to: latestDate)
        else { return nil }
        let cutoffKey = ISODay.string(cutoff)
        guard let baseline = coverage.last(where: { $0.date <= cutoffKey }), let baselineShare = baseline.indexedShare else {
            return nil
        }
        return (latestShare - baselineShare) * 100
    }
}

/// A rate made of two counts — clicks over impressions — and never of two rates.
///
/// The fleet's click-through rate is its clicks over its impressions, not the mean of its
/// projects' rates: a project with four impressions and one click would otherwise pull the
/// fleet's 8% up towards 25%. The same holds for a period: the rate of the whole period is
/// its clicks over its impressions, not the mean of its days.
enum Rate {
    /// The rate over the period and over the period before, from the two counts. Nil when
    /// nothing was shown, where a rate has no meaning and a zero would be a lie.
    static func over(_ top: Growth, _ bottom: Growth) -> Growth? {
        guard bottom.current > 0 else { return nil }
        var previous: Double?
        if let topBefore = top.previous, let bottomBefore = bottom.previous, bottomBefore > 0 {
            previous = topBefore / bottomBefore
        }
        return Growth(current: top.current / bottom.current, previous: previous)
    }

    /// How a rate moved, in percentage points. A rate's move is never a percentage of a
    /// percentage: from 8% to 9% is a point, not a ninth.
    static func points(_ growth: Growth) -> Double? {
        guard let previous = growth.previous else { return nil }
        return (growth.current - previous) * 100
    }
}

/// A count over the period against the same count the period before.
struct Growth: Equatable {
    let current: Double
    /// Nil when the period before is not stored.
    let previous: Double?

    /// (current − previous) / previous. Nil when there was nothing to grow from: no earlier
    /// period, or an earlier period of zero.
    var ratio: Double? {
        guard let previous, previous > 0 else { return nil }
        return (current - previous) / previous
    }
}

/// The period and the period before as two runs on one axis, the same length: a day per
/// point up to a month, a week per point beyond, so a half year is 26 points.
///
/// A point is the day it names and nothing else. A daily run used to be drawn through a
/// seven-day trailing mean, with each point keeping its own measurement beside the mean it
/// was drawn at — which made the hero chart unreadable the moment it grew a hover: the line
/// sat at 700 while the label said 3.918, and the two were both right and impossible to tell
/// apart. A line that a reader can point at has to be the number they are shown. It is also
/// how a project's own dashboard draws its days (see `TrendChart`), so a site now draws the
/// same shape on both pages.
struct ComparisonRun: Equatable {
    struct Point: Equatable, Identifiable {
        /// The last day the point sums.
        let date: Date
        let value: Double
        var id: Date { date }

        init(date: Date, value: Double) {
            self.date = date
            self.value = value
        }
    }

    let current: [Point]
    /// The earlier run's values, index for index with `current`. Empty when there is none.
    let previous: [Double]
    /// The earlier run is a stand-in — one total spread evenly — and is drawn as such.
    let previousIsAverage: Bool

    init(current: [Point], previous: [Double], previousIsAverage: Bool) {
        self.current = current
        self.previous = previous
        self.previousIsAverage = previousIsAverage
    }

    /// Several runs of the same period laid on one axis and added, point for point from the
    /// last day back.
    ///
    /// Backwards, because the runs are not all the same length: a site that started counting
    /// three weeks ago has fewer points than one measured for a year, and both end on the
    /// same day. Adding from the end lets every run carry the days it measured and stretches
    /// none of them over days it did not. An empty run adds nothing at all.
    ///
    /// The earlier run is added the same way, and is empty when no run has one — a fleet
    /// that only started counting has nothing to be set against, which is not the same as
    /// being set against zero.
    static func sum(_ runs: [ComparisonRun]) -> ComparisonRun {
        let counted = runs.filter { !$0.current.isEmpty }
        guard let longest = counted.max(by: { $0.current.count < $1.current.count }) else {
            return ComparisonRun(current: [], previous: [], previousIsAverage: false)
        }
        let count = longest.current.count

        let current = (0..<count).map { index -> Point in
            var value = 0.0
            for run in counted {
                let offset = run.current.count - count + index
                guard offset >= 0 else { continue }
                value += run.current[offset].value
            }
            return Point(date: longest.current[index].date, value: value)
        }

        let hasPrevious = counted.contains { !$0.previous.isEmpty }
        let previous = hasPrevious ? (0..<count).map { index in
            counted.reduce(0.0) { total, run in
                let offset = run.previous.count - count + index
                return offset >= 0 ? total + run.previous[offset] : total
            }
        } : []

        return ComparisonRun(
            current: current,
            previous: previous,
            // One stand-in among the runs makes the sum a stand-in: the line is drawn dashed
            // rather than claiming days that were never measured.
            previousIsAverage: counted.contains { $0.previousIsAverage }
        )
    }

    /// One run over another, point for point: the run of a rate.
    ///
    /// A point with nothing under it is drawn at zero — the rate is undefined there, and a
    /// line has to be somewhere.
    static func rate(of top: ComparisonRun, over bottom: ComparisonRun) -> ComparisonRun {
        func divide(_ top: Double, _ bottom: Double) -> Double {
            bottom > 0 ? top / bottom : 0
        }
        let current = top.current.indices.map { index in
            Point(
                date: top.current[index].date,
                value: divide(top.current[index].value, index < bottom.current.count ? bottom.current[index].value : 0)
            )
        }
        let previous = top.previous.indices.map { index in
            divide(top.previous[index], index < bottom.previous.count ? bottom.previous[index] : 0)
        }
        return ComparisonRun(
            current: current,
            previous: previous,
            previousIsAverage: top.previousIsAverage || bottom.previousIsAverage
        )
    }

    /// Days summed into one point: one up to a month, seven beyond.
    static func bucketSize(for period: Period) -> Int {
        period.days > 31 ? 7 : 1
    }

    static func make(current: [(Date, Double)], previous: [Double], period: Period) -> ComparisonRun {
        let size = bucketSize(for: period)
        return ComparisonRun(
            current: buckets(current, size: size),
            previous: buckets(previous.map { (Date.distantPast, $0) }, size: size).map(\.value),
            previousIsAverage: false
        )
    }

    /// A run whose earlier period is known only as a total.
    static func make(current: [(Date, Double)], previousTotal: Double, period: Period) -> ComparisonRun {
        let now = buckets(current, size: bucketSize(for: period))
        return ComparisonRun(
            current: now,
            previous: now.isEmpty ? [] : Array(repeating: previousTotal / Double(now.count), count: now.count),
            previousIsAverage: true
        )
    }

    /// Sums a run into buckets of `size` from its end, so both runs line up on their last day.
    static func buckets(_ values: [(Date, Double)], size: Int) -> [Point] {
        guard size > 1 else { return values.map { Point(date: $0.0, value: $0.1) } }
        var out: [Point] = []
        var end = values.count
        while end > 0 {
            let start = max(0, end - size)
            let run = values[start..<end]
            out.append(Point(date: run.last!.0, value: run.reduce(0) { $0 + $1.1 }))
            end = start
        }
        return out.reversed()
    }
}

/// The registry read as a funnel over the pages a keyword aims at: planned, published,
/// indexed, reached by a search, clicked. Each step is a count of pages, never more than
/// the step before it in meaning, if not always in number.
struct PlanFunnel: Equatable {
    struct Step: Equatable, Identifiable {
        let name: String
        let count: Int
        var id: String { name }
    }

    let planned: Int
    let published: Int
    let indexed: Int
    let reached: Int
    let clicked: Int

    init(targets: [RegistryTarget]) {
        let planned = targets.filter { !$0.mappedKeywords.isEmpty }
        self.planned = planned.count
        published = planned.filter { $0.phase != RegistryPhase.new.rawValue }.count
        indexed = planned.filter { $0.indexed == "indexed" }.count
        reached = planned.filter { $0.window.impressions > 0 }.count
        clicked = planned.filter { $0.window.clicks > 0 }.count
    }

    var steps: [Step] {
        [
            Step(name: "Planned", count: planned),
            Step(name: "Published", count: published),
            Step(name: "Indexed", count: indexed),
            Step(name: "Reached", count: reached),
            Step(name: "Clicked", count: clicked),
        ]
    }
}
