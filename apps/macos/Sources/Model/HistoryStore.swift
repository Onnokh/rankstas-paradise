import Foundation
import Observation

/// Per-site daily history long enough to compare any period with the one before it.
///
/// Cache-first like the overview: the last series is read from disk at once, then refreshed
/// from the server once per session per site, or on demand.
@MainActor
@Observable
final class HistoryStore {
    private(set) var series: [Site.ID: [HistoryReportDay]] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var refreshing: Set<Site.ID> = []

    @ObservationIgnored private let cacheDirectory: URL
    @ObservationIgnored private let makeClient: @Sendable () throws -> APIClient
    @ObservationIgnored private var refreshedThisSession: Set<Site.ID> = []

    init(
        cacheDirectory: URL = OverviewCache.defaultURL.deletingLastPathComponent().appending(path: "history", directoryHint: .isDirectory),
        makeClient: @escaping @Sendable () throws -> APIClient = { APIClient(target: try ClientConfiguration.load()) }
    ) {
        self.cacheDirectory = cacheDirectory
        self.makeClient = makeClient
    }

    /// Shows the cached series immediately and refreshes it once per session.
    func load(_ siteID: Site.ID) async {
        if series[siteID] == nil, let cached = readCache(siteID) {
            series[siteID] = cached
        }
        guard !refreshedThisSession.contains(siteID) else { return }
        await refresh(siteID)
    }

    func refresh(_ siteID: Site.ID) async {
        guard !refreshing.contains(siteID) else { return }
        refreshing.insert(siteID)
        defer { refreshing.remove(siteID) }
        do {
            let client = try makeClient()
            let report = try await client.history(siteID: siteID, limit: Period.historyLimit)
            series[siteID] = report.days
            errors[siteID] = nil
            refreshedThisSession.insert(siteID)
            writeCache(report.days, for: siteID)
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }

    private func cacheURL(_ siteID: Site.ID) -> URL {
        cacheDirectory.appending(path: "\(siteID).json", directoryHint: .notDirectory)
    }

    private func readCache(_ siteID: Site.ID) -> [HistoryReportDay]? {
        guard let data = try? Data(contentsOf: cacheURL(siteID)) else { return nil }
        return try? JSONDecoder().decode([HistoryReportDay].self, from: data)
    }

    private func writeCache(_ days: [HistoryReportDay], for siteID: Site.ID) {
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(days) {
            try? data.write(to: cacheURL(siteID), options: .atomic)
        }
    }
}
