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

        // Each instant is parsed once, not once per comparison: with hundreds of rows the
        // sort was the feed's single hottest spot.
        let dated = byID.values.map { (event: $0, date: $0.date ?? fetched) }
        let merged = dated
            .filter { $0.date >= cutoff }
            .sorted { left, right in
                left.date != right.date ? left.date > right.date : left.event.id > right.event.id
            }
            .prefix(Self.limit)
            .map { $0.event }
        return LiveFeed(windowMinutes: update.windowMinutes, events: Array(merged), fetchedAt: fetched)
    }
}

/// One row of the overview's feed: an event, the site it happened on, and the words the row
/// shows, worked out once here rather than every time the screen draws. The screen's rows are
/// rebuilt on every poll, so a row's body must be trivial: text in, text out.
struct LiveFeedRow: Identifiable, Equatable, Sendable {
    let siteID: Site.ID
    let siteName: String
    let event: LiveEvent
    /// The clock time, in the local zone.
    let time: String
    /// The row's subject: the page for a pageview, the name for an event, the link for an
    /// outbound click, the control's text for the rest.
    let primary: String
    /// What goes with it: where a pageview came from, an event's data, the page the rest
    /// happened on. Nil when there is nothing to add.
    let detail: String?
    /// Who, as far as it is said: a country, a browser and a device.
    let who: String

    var id: String { "\(siteID)|\(event.id)" }

    init(siteID: Site.ID, siteName: String, event: LiveEvent) {
        self.siteID = siteID
        self.siteName = siteName
        self.event = event
        time = event.date?.formatted(date: .omitted, time: .standard) ?? "—"
        primary = Self.primary(of: event)
        detail = Self.detail(of: event)
        who = [event.country.map(Self.place), event.browser, event.device?.capitalized]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// Every site's feed as one stream, newest first, kept to the sites `only` names when it
    /// names any, and without the kinds in `hiding`. At most `limit` rows: the screen's, not
    /// the window's. The screen draws every row it is given, so the cap is what keeps a busy
    /// site cheap.
    static func rows(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only chosen: Set<Site.ID> = [],
        hiding hidden: Set<LiveEvent.Kind> = [],
        limit: Int = 100
    ) -> [LiveFeedRow] {
        // Each instant is parsed once, beside its row, not once per comparison.
        var dated: [(row: LiveFeedRow, date: Date)] = []
        for site in sites where chosen.isEmpty || chosen.contains(site.id) {
            for event in feeds[site.id]?.events ?? [] where !hidden.contains(event.kind) {
                let row = LiveFeedRow(siteID: site.id, siteName: site.name, event: event)
                dated.append((row: row, date: event.date ?? .distantPast))
            }
        }
        dated.sort { left, right in
            left.date != right.date ? left.date > right.date : left.row.id > right.row.id
        }
        return dated.prefix(limit).map { $0.row }
    }

    /// How many rows of each kind the stream has before the kind filter, for a filter's rows.
    static func kindCounts(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only chosen: Set<Site.ID> = []
    ) -> [LiveEvent.Kind: Int] {
        var counts: [LiveEvent.Kind: Int] = [:]
        for site in sites where chosen.isEmpty || chosen.contains(site.id) {
            for event in feeds[site.id]?.events ?? [] {
                counts[event.kind, default: 0] += 1
            }
        }
        return counts
    }

    // MARK: Words

    static func primary(of event: LiveEvent) -> String {
        switch event.kind {
        case .pageview:
            event.page
        case .event:
            event.name ?? "event"
        case .outbound:
            event.properties["url"].map(shortURL) ?? event.name ?? "Outbound link"
        case .buttonClick, .copy, .formSubmit, .inputChange:
            event.properties["text"] ?? event.name ?? event.kind.label
        }
    }

    static func detail(of event: LiveEvent) -> String? {
        switch event.kind {
        case .pageview:
            event.referrer.flatMap(host).map { "from \($0)" }
        case .event:
            data(event.properties)
        case .outbound, .buttonClick, .copy, .formSubmit, .inputChange:
            "on \(event.page)"
        }
    }

    /// "🇪🇸 Spain" from an ISO code: the flag is two regional indicator symbols.
    static func place(_ code: String) -> String {
        let upper = code.uppercased()
        let flag = upper.unicodeScalars
            .compactMap { UnicodeScalar(0x1F1E6 + $0.value - 0x41) }
            .map { String(Character($0)) }
            .joined()
        let name = Locale.current.localizedString(forRegionCode: upper) ?? upper
        return upper.count == 2 ? "\(flag) \(name)" : name
    }

    static func host(_ urlString: String) -> String? {
        URL(string: urlString)?.host()?.replacingOccurrences(of: "www.", with: "")
    }

    /// "github.com/onnokh/sleevy": the host and path, without the scheme and query.
    static func shortURL(_ urlString: String) -> String {
        guard let url = URL(string: urlString), let rawHost = url.host() else { return urlString }
        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        let path = url.path().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return path.isEmpty ? host : "\(host)/\(path)"
    }

    /// The first few properties as "key value" pairs; nil when there are none.
    static func data(_ properties: [String: String]) -> String? {
        let pairs = properties.keys.sorted().prefix(3).map { "\($0) \(properties[$0] ?? "")" }
        return pairs.isEmpty ? nil : pairs.joined(separator: ", ")
    }
}
