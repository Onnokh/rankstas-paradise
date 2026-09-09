import Foundation
import Observation

/// A site's work record: every Action taken on one of its pages and every Note written
/// beside one, as the server holds them.
///
/// Cache-first like the history and the ranked lists: the last record for a site is read
/// from disk the first time the Log is shown, then fetched from the server once per session,
/// or on demand. The held record survives a failed fetch — an entry that was on screen a
/// second ago is still true, and blanking the timeline to say "the network went away" would
/// lose the reader their place in it.
///
/// Its own store rather than a field on `RankingStore`: that one holds what a period ranks
/// to, and the Log is not measured in periods at all. It is also the one list here that a
/// person wrote by hand, so it is worth keeping whether or not a window is loaded.
@MainActor
@Observable
final class LogStore {
    private(set) var entries: [Site.ID: [LogEntry]] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var loading: Set<Site.ID> = []

    @ObservationIgnored private let cacheDirectory: URL
    @ObservationIgnored private let makeClient: @Sendable () throws -> APIClient
    /// Sites fetched from the server this session. What is held for any other site came from
    /// the cache and is fetched the next time its Log is shown.
    @ObservationIgnored private var fetchedThisSession: Set<Site.ID> = []
    @ObservationIgnored private var seededSites: Set<Site.ID> = []

    init(
        cacheDirectory: URL = OverviewCache.defaultURL.deletingLastPathComponent().appending(path: "log", directoryHint: .isDirectory),
        makeClient: @escaping @Sendable () throws -> APIClient = { APIClient(target: try ClientConfiguration.load()) }
    ) {
        self.cacheDirectory = cacheDirectory
        self.makeClient = makeClient
    }

    /// Shows the cached record at once and fetches it from the server once per session.
    func load(_ siteID: Site.ID) async {
        seedFromCache(siteID)
        guard !fetchedThisSession.contains(siteID) else { return }
        await fetch(siteID)
    }

    /// Fetches the record again, over what is shown.
    func refresh(_ siteID: Site.ID) async {
        fetchedThisSession.remove(siteID)
        await fetch(siteID)
    }

    private func fetch(_ siteID: Site.ID) async {
        guard !loading.contains(siteID) else { return }
        loading.insert(siteID)
        defer { loading.remove(siteID) }
        do {
            let client = try makeClient()
            let report = try await client.log(siteID: siteID)
            entries[siteID] = report.actions
            errors[siteID] = nil
            fetchedThisSession.insert(siteID)
            writeCache(report.actions, for: siteID)
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }

    // MARK: Cache

    private func seedFromCache(_ siteID: Site.ID) {
        guard !seededSites.contains(siteID) else { return }
        seededSites.insert(siteID)
        guard entries[siteID] == nil, let cached = readCache(siteID) else { return }
        entries[siteID] = cached
    }

    private func cacheURL(_ siteID: Site.ID) -> URL {
        cacheDirectory.appending(path: "\(siteID).json", directoryHint: .notDirectory)
    }

    private func readCache(_ siteID: Site.ID) -> [LogEntry]? {
        guard let data = try? Data(contentsOf: cacheURL(siteID)) else { return nil }
        return try? JSONDecoder().decode([LogEntry].self, from: data)
    }

    private func writeCache(_ entries: [LogEntry], for siteID: Site.ID) {
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(entries) {
            try? data.write(to: cacheURL(siteID), options: .atomic)
        }
    }
}
