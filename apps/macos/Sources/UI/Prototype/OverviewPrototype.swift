#if DEBUG
import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: the Overview is a strip of totals and one quiet row per site. It reads as a
// table dropped into the app rather than as one of its screens. A site's dashboard is the
// screen the reader knows: the strip, the chart edge to edge under it, the provider's cards
// side by side, the ranked lists as bars. What does the Overview look like built the same way?
//
// Four shapes of the same stored data, switchable from the floating bar at the bottom of the
// window (⌘⌥← / ⌘⌥→) while the Overview is in front, with real data. The shipped page is
// kept in the cycle as the baseline. Nothing here polls: every figure and every line is read
// from the stores the site dashboards read.
//
//   Current — the strip and the rows (as shipped)
//   B1 — Cards, wide: one card per site, the full column; four groups side by side —
//        Search, Visitors, Sales, Registry — each four lines and a small chart
//   B2 — Cards, two across: the same four groups stacked, the lines two to a row
//   A — Dashboard: the site screen's skeleton for the fleet — the strip, the fleet's chart
//       edge to edge, the visits card beside the sites as bars, then the rows
//   C — Sparklines: the rows kept, each with the period's clicks as a line in a zone of its
//       own, under the fleet's chart
//   D — Stacked: one chart, each site a band of the metric's one colour, the metric switched
//       above it; the rows under it
//
// Round three ("this ain't it, way too much information"): a card is four figures, one per
// group — Clicks, Visits, Revenue, Indexed — and one chart. Everything a group knows beyond
// its figure waits in a panel that opens on hover over the figure.
//
//   B3 — Cards, wide: one per site, the four figures as a strip, the chart under it
//   B4 — Cards, two across: the four figures with their moves under them, the chart under
//
// Round two (B won round one, "but the cards need work — not just a small detail page"):
// a card carries the three things the app knows about a site, in groups. Search is Search
// Console and Ahrefs: clicks, impressions, CTR, domain rating. Visitors is the analytics
// provider: visits, visitors a day, pageviews, pages a visit — bounce rate and time on page
// are left out of the domain's schema on purpose, every vendor defines them differently.
// Sales is the commerce provider, for the sites that have one. Registry is Ranksta's own:
// pages, the indexed share, the backlog, the plan's monthly search volume.
//
// Every variant reads `PrototypeSiteSeries`, built once per body from the glance and the days
// behind it. The fleet's days come from `OverviewSeries.total`, which sums the way
// `OverviewGlance.total` does: clicks and impressions add, the position is weighted by
// impressions, visits add where a site has them.

// MARK: - Variant

/// Which shape the Overview is drawn in. Held once, in the environment; remembered across
/// launches so a variant can be judged after a restart.
@MainActor
@Observable
final class OverviewPrototype {
    enum Variant: String, CaseIterable, Identifiable {
        // Declaration order is the order the floating bar cycles through.
        case current, leanWide, lean, cardsWide, cards, dashboard, sparklines, stacked

        var id: String { rawValue }

        var key: String {
            switch self {
            case .current: "Current"
            case .leanWide: "B3"
            case .lean: "B4"
            case .cardsWide: "B1"
            case .cards: "B2"
            case .dashboard: "A"
            case .sparklines: "C"
            case .stacked: "D"
            }
        }

        var name: String {
            switch self {
            case .current: "The strip and the rows (as shipped)"
            case .leanWide: "Cards, wide: four figures, one chart; the rest on hover"
            case .lean: "Cards, two across: four figures, one chart; the rest on hover"
            case .cardsWide: "Cards, wide: one per site, the four groups side by side"
            case .cards: "Cards, two across: the four groups stacked"
            case .dashboard: "Dashboard: the site screen's skeleton, for the fleet"
            case .sparklines: "Sparklines: the rows, each with its clicks as a line"
            case .stacked: "Stacked: one chart, each site a band; switch the metric"
            }
        }
    }

    private static let defaultsKey = "prototype.overview.variant"

    var variant: Variant {
        didSet { UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .current
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
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void
    let header: AnyView
    let footer: AnyView

    var body: some View {
        let rows = sites.map(\.glance)
        let total = OverviewSeries.total(sites)
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
            case .current:
                SitesCard(rows: rows, icon: icon, onOpen: onOpen)
                    .column()
                    .padding(.top, 36)
            case .dashboard:
                ProtoDashboardVariant(sites: sites, total: total, icon: icon, onOpen: onOpen)
            case .leanWide:
                ProtoLeanVariant(sites: sites, wide: true, icon: icon, onOpen: onOpen)
            case .lean:
                ProtoLeanVariant(sites: sites, wide: false, icon: icon, onOpen: onOpen)
            case .cardsWide:
                ProtoWideCardsVariant(sites: sites, icon: icon, onOpen: onOpen)
            case .cards:
                ProtoCardsVariant(sites: sites, icon: icon, onOpen: onOpen)
            case .sparklines:
                ProtoSparklinesVariant(sites: sites, total: total, icon: icon, onOpen: onOpen)
            case .stacked:
                ProtoStackedVariant(sites: sites, icon: icon, onOpen: onOpen)
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
