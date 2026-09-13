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

        return ProjectTrajectory(
            site: overview.site,
            errorMessage: overview.errorMessage,
            clicks: clicks,
            clicksRun: ComparisonRun.make(
                current: current.map { ($0.day, $0.clicks) },
                previous: previous.map(\.clicks),
                period: period
            ),
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
/// point up to a month, a week per point beyond, so a half year is 26 points. A daily run
/// is read through a seven-day trailing mean, so a site with one click a day draws a shape
/// and not a square wave.
struct ComparisonRun: Equatable {
    struct Point: Equatable, Identifiable {
        /// The last day the point sums.
        let date: Date
        let value: Double
        var id: Date { date }
    }

    let current: [Point]
    /// The earlier run's values, index for index with `current`. Empty when there is none.
    let previous: [Double]
    /// The earlier run is a stand-in — one total spread evenly — and is drawn as such.
    let previousIsAverage: Bool

    /// Days summed into one point: one up to a month, seven beyond.
    static func bucketSize(for period: Period) -> Int {
        period.days > 31 ? 7 : 1
    }

    /// Whether a daily run is smoothed: from two weeks up, where a mean has room to mean.
    static func smooths(_ period: Period) -> Bool {
        bucketSize(for: period) == 1 && period.days >= 14
    }

    static func make(current: [(Date, Double)], previous: [Double], period: Period) -> ComparisonRun {
        let size = bucketSize(for: period)
        var now = buckets(current, size: size)
        var was = buckets(previous.map { (Date.distantPast, $0) }, size: size).map(\.value)
        if smooths(period) {
            now = smoothed(now, window: 7)
            was = smoothed(was, window: 7)
        }
        return ComparisonRun(current: now, previous: was, previousIsAverage: false)
    }

    /// A run whose earlier period is known only as a total.
    static func make(current: [(Date, Double)], previousTotal: Double, period: Period) -> ComparisonRun {
        let size = bucketSize(for: period)
        var now = buckets(current, size: size)
        if smooths(period) {
            now = smoothed(now, window: 7)
        }
        let was = now.isEmpty ? [] : Array(repeating: previousTotal / Double(now.count), count: now.count)
        return ComparisonRun(current: now, previous: was, previousIsAverage: true)
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

    /// A trailing mean over `window` points. A run no longer than the window is left alone.
    static func smoothed(_ points: [Point], window: Int) -> [Point] {
        guard window > 1, points.count > window else { return points }
        return points.indices.map { index in
            let start = max(0, index - window + 1)
            let run = points[start...index]
            return Point(date: points[index].date, value: run.reduce(0) { $0 + $1.value } / Double(run.count))
        }
    }

    static func smoothed(_ values: [Double], window: Int) -> [Double] {
        smoothed(values.map { Point(date: .distantPast, value: $0) }, window: window).map(\.value)
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
