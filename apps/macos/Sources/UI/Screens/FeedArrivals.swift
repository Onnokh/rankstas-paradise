import Foundation

/// Which rows of the Live feed have just arrived, so the card can draw them arriving.
///
/// A row arrives when its person's newest event is one this client has not seen: a new
/// visitor, or a known visitor with a new step. The rows are ordered by their newest event,
/// so the two look the same — a row at the top that was not there a moment ago, with a
/// headline that was not there either — and they are treated the same. A row whose oldest
/// event fell out of the window has a new id but nothing new to say; it does not arrive
/// again.
///
/// Neither does the first fill, nor the rows a change of kind uncovers: they were there
/// before this client looked. Nor a row whose newest event is older than `recent`, as when
/// a site answers late — arriving means just now.
struct FeedArrivals: Sendable {
    /// How long ago the newest event may be for its row to count as arriving. Generous
    /// against the provider's lag; short against a site that answers a poll late.
    static let recent: TimeInterval = 90

    /// The newest event's instant this client has seen, by run: one site, one visitor.
    private var seen: [String: Date] = [:]
    /// The kinds the seen rows were of. A change primes rather than announces.
    private var kinds: FeedKinds?
    /// The rows that arrived on the latest note and have not settled yet.
    private(set) var fresh: Set<LiveFeedRow.ID> = []

    /// Take note of the rows a poll gave. Any row whose newest event this client has not
    /// seen, from the last `recent` seconds, is fresh until `settle()`.
    mutating func note(_ rows: [LiveFeedRow], kinds: FeedKinds, at now: Date) {
        let primes = self.kinds != kinds
        self.kinds = kinds
        var next: [String: Date] = [:]
        var arrived: Set<LiveFeedRow.ID> = []
        for row in rows {
            let run = "\(row.siteID)|\(row.visitor)"
            let isNew = row.newestAt > (seen[run] ?? .distantPast)
            if !primes, isNew, now.timeIntervalSince(row.newestAt) < Self.recent {
                arrived.insert(row.id)
            }
            next[run] = max(next[run] ?? .distantPast, row.newestAt)
        }
        seen = next
        fresh = arrived
    }

    /// The fresh rows have been drawn arriving; let them go.
    mutating func settle() {
        fresh = []
    }
}
