#if DEBUG
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: the Overview is a strip of totals and one quiet row per site. Onno wants to
// "actually see how the projects do" — not what the counts are this period, but whether
// each project is getting somewhere. Three rounds of cards (a dashboard per site, four
// groups of four lines, four figures and a chart) all answered a different question: what
// the numbers are. Round four answers his.
//
// What "how a project does" can be read from, with what is stored:
//   - direction: this period against the one before, as a ratio — a ratio makes a site
//     with 26 clicks comparable to one with 2,419
//   - the long run: the daily series reaches back up to a year, so 26 weeks of clicks or
//     visits shows the shape, where 28 days shows noise
//   - the plan: the registry's phases are a funnel — pages planned, published, indexed,
//     reached by a search, clicked — and the funnel is Ranksta's own reading of progress
//
// Three shapes, switchable from the floating bar at the bottom of the window (⌘⌥← / ⌘⌥→)
// while the Overview is in front, with real data:
//
//   E1a — Trajectory, toned down: the E1 card at two thirds — the site's name in a zone of
//         its own on the left, the four sources beside it, the percentage at 20 points
//   E1b — Trajectory, as rows: one card, one 64-point row per project, the four sources as
//         zones with the percentage and word over a small chart
//
// (Round five's E1 was chosen: "E1 could work, but it's way too big for 4 projects — do this
// but tone them down a bit.")
//
//   E1 — Trajectory, overlaid: one card per project; for Search, Visitors, Sales and Plan
//        the growth as one large percentage, and under it the period as a line in the
//        source's colour over the period before in grey, day against day
//   E2 — Trajectory, side by side: the same, the period before as a dim block of bars, then
//        the period lit, so the growth is the step between the blocks
//
// (Round four's E showed 26 weeks with the period lit; Onno: "E could work, but it would be
// nice to see any growth — compare it directly to a previous timeframe.")
//   F — Scorecard: one row per project, one verdict per source — the ratio and a word —
//       and the 26 weeks of clicks as a line at the row's end
//   G — Plan: one card per project, the registry as a funnel: planned, published, indexed,
//       reached, clicked, each a bar against the pages planned
//
// Every variant reads `PrototypeSiteSeries`, built once per body from the glance, the whole
// stored series and what the ranking store holds for the site.

// MARK: - Variant

/// Which shape the Overview is drawn in. Held once, in the environment; remembered across
/// launches so a variant can be judged after a restart.
@MainActor
@Observable
final class OverviewPrototype {
    enum Variant: String, CaseIterable, Identifiable {
        // Declaration order is the order the floating bar cycles through.
        case compact, rows, overlay

        var id: String { rawValue }

        var key: String {
            switch self {
            case .compact: "E1a"
            case .rows: "E1b"
            case .overlay: "E1"
            }
        }

        var name: String {
            switch self {
            case .compact: "Trajectory, toned down: the card at two thirds, the name in its own zone"
            case .rows: "Trajectory, as rows: one row per project in one card"
            case .overlay: "Trajectory, as round five drew it (for comparison)"
            }
        }
    }

    private static let defaultsKey = "prototype.overview.variant"

    var variant: Variant {
        didSet { UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .compact
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
struct OverviewPrototypeSwitcher: View {
    let prototype: OverviewPrototype
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
                    .frame(minWidth: 340)

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

// MARK: - Series

/// One site as the prototype draws it: the glance's figures, the period's days behind them,
/// oldest first, and what the ranking store holds for the site — its sales, its registry,
/// its indexing series and its plan's demand — plus the dashboard's domain rating.
struct PrototypeSiteSeries: Identifiable {
    let glance: SiteGlance
    let days: [HistoryReportDay]
    /// The period before, for the moves of the figures the glance does not carry.
    var previousDays: [HistoryReportDay] = []
    /// Every stored day, oldest first: the long run.
    var allDays: [HistoryReportDay] = []
    /// The registry's pages, for the funnel.
    var targets: [RegistryTarget] = []
    var rating: RatingMove? = nil
    /// Nil for a site without a commerce provider, or before its report has landed.
    var revenue: RevenueReport? = nil
    /// Nil before the registry has landed; a registry with no pages is a total of zeros.
    var registry: RegistryTotals? = nil
    var coverage: [IndexCoverageDay] = []
    /// Searches a month behind the whole plan, from the health report.
    var monthlyVolume: Double? = nil

    var id: Site.ID { glance.id }
    var site: Site { glance.site }

    /// Whether the site sells: its revenue report names a provider.
    var sells: Bool { revenue?.revenue != nil }

    /// The period's total for a metric, as the glance already counts it.
    func total(_ metric: PrototypeMetric) -> Double {
        switch metric {
        case .clicks: glance.comparison.currentStats.clicks
        case .impressions: glance.comparison.currentStats.impressions
        case .visits: glance.visits?.current ?? 0
        }
    }
}

/// What a chart or a bar can be drawn from. Each takes the colour of its series on the site
/// dashboard, so a colour keeps its one meaning across the app.
enum PrototypeMetric: String, CaseIterable, Identifiable {
    case clicks, impressions, visits

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clicks: "Clicks"
        case .impressions: "Impressions"
        case .visits: "Visits"
        }
    }

    var color: Color {
        switch self {
        case .clicks: Palette.blue
        case .impressions: Palette.amber
        case .visits: visitsColor
        }
    }

    func value(_ day: HistoryReportDay) -> Double {
        switch self {
        case .clicks: day.clicks
        case .impressions: day.impressions
        case .visits: day.visits?.visits ?? 0
        }
    }
}

@MainActor
enum OverviewSeries {
    /// One series per site, in the server's order, cut to the period. The ranking store is
    /// optional so a still can be drawn without one.
    static func sites(
        overviews: [SiteOverview],
        series: [Site.ID: [HistoryReportDay]],
        rankings: RankingStore? = nil,
        period: Period
    ) -> [PrototypeSiteSeries] {
        let rows = OverviewGlance.rows(overviews: overviews, series: series, period: period)
        return zip(overviews, rows).map { overview, glance in
            let days = OverviewGlance.days(for: overview, series: series[overview.id])
            let count = days.count
            let window = period.days
            let key = RankingStore.KeywordsKey(siteID: overview.id, period: period)
            return PrototypeSiteSeries(
                glance: glance,
                days: Array(days.suffix(window)),
                previousDays: Array(days[max(0, count - window * 2)..<max(0, count - window)]),
                allDays: days,
                targets: rankings?.registry[overview.id] ?? [],
                rating: rating(of: overview, days: window),
                revenue: rankings?.revenue[key],
                registry: rankings?.registry[overview.id].map(RegistryList.totals),
                coverage: RegistryList.coverageDays(rankings?.coverage[overview.id] ?? []),
                monthlyVolume: rankings?.health[overview.id]?.totals.monthlyVolume
            )
        }
    }

    /// The Domain Rating's move over the period, as the site dashboard reads it.
    static func rating(of overview: SiteOverview, days: Int) -> RatingMove? {
        guard let dashboard = overview.dashboard else { return nil }
        var series = dashboard.domainRatingHistory ?? []
        if series.isEmpty, let rating = dashboard.domainRating {
            series = [DomainRatingDay(date: String(rating.fetchedAt.prefix(10)), rating: rating.rating)]
        }
        return RatingMove(history: series, days: days)
    }

    /// Every site's days as one series, by date. Clicks and impressions add; the position is
    /// weighted by impressions; a day is provisional when any site's is; visits add over the
    /// sites that have them and stay nil when none does.
    static func total(_ sites: [PrototypeSiteSeries]) -> [HistoryReportDay] {
        struct Sum {
            var impressions = 0.0
            var clicks = 0.0
            var weightedPosition = 0.0
            var provisional = false
            var visits: VisitsDay?
        }
        var byDate: [String: Sum] = [:]
        for site in sites {
            for day in site.days {
                var sum = byDate[day.date] ?? Sum()
                sum.impressions += day.impressions
                sum.clicks += day.clicks
                sum.weightedPosition += day.position * day.impressions
                sum.provisional = sum.provisional || day.provisional
                if let visits = day.visits {
                    let earlier = sum.visits ?? VisitsDay(pageviews: 0, visits: 0, visitors: 0)
                    sum.visits = VisitsDay(
                        pageviews: earlier.pageviews + visits.pageviews,
                        visits: earlier.visits + visits.visits,
                        visitors: earlier.visitors + visits.visitors
                    )
                }
                byDate[day.date] = sum
            }
        }
        return byDate.keys.sorted().map { date in
            let sum = byDate[date]!
            return HistoryReportDay(
                date: date,
                provisional: sum.provisional,
                impressions: sum.impressions,
                clicks: sum.clicks,
                ctr: sum.impressions > 0 ? sum.clicks / sum.impressions : 0,
                position: sum.impressions > 0 ? sum.weightedPosition / sum.impressions : 0,
                visits: sum.visits
            )
        }
    }
}

// MARK: - Body

/// Draws the Overview in the chosen variant, under the page's own header and over its own
/// footer. The strip is every variant's first line, as it is the site dashboard's.
struct OverviewPrototypeBody: View {
    let variant: OverviewPrototype.Variant
    let sites: [PrototypeSiteSeries]
    let period: Period
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void
    let header: AnyView
    let footer: AnyView

    var body: some View {
        let rows = sites.map(\.glance)
        VStack(alignment: .leading, spacing: 0) {
            header
                .column()
                .padding(.top, SiteTabScreen.columnInset)
                .padding(.bottom, 40)

            GlanceStrip(
                comparison: OverviewGlance.total(rows),
                visits: OverviewGlance.totalVisits(rows),
                siteCount: rows.count
            )
            .column()

            switch variant {
            case .compact:
                ProtoTrajectoryVariant(sites: sites, period: period, style: .overlay, compact: true, icon: icon, onOpen: onOpen)
            case .rows:
                ProtoTrajectoryRows(sites: sites, period: period, icon: icon, onOpen: onOpen)
            case .overlay:
                ProtoTrajectoryVariant(sites: sites, period: period, style: .overlay, compact: false, icon: icon, onOpen: onOpen)
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
