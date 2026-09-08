import Foundation
import Observation

/// The people on each site right now, from `GET /api/live`, today so far, from
/// `GET /api/today`, and what visitors are doing, from `GET /api/live/events`: the reads that
/// reach the provider.
///
/// Unlike the other stores this one is never cached to disk: a live count is stale the
/// moment it lands, and showing yesterday's "3 people" at launch would be a lie. A site
/// screen polls while it is on screen; the server memoises the provider's answers (thirty
/// seconds for live, a minute for today), so polling at that pace costs the provider one
/// round per memo however many windows are open.
///
/// The feed is the same, faster: the overview polls it every few seconds, sending the newest
/// row it has so the server only answers with what is newer, and `LiveFeed` folds that in.
@MainActor
@Observable
final class LiveStore {
    private(set) var reports: [Site.ID: LiveReport] = [:]
    private(set) var todays: [Site.ID: TodayReport] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var refreshing: Set<Site.ID> = []

    /// Each site's feed. Absent until the first answer, and absent for a site whose provider
    /// has nothing to say (`reports` carries the reason).
    private(set) var feeds: [Site.ID: LiveFeed] = [:]
    private(set) var feedErrors: [Site.ID: String] = [:]
    private var feedRefreshing: Set<Site.ID> = []

    /// How often a screen asks again. Matches the server's memo, so asking faster buys nothing.
    static let pollInterval: Duration = .seconds(30)
    /// How often the feed is asked again. Matches the server's memo of the feed.
    static let feedPollInterval: Duration = .seconds(5)

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

    /// The overview's version of `poll`: every site at once, on the same timer.
    func pollAll(_ siteIDs: [Site.ID]) async {
        while !Task.isCancelled {
            await refreshAll(siteIDs)
            do {
                try await Task.sleep(for: Self.pollInterval)
            } catch {
                return
            }
        }
    }

    /// Fetches every site's feed now, then every `feedPollInterval`, until cancelled.
    func pollFeeds(_ siteIDs: [Site.ID]) async {
        while !Task.isCancelled {
            await refreshFeeds(siteIDs)
            do {
                try await Task.sleep(for: Self.feedPollInterval)
            } catch {
                return
            }
        }
    }

    func refreshAll(_ siteIDs: [Site.ID]) async {
        await withTaskGroup(of: Void.self) { group in
            for siteID in siteIDs {
                group.addTask { await self.refresh(siteID) }
            }
        }
    }

    func refreshFeeds(_ siteIDs: [Site.ID]) async {
        await withTaskGroup(of: Void.self) { group in
            for siteID in siteIDs {
                group.addTask { await self.refreshFeed(siteID) }
            }
        }
    }

    /// One poll of one site's feed: asks for what is newer than the newest row held, and folds
    /// the answer in. A site whose provider answers nothing keeps no feed.
    func refreshFeed(_ siteID: Site.ID) async {
        guard !feedRefreshing.contains(siteID) else { return }
        feedRefreshing.insert(siteID)
        defer { feedRefreshing.remove(siteID) }
        do {
            let client = try makeClient()
            let report = try await client.liveEvents(siteID: siteID, since: feeds[siteID]?.newestAt)
            if let update = report.events {
                let current = feeds[siteID] ?? LiveFeed(windowMinutes: update.windowMinutes)
                feeds[siteID] = current.merging(update)
            } else {
                feeds[siteID] = nil
            }
            feedErrors[siteID] = nil
        } catch is CancellationError {
            return
        } catch {
            feedErrors[siteID] = error.localizedDescription
        }
    }

    func refresh(_ siteID: Site.ID) async {
        guard !refreshing.contains(siteID) else { return }
        refreshing.insert(siteID)
        defer { refreshing.remove(siteID) }
        do {
            let client = try makeClient()
            reports[siteID] = try await client.live(siteID: siteID)
            todays[siteID] = try await client.today(siteID: siteID)
            errors[siteID] = nil
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }
}
