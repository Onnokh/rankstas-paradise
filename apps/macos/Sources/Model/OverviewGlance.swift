import Foundation

/// One site as the Overview reads it: Search Console's figures over the period against the
/// period before, and the analytics provider's visits over the same days. Read from what is
/// stored — the site's daily series, or the dashboard's own 28 days until the series lands —
/// never from a poll.
struct SiteGlance: Identifiable, Equatable {
    let site: Site
    let comparison: PeriodComparison
    /// Nil for a site without an analytics provider, or one whose series has not loaded yet.
    let visits: VisitsComparison?
    /// Why the site's dashboard could not be loaded, when it could not.
    let errorMessage: String?

    var id: Site.ID { site.id }
}

/// The Overview's arithmetic, kept out of the view so it can be checked.
enum OverviewGlance {
    /// The days a site is read from: the long daily series when it is loaded, else the 28
    /// days the dashboard carries. The series is what has the visits and what reaches back
    /// far enough to set six months against the six before; the dashboard is what is on disk
    /// at launch.
    static func days(for overview: SiteOverview, series: [HistoryReportDay]?) -> [HistoryReportDay] {
        if let series, !series.isEmpty {
            return series
        }
        return (overview.dashboard?.history ?? []).map {
            HistoryReportDay(date: $0.date, provisional: false, impressions: $0.impressions, clicks: $0.clicks, ctr: $0.ctr, position: $0.position)
        }
    }

    /// One glance per site, in the order the server lists them — the tab bar's order.
    static func rows(overviews: [SiteOverview], series: [Site.ID: [HistoryReportDay]], period: Period) -> [SiteGlance] {
        overviews.map { overview in
            let days = days(for: overview, series: series[overview.id])
            return SiteGlance(
                site: overview.site,
                comparison: PeriodComparison(days: days.map(\.asHistoryDay), window: period.days),
                visits: VisitsComparison(days: days, window: period.days),
                errorMessage: overview.errorMessage
            )
        }
    }

    /// Every site's days in one comparison. Clicks and impressions sum; the position is
    /// weighted by impressions, so the total reads as one property would.
    static func total(_ rows: [SiteGlance]) -> PeriodComparison {
        PeriodComparison(
            current: rows.flatMap(\.comparison.current),
            previous: rows.flatMap(\.comparison.previous)
        )
    }

    /// Every site's visits in one comparison. Nil when no site has a provider with anything
    /// to show; the earlier period is nil when no site has a synced day in it, so a fleet
    /// that only started counting reads as "no comparison yet" rather than as growth.
    static func totalVisits(_ rows: [SiteGlance]) -> VisitsComparison? {
        let counted = rows.compactMap(\.visits)
        guard !counted.isEmpty else { return nil }
        let earlier = counted.compactMap(\.previous)
        return VisitsComparison(
            current: counted.reduce(0) { $0 + $1.current },
            previous: earlier.isEmpty ? nil : earlier.reduce(0, +)
        )
    }
}
