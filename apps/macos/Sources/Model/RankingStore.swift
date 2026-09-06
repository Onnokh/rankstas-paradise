import Foundation
import Observation

/// The two ranked lists under a site's chart: its keywords for the chosen period, and its
/// registry targets. The lists are held in the server's order; the cards rank them.
///
/// In-memory only. Keywords are keyed by site and period, so switching the period back shows
/// the list at once; a refresh drops what is held for the site and fetches again.
@MainActor
@Observable
final class RankingStore {
    struct KeywordsKey: Hashable {
        let siteID: Site.ID
        let period: Period
    }

    private(set) var keywords: [KeywordsKey: [QueryRow]] = [:]
    private(set) var registry: [Site.ID: [RegistryTarget]] = [:]
    private(set) var errors: [Site.ID: String] = [:]
    private(set) var loading: Set<Site.ID> = []

    /// Rows a card shows.
    static let rowLimit = 10
    /// Keywords fetched per period: enough that the top ten by either metric are in the set.
    static let keywordLimit = 50

    @ObservationIgnored private let makeClient: @Sendable () throws -> APIClient

    init(makeClient: @escaping @Sendable () throws -> APIClient = { APIClient(target: try ClientConfiguration.load()) }) {
        self.makeClient = makeClient
    }

    /// Fetches whatever is missing for the site at this period.
    func load(_ siteID: Site.ID, period: Period) async {
        let key = KeywordsKey(siteID: siteID, period: period)
        let needsKeywords = keywords[key] == nil
        let needsRegistry = registry[siteID] == nil
        guard needsKeywords || needsRegistry else { return }
        await fetch(siteID, period: period, keywords: needsKeywords, registry: needsRegistry)
    }

    /// Drops what is held for the site and fetches both lists again.
    func refresh(_ siteID: Site.ID, period: Period) async {
        keywords = keywords.filter { $0.key.siteID != siteID }
        registry[siteID] = nil
        await fetch(siteID, period: period, keywords: true, registry: true)
    }

    private func fetch(_ siteID: Site.ID, period: Period, keywords wantKeywords: Bool, registry wantRegistry: Bool) async {
        guard !loading.contains(siteID) else { return }
        loading.insert(siteID)
        defer { loading.remove(siteID) }
        do {
            let client = try makeClient()
            if wantKeywords {
                let report = try await client.queries(siteID: siteID, windowDays: period.days, limit: Self.keywordLimit)
                keywords[KeywordsKey(siteID: siteID, period: period)] = report.queries
            }
            if wantRegistry {
                let report = try await client.registry(siteID: siteID)
                registry[siteID] = report.targets
            }
            errors[siteID] = nil
        } catch is CancellationError {
            return
        } catch {
            errors[siteID] = error.localizedDescription
        }
    }
}
