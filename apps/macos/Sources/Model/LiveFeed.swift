import Foundation

/// One site's live feed as the client keeps it between polls. The server sends the whole
/// half-hour window once, then only what is newer than the newest row here, and the rows
/// merge by id: the same row twice is one row, and rows that have left the window go.
/// A value, not a store, so the merge and the filters are testable on their own.
struct LiveFeed: Equatable, Sendable {
    /// At most this many rows are kept, the server's own cap: the window of a busy site.
    static let limit = 500

    let windowMinutes: Int
    /// Newest first.
    private(set) var events: [LiveEvent]
    /// When the server last asked the provider; nil before the first answer.
    private(set) var fetchedAt: Date?

    init(windowMinutes: Int, events: [LiveEvent] = [], fetchedAt: Date? = nil) {
        self.windowMinutes = windowMinutes
        self.events = events
        self.fetchedAt = fetchedAt
    }

    /// The cut-off for the next poll: the newest row's instant, so the server only sends
    /// what is newer. Nil until there is a row, which asks for the whole window.
    var newestAt: String? { events.first?.at }

    /// This feed with a poll's rows folded in. Rows older than the window, measured from the
    /// answer's `fetchedAt` (or `now` when that does not parse), are dropped.
    func merging(_ update: LiveEvents, now: Date = .now) -> LiveFeed {
        let fetched = Instant.parse(update.fetchedAt) ?? now
        let cutoff = fetched.addingTimeInterval(-Double(update.windowMinutes) * 60)

        var byID: [String: LiveEvent] = [:]
        for event in events { byID[event.id] = event }
        for event in update.events { byID[event.id] = event }

        let merged = byID.values
            .filter { ($0.date ?? fetched) >= cutoff }
            .sorted { left, right in
                let leftDate = left.date ?? .distantPast
                let rightDate = right.date ?? .distantPast
                return leftDate != rightDate ? leftDate > rightDate : left.id > right.id
            }
            .prefix(Self.limit)
        return LiveFeed(windowMinutes: update.windowMinutes, events: Array(merged), fetchedAt: fetched)
    }
}

/// One row of the overview's feed: an event, and the site it happened on.
struct LiveFeedRow: Identifiable, Equatable, Sendable {
    let siteID: Site.ID
    let siteName: String
    let event: LiveEvent

    var id: String { "\(siteID)|\(event.id)" }

    /// Every site's feed as one stream, newest first, kept to one site when `only` names it and
    /// without the kinds in `hiding`. At most `limit` rows: the screen's, not the window's.
    static func rows(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only siteID: Site.ID? = nil,
        hiding hidden: Set<LiveEvent.Kind> = [],
        limit: Int = 200
    ) -> [LiveFeedRow] {
        let rows = sites
            .filter { siteID == nil || $0.id == siteID }
            .flatMap { site in
                (feeds[site.id]?.events ?? [])
                    .filter { !hidden.contains($0.kind) }
                    .map { LiveFeedRow(siteID: site.id, siteName: site.name, event: $0) }
            }
            .sorted { left, right in
                let leftDate = left.event.date ?? .distantPast
                let rightDate = right.event.date ?? .distantPast
                return leftDate != rightDate ? leftDate > rightDate : left.id > right.id
            }
        return Array(rows.prefix(limit))
    }

    /// How many rows of each kind the stream has before the kind filter, for the chips.
    static func kindCounts(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only siteID: Site.ID? = nil
    ) -> [LiveEvent.Kind: Int] {
        var counts: [LiveEvent.Kind: Int] = [:]
        for site in sites where siteID == nil || site.id == siteID {
            for event in feeds[site.id]?.events ?? [] {
                counts[event.kind, default: 0] += 1
            }
        }
        return counts
    }
}
