import Foundation

struct OverviewSnapshot: Codable, Sendable {
    static let schemaVersion = 1

    let version: Int
    let savedAt: Date
    let sites: [Site]
    let dashboards: [Site.ID: DashboardEnvelope]

    init(
        savedAt: Date = .now,
        sites: [Site],
        dashboards: [Site.ID: DashboardEnvelope]
    ) {
        version = Self.schemaVersion
        self.savedAt = savedAt
        self.sites = sites
        self.dashboards = dashboards
    }
}

struct OverviewUpdate: Sendable {
    let snapshot: OverviewSnapshot
    let siteErrors: [Site.ID: String]
    let cacheWarning: String?
}

protocol OverviewLoading: Sendable {
    func loadCached() async -> OverviewSnapshot?
    func refresh() async throws -> OverviewUpdate
}

actor OverviewRepository: OverviewLoading {
    private let cache: OverviewCache
    private var client: APIClient?
    private var snapshot: OverviewSnapshot?

    init(cache: OverviewCache = OverviewCache(), client: APIClient? = nil) {
        self.cache = cache
        self.client = client
    }

    func loadCached() async -> OverviewSnapshot? {
        if let snapshot {
            return snapshot
        }

        snapshot = try? cache.load()
        return snapshot
    }

    func refresh() async throws -> OverviewUpdate {
        let client = try configuredClient()
        let sites = try await client.sites()
        guard !sites.isEmpty else {
            throw OverviewError.noSites
        }

        let previous = snapshot ?? (try? cache.load())
        let result = await loadDashboards(for: sites, previous: previous?.dashboards ?? [:], client: client)
        try Task.checkCancellation()

        let snapshot = OverviewSnapshot(sites: sites, dashboards: result.dashboards)
        self.snapshot = snapshot

        let cacheWarning: String?
        do {
            try cache.save(snapshot)
            cacheWarning = nil
        } catch {
            cacheWarning = "Could not save the local overview cache: \(error.localizedDescription)"
        }

        return OverviewUpdate(
            snapshot: snapshot,
            siteErrors: result.errors,
            cacheWarning: cacheWarning
        )
    }

    private func configuredClient() throws -> APIClient {
        if let client {
            return client
        }

        let client = APIClient(target: try ClientConfiguration.load())
        self.client = client
        return client
    }

    private func loadDashboards(
        for sites: [Site],
        previous: [Site.ID: DashboardEnvelope],
        client: APIClient
    ) async -> DashboardLoad {
        await withTaskGroup(of: SiteLoad.self, returning: DashboardLoad.self) { group in
            for site in sites {
                group.addTask {
                    do {
                        return .loaded(site.id, try await client.dashboard(siteID: site.id))
                    } catch is CancellationError {
                        return .cancelled
                    } catch {
                        return .failed(site.id, error.localizedDescription)
                    }
                }
            }

            var dashboards = Dictionary(
                uniqueKeysWithValues: sites.compactMap { site in
                    previous[site.id].map { (site.id, $0) }
                }
            )
            var errors: [Site.ID: String] = [:]
            for await result in group {
                switch result {
                case .loaded(let siteID, let dashboard):
                    dashboards[siteID] = dashboard
                case .failed(let siteID, let message):
                    errors[siteID] = message
                case .cancelled:
                    break
                }
            }
            return DashboardLoad(dashboards: dashboards, errors: errors)
        }
    }
}

struct OverviewCache: Sendable {
    let fileURL: URL

    init(fileURL: URL = Self.defaultURL) {
        self.fileURL = fileURL
    }

    func load() throws -> OverviewSnapshot? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(OverviewSnapshot.self, from: Data(contentsOf: fileURL))
        return snapshot.version == OverviewSnapshot.schemaVersion ? snapshot : nil
    }

    func save(_ snapshot: OverviewSnapshot) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(snapshot).write(to: fileURL, options: .atomic)
    }

    static let defaultURL = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
    )[0]
        .appending(path: "com.rankstasparadise.mac", directoryHint: .isDirectory)
        .appending(path: "overview.json", directoryHint: .notDirectory)
}

private struct DashboardLoad: Sendable {
    let dashboards: [Site.ID: DashboardEnvelope]
    let errors: [Site.ID: String]
}

private enum SiteLoad: Sendable {
    case loaded(Site.ID, DashboardEnvelope)
    case failed(Site.ID, String)
    case cancelled
}
