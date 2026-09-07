import Foundation
import Observation

/// The people on each site right now, from `GET /api/live`.
///
/// Unlike the other stores this one is never cached to disk: a live count is stale the
/// moment it lands, and showing yesterday's "3 people" at launch would be a lie. A site
/// screen polls while it is on screen; the server memoises the provider's answer for thirty
/// seconds, so polling at that pace costs the provider one call per half minute however
/// many windows are open.
@MainActor
@Observable
final class LiveStore {
    private(set) var reports: [Site.ID: LiveReport] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var refreshing: Set<Site.ID> = []

    /// How often a screen asks again. Matches the server's memo, so asking faster buys nothing.
    static let pollInterval: Duration = .seconds(30)

    @ObservationIgnored private let makeClient: @Sendable () throws -> APIClient

    init(makeClient: @escaping @Sendable () throws -> APIClient = { APIClient(target: try ClientConfiguration.load()) }) {
        self.makeClient = makeClient
    }

    /// Fetches now, then every `pollInterval`, until the task is cancelled. Meant for a
    /// screen's `.task(id:)`, so the polling lives exactly as long as the screen is shown.
    func poll(_ siteID: Site.ID) async {
        while !Task.isCancelled {
            await refresh(siteID)
            do {
                try await Task.sleep(for: Self.pollInterval)
            } catch {
                return
            }
        }
    }

    func refresh(_ siteID: Site.ID) async {
        guard !refreshing.contains(siteID) else { return }
        refreshing.insert(siteID)
        defer { refreshing.remove(siteID) }
        do {
            let client = try makeClient()
            reports[siteID] = try await client.live(siteID: siteID)
            errors[siteID] = nil
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }
}
