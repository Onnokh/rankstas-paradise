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
    /// What the server knows about the people behind those rows, by visitor token: how many
    /// visits each has made, all time. Kept beside the rows rather than on them because one
    /// person owns many rows and the figure is the same on every one.
    private(set) var visitors: [String: VisitorHistory]
    /// When the server last asked the provider; nil before the first answer.
    private(set) var fetchedAt: Date?

    init(
        windowMinutes: Int,
        events: [LiveEvent] = [],
        visitors: [String: VisitorHistory] = [:],
        fetchedAt: Date? = nil
    ) {
        self.windowMinutes = windowMinutes
        self.events = events
        self.visitors = visitors
        self.fetchedAt = fetchedAt
    }

    /// What the server knows about the person behind a row; nil when it said nothing.
    func history(of event: LiveEvent) -> VisitorHistory? { visitors[event.visitor] }

    /// The cut-off for the next poll: the newest row's instant, so the server only sends
    /// what is newer. Nil until there is a row, which asks for the whole window.
    var newestAt: String? { events.first?.at }

    /// This feed with a poll's rows folded in. Rows older than the window, measured from the
    /// answer's `fetchedAt` (or `now` when that does not parse), are dropped.
    ///
    /// Visitor histories fold in the same way, and are then kept to the people who still have
    /// a row: the server sends the window's whole cast on every poll, so a visitor with
    /// nothing left on screen is one whose figures nothing can ask for again.
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

        // An older server sends no histories at all, which must not throw away the ones this
        // feed already holds; it just means no poll adds to them.
        var histories = visitors
        for history in update.visitors ?? [] { histories[history.visitor] = history }
        let shown = Set(merged.map(\.visitor))
        histories = histories.filter { shown.contains($0.key) }

        return LiveFeed(
            windowMinutes: update.windowMinutes,
            events: Array(merged),
            visitors: histories,
            fetchedAt: fetched
        )
    }
}

/// One step of a visitor's run: a page they loaded or a thing they did, with the words the
/// feed shows for it worked out once. The same page loaded again straight after itself is
/// one step that counts, not two steps.
struct LiveFeedStep: Identifiable, Equatable, Sendable {
    /// The Live event's own id.
    let id: String
    let kind: LiveEvent.Kind
    let at: Date
    /// The clock time, in the local zone.
    let time: String
    /// The page for a page load, the name for an action, the link for an outbound click,
    /// the control's text for the rest. Paths are shown decoded: "/eu/bãrlah", not "%C3%A3".
    let primary: String
    /// What goes with it: where a page load came from, an action's data, the page the rest
    /// happened on. Nil when there is nothing to add.
    let detail: String?
    /// How many times in a row this same thing happened. One is the ordinary case.
    var repeats: Int

    var isAction: Bool { kind.isAction }
}

/// One row of the overview's feed: one visitor's run through one site — every Live event of
/// theirs that is within `gap` of the next — and the words the row shows, worked out once
/// here rather than every time the screen draws. The screen's rows are rebuilt on every
/// poll, so a row's body must be trivial: text in, text out.
///
/// The row is about the run's newest step. That is its headline; the steps before it are
/// said in one caption, and the whole run is the tooltip's.
struct LiveFeedRow: Identifiable, Equatable, Sendable {
    /// Two Live events of one visitor further apart than this are two runs, not one. Ten
    /// minutes: long enough that a page read slowly is still one run, short enough that
    /// somebody who came back after lunch is a new row at the top rather than a change to a
    /// row far down.
    static let gap: TimeInterval = 10 * 60

    let siteID: Site.ID
    let siteName: String
    /// The same for every row of one person; never a name.
    let visitor: String
    /// Oldest first. Never empty: the last is what the row is about.
    let steps: [LiveFeedStep]
    /// The instant of the run's newest event: the row's place in the order, and its age. Not
    /// the newest step's `at` — a step somebody reloads keeps its first instant, and a row
    /// aged by that sat above rows that were younger than it.
    let newestAt: Date
    /// What the row says, large: the newest step. A click out carries an arrow, because
    /// leaving is a move and not a thing done here.
    let headline: String
    /// Whether the headline is a thing done rather than a page loaded: the one colour.
    let isAction: Bool
    /// Everything else about the run, in one line: "after /shaders · 3 steps", or "from
    /// google.com" for a first page whose referrer is known, or "loaded 3 times" for a page
    /// somebody sat on. Empty when there is nothing to add.
    let caption: String
    /// The country as one glyph, for the end of the row. Empty when the provider does not say.
    let flag: String
    /// Who, as far as it is said: a country, a browser and a device, for the tooltip.
    let who: String
    /// How many visits this person has made, all time — "×7" — on the rows of someone who
    /// has been here before. Nil on a first visit, which is the ordinary case and needs no
    /// label, and nil when the provider says nothing about them; the slot is empty either
    /// way, so an empty slot is never a claim.
    let visits: String?
    /// The same figure in words, for the tooltip: "7 visits since 12 August".
    let visitsHelp: String?

    /// Stable while the run lasts: the run's oldest event names it, and a run only grows at
    /// its newest end. The visitor is in it too, because one person can have two runs.
    var id: String { "\(siteID)|\(visitor)|\(steps[0].id)" }

    var newest: LiveFeedStep { steps[steps.count - 1] }

    /// A row from one visitor's events on one site, oldest first. Empty input is a caller's
    /// mistake, not a state a row can be in.
    init(siteID: Site.ID, siteName: String, events: [LiveEvent], history: VisitorHistory? = nil) {
        precondition(!events.isEmpty, "a feed row is at least one event")
        self.siteID = siteID
        self.siteName = siteName
        visitor = events[0].visitor
        steps = Self.steps(of: events)
        let newest = steps[steps.count - 1]
        let last = events[events.count - 1]
        newestAt = last.date ?? .distantPast
        headline = newest.kind == .outbound ? "→ \(newest.primary)" : newest.primary
        isAction = newest.isAction
        caption = Self.caption(of: steps)
        flag = last.country.map(Self.flag) ?? ""
        who = [last.country.map(Self.place), last.browser, last.device?.capitalized]
            .compactMap { $0 }
            .joined(separator: " · ")
        visits = Self.visits(history)
        visitsHelp = Self.visitsHelp(history)
    }

    /// Every site's feed as one stream of rows, newest first, kept to the sites `only` names
    /// when it names any, and without the kinds in `hiding`. At most `limit` rows: the
    /// screen's, not the window's. The screen draws every row it is given, so the cap is
    /// what keeps a busy site cheap.
    ///
    /// The kinds are filtered before the runs are made, so "Events" is one row per person
    /// with only their actions in it, and their page loads do not decide where the row sits.
    static func rows(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only chosen: Set<Site.ID> = [],
        hiding hidden: Set<LiveEvent.Kind> = [],
        limit: Int = 100
    ) -> [LiveFeedRow] {
        // Each instant is parsed once, beside its event, not once per comparison.
        var dated: [(site: Site, event: LiveEvent, date: Date)] = []
        for site in sites where chosen.isEmpty || chosen.contains(site.id) {
            for event in feeds[site.id]?.events ?? [] where !hidden.contains(event.kind) {
                dated.append((site: site, event: event, date: event.date ?? .distantPast))
            }
        }
        dated.sort { left, right in
            left.date != right.date ? left.date > right.date : left.event.id > right.event.id
        }

        // Newest first, so a run is met at its newest step and takes its place in the order
        // there. Each older event of the same person joins that run while it is within the
        // gap of the run's oldest step; past the gap it opens a new run further down.
        var runs: [(site: Site, events: [LiveEvent], oldest: Date)] = []
        var open: [String: Int] = [:]
        for entry in dated {
            let key = "\(entry.site.id)|\(entry.event.visitor)"
            if let index = open[key], runs[index].oldest.timeIntervalSince(entry.date) < gap {
                runs[index].events.append(entry.event)
                runs[index].oldest = entry.date
            } else {
                runs.append((site: entry.site, events: [entry.event], oldest: entry.date))
                open[key] = runs.count - 1
            }
        }

        return runs.prefix(limit).map { run in
            LiveFeedRow(
                siteID: run.site.id,
                siteName: run.site.name,
                events: run.events.reversed(),
                history: feeds[run.site.id]?.history(of: run.events[0])
            )
        }
    }

    /// How many events of each kind the stream has before the kind filter, for a filter's rows.
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

    // MARK: Steps

    /// One visitor's events, oldest first, as steps: the same thing twice in a row is one
    /// step that counts. The step keeps its first instant, so its age says how long they
    /// have been on it.
    static func steps(of events: [LiveEvent]) -> [LiveFeedStep] {
        var steps: [LiveFeedStep] = []
        for event in events {
            let primary = primary(of: event)
            if let last = steps.last, last.kind == event.kind, last.primary == primary {
                steps[steps.count - 1].repeats += 1
                continue
            }
            steps.append(LiveFeedStep(
                id: event.id,
                kind: event.kind,
                at: event.date ?? .distantPast,
                time: event.date?.formatted(date: .omitted, time: .standard) ?? "—",
                primary: primary,
                detail: detail(of: event),
                repeats: 1
            ))
        }
        return steps
    }

    // MARK: Words

    /// The run in one line under the headline. Only the step before the newest is named, in
    /// full: two, shortened, cut paths in the middle of a word, and the whole run is the
    /// tooltip's. A run of one step says what the step itself has to add — where a page load
    /// came from, what page an action was on — and nothing at all when that is nothing.
    static func caption(of steps: [LiveFeedStep]) -> String {
        var parts: [String] = []
        let newest = steps[steps.count - 1]
        if newest.repeats > 1 {
            parts.append("loaded \(newest.repeats) times")
        }
        if steps.count > 1 {
            parts.append("after \(steps[steps.count - 2].primary)")
            if steps.count > 2 {
                parts.append("\(steps.count) steps")
            }
        } else if let detail = newest.detail {
            parts.append(detail)
        }
        return parts.joined(separator: "  ·  ")
    }

    /// "×7" on the rows of someone here for the seventh time. Nil on a first visit and nil
    /// when the provider does not count this person: only a return is worth a mark, and the
    /// feed is dense enough that labelling the ordinary case would be noise. A count below
    /// one is a vendor's own oddity, and reads as the first visit it must be.
    static func visits(_ history: VisitorHistory?) -> String? {
        guard let visits = history?.visits, visits > 1 else { return nil }
        return "×\(visits)"
    }

    static func visitsHelp(_ history: VisitorHistory?) -> String? {
        guard let visits = history?.visits, visits > 1 else { return nil }
        let since = history?.firstSeenDate.map {
            " since \($0.formatted(date: .abbreviated, time: .omitted))"
        } ?? ""
        return "\(visits) visits\(since)"
    }

    static func primary(of event: LiveEvent) -> String {
        switch event.kind {
        case .pageview:
            readable(event.page)
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
            "on \(readable(event.page))"
        }
    }

    /// "/eu/ravencrest/bãrlah", not "/eu/ravencrest/b%C3%A3rlah": a path is read, not sent.
    static func readable(_ path: String) -> String {
        path.removingPercentEncoding ?? path
    }

    /// "🇪🇸" from an ISO code: two regional indicator symbols. Empty for anything that is
    /// not a region the system knows — a provider also sends codes like "T1" (an anonymous
    /// proxy) and "EU", and the two indicators of those have no flag to become. They drew as
    /// two boxes, and at the row's size the boxes wrapped and made the row taller.
    static func flag(_ code: String) -> String {
        let upper = code.uppercased()
        guard upper.count == 2, Locale.Region.isoRegions.contains(Locale.Region(upper)) else { return "" }
        return upper.unicodeScalars
            .compactMap { UnicodeScalar(0x1F1E6 + $0.value - 0x41) }
            .map { String(Character($0)) }
            .joined()
    }

    /// "🇪🇸 Spain" from an ISO code.
    static func place(_ code: String) -> String {
        let upper = code.uppercased()
        let name = Locale.current.localizedString(forRegionCode: upper) ?? upper
        let flag = flag(upper)
        return flag.isEmpty ? name : "\(flag) \(name)"
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
