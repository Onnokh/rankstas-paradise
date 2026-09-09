import Foundation
import Observation

/// The ranked lists under a site's chart: its keywords and events for the chosen period, its
/// revenue over that period, and its registry targets. The lists are held in the server's
/// order; the cards rank them.
///
/// Cache-first like the history: the last lists for a site are read from disk the first time
/// the site is shown, then refreshed from the server once per session per period, or on
/// demand. Nothing on screen is ever emptied ahead of a fetch: a list stays in place until the
/// new one arrives and replaces it, so a refresh changes the numbers, not the layout.
@MainActor
@Observable
final class RankingStore {
    struct KeywordsKey: Hashable {
        let siteID: Site.ID
        let period: Period
    }

    private(set) var keywords: [KeywordsKey: [QueryRow]] = [:]
    private(set) var events: [KeywordsKey: [EventRow]] = [:]
    private(set) var revenue: [KeywordsKey: RevenueReport] = [:]
    private(set) var registry: [Site.ID: [RegistryTarget]] = [:]
    /// The plan judged on demand. Fetched with the registry, on the same terms: it is the
    /// same plan read the other way round, so one is never shown against a stale other.
    private(set) var health: [Site.ID: RegistryHealthReport] = [:]
    /// Keywords an expansion proposed and nobody has decided about. Fetched with the
    /// registry like the health report, and on the same terms: it is the same plan read
    /// from the other side, so one is never shown against a stale other.
    private(set) var proposals: [Site.ID: KeywordProposalsReport] = [:]
    /// Why a site has no plan-health report, when it has none. Kept rather than discarded:
    /// without it the planning screen cannot tell "this plan has no keywords" from "the
    /// report never arrived", and it stated the first while meaning the second.
    private(set) var healthErrors: [Site.ID: String] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var loading: Set<Site.ID> = []

    /// Rows a card shows.
    static let rowLimit = 10
    /// Keywords fetched per period: enough that the top ten by either metric are in the set.
    static let keywordLimit = 50

    @ObservationIgnored private let cacheDirectory: URL
    @ObservationIgnored private let makeClient: @Sendable () throws -> APIClient
    /// Periods fetched from the server this session. What is held for any other key came
    /// from the cache and is refreshed the next time it is shown.
    @ObservationIgnored private var freshPeriods: Set<KeywordsKey> = []
    @ObservationIgnored private var freshRegistries: Set<Site.ID> = []
    @ObservationIgnored private var seededSites: Set<Site.ID> = []

    init(
        cacheDirectory: URL = OverviewCache.defaultURL.deletingLastPathComponent().appending(path: "rankings", directoryHint: .isDirectory),
        makeClient: @escaping @Sendable () throws -> APIClient = { APIClient(target: try ClientConfiguration.load()) }
    ) {
        self.cacheDirectory = cacheDirectory
        self.makeClient = makeClient
    }

    /// Shows the cached lists at once and fetches the period from the server once per session.
    func load(_ siteID: Site.ID, period: Period) async {
        seedFromCache(siteID)
        let key = KeywordsKey(siteID: siteID, period: period)
        let needsPeriod = !freshPeriods.contains(key)
        let needsRegistry = !freshRegistries.contains(siteID)
        guard needsPeriod || needsRegistry else { return }
        await fetch(siteID, period: period, lists: needsPeriod, registry: needsRegistry)
    }

    /// Fetches every list for the site at this period again, over what is shown. The other
    /// periods are marked for a fetch of their own the next time they are shown.
    func refresh(_ siteID: Site.ID, period: Period) async {
        freshPeriods = freshPeriods.filter { $0.siteID != siteID }
        freshRegistries.remove(siteID)
        await fetch(siteID, period: period, lists: true, registry: true)
    }

    private func fetch(_ siteID: Site.ID, period: Period, lists: Bool, registry wantRegistry: Bool) async {
        guard !loading.contains(siteID) else { return }
        loading.insert(siteID)
        defer { loading.remove(siteID) }
        do {
            let client = try makeClient()
            let key = KeywordsKey(siteID: siteID, period: period)
            // The six reads are independent, so they go out together. Awaited one after
            // another they cost six round trips end to end, and opening a site tab waited
            // on the sum of them; now it waits on the slowest.
            async let periodLists = lists
                ? Self.periodLists(client, siteID: siteID, period: period, limit: Self.keywordLimit)
                : nil
            async let plan = wantRegistry ? Self.plan(client, siteID: siteID) : nil

            if let fetched = try await periodLists {
                keywords[key] = fetched.queries
                events[key] = fetched.events
                revenue[key] = fetched.revenue
                freshPeriods.insert(key)
            }
            if let fetched = try await plan {
                registry[siteID] = fetched.targets
                // A held report survives a failed refresh, so only an answer replaces
                // one. See `PlanRead` for why the report may be missing.
                if let report = fetched.health {
                    health[siteID] = report
                }
                healthErrors[siteID] = fetched.healthError
                if let report = fetched.proposals {
                    proposals[siteID] = report
                }
                freshRegistries.insert(siteID)
            }
            errors[siteID] = nil
            writeCache(siteID)
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }

    // MARK: Reads

    /// One period's three lists, read together.
    private struct PeriodRead: Sendable {
        let queries: [QueryRow]
        let events: [EventRow]
        let revenue: RevenueReport
    }

    /// The registry and the two reports that read the same plan from other sides, together.
    private struct PlanRead: Sendable {
        let targets: [RegistryTarget]
        /// Nil when the report did not arrive. The registry list is kept anyway: this
        /// endpoint is newer than the registry, so a server that predates it answers a
        /// 404 — and losing the registry over a screen the reader may not even be on
        /// would be the wrong trade.
        let health: RegistryHealthReport?
        /// Why the report is missing, when it is. Kept rather than discarded, because a
        /// screen with no report has to say so rather than describe a plan it cannot see.
        let healthError: String?
        /// Nil when the list could not be read, and no reason is carried: unlike the
        /// health report, an absent proposal list costs the reader nothing — there is
        /// nothing to say about keywords nobody has discovered yet, and "none" is what a
        /// working server sends too.
        let proposals: KeywordProposalsReport?
    }

    /// Off the main actor, so decoding the answers does not compete with drawing.
    private nonisolated static func periodLists(
        _ client: APIClient,
        siteID: Site.ID,
        period: Period,
        limit: Int
    ) async throws -> PeriodRead {
        async let queries = client.queries(siteID: siteID, windowDays: period.days, limit: limit)
        async let events = client.events(siteID: siteID, windowDays: period.days)
        async let revenue = client.revenue(siteID: siteID, windowDays: period.days)
        return PeriodRead(
            queries: try await queries.queries,
            events: try await events.events,
            revenue: try await revenue
        )
    }

    private nonisolated static func plan(
        _ client: APIClient,
        siteID: Site.ID
    ) async throws -> PlanRead {
        async let targets = client.registry(siteID: siteID)
        async let health = client.registryHealth(siteID: siteID)
        async let proposals = client.keywordProposals(siteID: siteID)

        // The registry is the one that decides the read: without it the screens have no
        // list at all. The other two are awaited after it, so a failure there cancels them.
        let list = try await targets.targets
        var report: RegistryHealthReport?
        var reason: String?
        do {
            report = try await health
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            reason = error.localizedDescription
        }
        return PlanRead(
            targets: list,
            health: report,
            healthError: reason,
            proposals: try? await proposals
        )
    }

    /// Sets proposals aside on the server, then drops them from the held list.
    ///
    /// Not optimistic: the rows leave after the server has the decision, because a
    /// dismissal is permanent — a later discovery run will not offer the keyword again —
    /// and a row that vanished from a failed call would read as decided when it is not.
    func dismissProposals(_ keywords: [String], siteID: Site.ID) async {
        guard !keywords.isEmpty else { return }
        do {
            let client = try makeClient()
            try await client.keywordsDismiss(keywords, siteID: siteID)
            guard var report = proposals[siteID] else { return }
            let gone = Set(keywords.map { $0.lowercased() })
            report.proposals.removeAll { gone.contains($0.keyword.lowercased()) }
            // Only the count is recomputed here. The volume is not a sum of the rows:
            // a discovery run returns one query in several word orders and the report
            // counts it once, and that rule lives on the server. Adding the rows up
            // again here is how the screen ends up showing a fifth more demand than
            // the plan has.
            report.totals = ProposalTotals(
                proposals: report.proposals.count,
                monthlyVolume: report.totals.monthlyVolume
            )
            proposals[siteID] = report

            // So the volume comes from a re-read instead. Best-effort: the rows are
            // already gone for certain, and a failed read leaves the volume one
            // dismissal stale rather than wrong by a rule this file does not own.
            if let refreshed = try? await client.keywordProposals(siteID: siteID) {
                proposals[siteID] = refreshed
            }
            writeCache(siteID)
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }

    // MARK: Cache

    /// What is kept on disk for one site: every period's lists and the registry.
    private struct SiteCache: Codable {
        var keywords: [Period.RawValue: [QueryRow]] = [:]
        var events: [Period.RawValue: [EventRow]] = [:]
        var revenue: [Period.RawValue: RevenueReport] = [:]
        var registry: [RegistryTarget]?
        var health: RegistryHealthReport?
        var proposals: KeywordProposalsReport?
    }

    /// Fills whatever the store does not hold yet for the site from disk. Runs once per site;
    /// what the server sends afterwards always wins over what was read.
    private func seedFromCache(_ siteID: Site.ID) {
        guard !seededSites.contains(siteID) else { return }
        seededSites.insert(siteID)
        guard let cached = readCache(siteID) else { return }
        for period in Period.allCases {
            let key = KeywordsKey(siteID: siteID, period: period)
            if keywords[key] == nil, let rows = cached.keywords[period.rawValue] { keywords[key] = rows }
            if events[key] == nil, let rows = cached.events[period.rawValue] { events[key] = rows }
            if revenue[key] == nil, let report = cached.revenue[period.rawValue] { revenue[key] = report }
        }
        if registry[siteID] == nil, let targets = cached.registry {
            registry[siteID] = targets
        }
        if health[siteID] == nil, let cachedHealth = cached.health {
            health[siteID] = cachedHealth
        }
        if proposals[siteID] == nil, let cachedProposals = cached.proposals {
            proposals[siteID] = cachedProposals
        }
    }

    private func cacheURL(_ siteID: Site.ID) -> URL {
        cacheDirectory.appending(path: "\(siteID).json", directoryHint: .notDirectory)
    }

    private func readCache(_ siteID: Site.ID) -> SiteCache? {
        guard let data = try? Data(contentsOf: cacheURL(siteID)) else { return nil }
        return try? JSONDecoder().decode(SiteCache.self, from: data)
    }

    private func writeCache(_ siteID: Site.ID) {
        var cache = SiteCache(
            registry: registry[siteID],
            health: health[siteID],
            proposals: proposals[siteID]
        )
        for period in Period.allCases {
            let key = KeywordsKey(siteID: siteID, period: period)
            cache.keywords[period.rawValue] = keywords[key]
            cache.events[period.rawValue] = events[key]
            cache.revenue[period.rawValue] = revenue[key]
        }
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: cacheURL(siteID), options: .atomic)
        }
    }
}
