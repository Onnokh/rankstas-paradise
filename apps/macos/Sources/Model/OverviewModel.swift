import Foundation
import Observation

struct SiteOverview: Identifiable {
    let site: Site
    let dashboard: DashboardEnvelope?
    let errorMessage: String?
    let stats: DashboardStats?

    var id: Site.ID { site.id }

    init(site: Site, dashboard: DashboardEnvelope?, errorMessage: String?) {
        self.site = site
        self.dashboard = dashboard
        self.errorMessage = errorMessage
        stats = dashboard.map { DashboardStats(days: $0.history) }
    }
}

@MainActor
@Observable
final class OverviewModel {
    private(set) var sites: [Site] = []
    private(set) var dashboards: [Site.ID: DashboardEnvelope] = [:]
    private(set) var siteErrors: [Site.ID: String] = [:]
    private(set) var errorMessage: String?
    private(set) var isRefreshing = false
    private(set) var isCached = false

    @ObservationIgnored private let repository: any OverviewLoading
    @ObservationIgnored private var hasStarted = false

    init(repository: any OverviewLoading = OverviewRepository()) {
        self.repository = repository
    }

    var overviews: [SiteOverview] {
        sites.map {
            SiteOverview(site: $0, dashboard: dashboards[$0.id], errorMessage: siteErrors[$0.id])
        }
    }

    var loadedSiteCount: Int {
        sites.lazy.filter { self.dashboards[$0.id] != nil }.count
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true

        if let snapshot = await repository.loadCached() {
            apply(snapshot)
            isCached = true
        }

        await refresh()
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        errorMessage = nil
        siteErrors = [:]

        do {
            let update = try await repository.refresh()
            apply(update.snapshot)
            siteErrors = update.siteErrors
            errorMessage = update.cacheWarning
            isCached = false
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func apply(_ snapshot: OverviewSnapshot) {
        sites = snapshot.sites
        dashboards = snapshot.dashboards
    }
}

enum OverviewError: LocalizedError {
    case noSites

    var errorDescription: String? {
        "The Ranksta's Paradise server has no configured sites."
    }
}

extension OverviewModel {
    static var preview: OverviewModel {
        let model = OverviewModel()
        model.hasStarted = true
        let sleevy = Site(id: "sleevy", name: "Sleevy", origin: "https://sleevy.com")
        let missingMounts = Site(
            id: "missing-mounts",
            name: "Missing Mounts",
            origin: "https://missingmounts.com"
        )
        model.sites = [sleevy, missingMounts]
        model.dashboards = [
            sleevy.id: .preview(
                rows: 14_230,
                latestDate: "2026-09-01",
                signals: 2,
                history: [
                    HistoryDay(date: "2026-08-31", impressions: 1_200, clicks: 84, ctr: 0.07, position: 8.2),
                    HistoryDay(date: "2026-09-01", impressions: 1_400, clicks: 105, ctr: 0.075, position: 7.8)
                ]
            ),
            missingMounts.id: .preview(
                rows: 4_800,
                latestDate: "2026-09-01",
                signals: 5,
                history: [
                    HistoryDay(date: "2026-08-31", impressions: 720, clicks: 31, ctr: 0.043, position: 12.4),
                    HistoryDay(date: "2026-09-01", impressions: 810, clicks: 39, ctr: 0.048, position: 11.9)
                ]
            )
        ]
        return model
    }
}

private extension DashboardEnvelope {
    static func preview(
        rows: Int,
        latestDate: String,
        signals: Int,
        history: [HistoryDay]
    ) -> DashboardEnvelope {
        DashboardEnvelope(
            generatedAt: "2026-09-03T12:00:00Z",
            mode: "live",
            summary: Summary(rows: rows, dates: history.count),
            digest: OpportunityDigest(
                latestDate: latestDate,
                signals: (0..<signals).map {
                    OpportunitySignal(kind: "signal", label: "Signal \($0 + 1)")
                }
            ),
            history: history
        )
    }
}
