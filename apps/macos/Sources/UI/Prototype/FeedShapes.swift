import Foundation

// PROTOTYPE — throwaway. Not for main.
//
// The Live feed's rows, reshaped. Every variant of the feed prototype reads one of the
// shapes below; none of them groups a row, parses an instant or works out an age in its own
// body, because the shapes are rebuilt on every poll (five seconds) and each variant draws
// what it is given in full.
//
// One caveat runs through all of it: the window is half an hour. A Visit that began before
// the window shows only its tail, and a Visit still running has no end. Nothing here may
// read as a finished journey.

/// One page load or one action inside a Visit, in the order it happened.
struct FeedStep: Identifiable, Equatable, Sendable {
    let id: String
    let kind: LiveEvent.Kind
    /// The page for a page load, the event's name for an action.
    let label: String
    let detail: String?
    let at: Date
    /// The same thing again, straight after itself: "×4" rather than four steps. One
    /// visitor reloading a shader page filled a quarter of the shipped feed.
    let repeats: Int
    /// Seconds until the next step. Nil on the last one, which has not ended.
    var dwell: TimeInterval?

    var isEvent: Bool { kind != .pageview }
}

/// One person's slice of the window: their Live events in order, and what the provider
/// knows about them. The domain's Visit, cut by the window at both ends.
struct FeedVisit: Identifiable, Equatable, Sendable {
    let id: String
    let siteID: Site.ID
    let siteName: String
    let visitor: String
    /// A country, a browser and a device — never a name.
    let who: String
    /// The country's flag on its own, for a lane too narrow for the words.
    let flag: String
    /// "🇩🇪 Chrome · Desktop": the same person where the country's name would not fit.
    let compactWho: String
    /// "×7" when the provider counts a returning visitor; nil on a first visit.
    let returns: String?
    let returnsHelp: String?
    /// Oldest first: the way a path is read.
    let steps: [FeedStep]
    let firstAt: Date
    let lastAt: Date
    /// Seen in the last five minutes: the domain's Online.
    let isOnline: Bool
    /// How many of the steps are actions rather than page loads.
    let eventCount: Int
    /// "4m ago", from the screen's timeline.
    let age: String
    /// How long the window has seen them: "6m", "40s".
    let length: String

    var lastStep: FeedStep? { steps.last }
}

/// One page of one site over the window.
struct FeedPage: Identifiable, Equatable, Sendable {
    let id: String
    let siteID: Site.ID
    let page: String
    let views: Int
    /// Distinct visitors, which is the figure that says a crowd from one reloader.
    let people: Int
    /// Actions taken on the page.
    let events: Int
    let lastAt: Date
    /// 1 when the page was last loaded in this minute, falling to 0 at the window's edge.
    let heat: Double
}

/// One site's pages, busiest first: a column of the pressure map.
struct FeedSiteColumn: Identifiable, Equatable, Sendable {
    let id: Site.ID
    let name: String
    let pages: [FeedPage]
    let views: Int
    let events: Int
    /// Distinct visitors in the last five minutes.
    let online: Int
}

/// One walk from one page to the next, by one site's visitors, inside the window.
struct FeedTransition: Identifiable, Equatable, Sendable {
    let id: String
    let siteID: Site.ID
    let from: String
    let to: String
    let count: Int
}

/// One key and value of an event's data.
struct FeedProperty: Identifiable, Equatable, Sendable {
    let id: String
    let key: String
    let value: String
}

/// One named action, with everything needed to read it on its own: what was done, by whom,
/// where, and with what data.
struct FeedSignal: Identifiable, Equatable, Sendable {
    let id: String
    let siteID: Site.ID
    let siteName: String
    let kind: LiveEvent.Kind
    let name: String
    let page: String
    let who: String
    /// "🇩🇪 Chrome · Desktop", for a card too narrow for the country's name.
    let compactWho: String
    let at: Date
    let age: String
    let returns: String?
    let properties: [FeedProperty]
}

/// Everything the variants draw, worked out once per poll.
struct FeedShapes: Equatable, Sendable {
    let windowMinutes: Int
    /// The window's own bounds, measured back from the screen's clock.
    let start: Date
    let end: Date
    /// Newest activity first.
    let visits: [FeedVisit]
    /// One column per site, busiest site first.
    let columns: [FeedSiteColumn]
    /// Most walked first.
    let transitions: [FeedTransition]
    /// Newest first.
    let signals: [FeedSignal]
    /// Page loads per minute over the window, oldest first: the traffic behind the actions.
    let pulse: [Double]
    /// Every shown site's rows, however they are grouped.
    let eventCount: Int

    var isEmpty: Bool { eventCount == 0 }

    /// Seen in the last five minutes.
    static let onlineWindow: TimeInterval = 5 * 60

    /// The shapes for the sites the Overview is kept to.
    ///
    /// The whole build is one pass over the window's events plus a few sorts, and every
    /// string a variant shows is written here: with a thousand rows the shipped feed's
    /// hottest spot was parsing the same instant once per comparison.
    static func make(
        feeds: [Site.ID: LiveFeed],
        sites: [Site],
        only chosen: Set<Site.ID> = [],
        now: Date
    ) -> FeedShapes {
        let windowMinutes = feeds.values.first?.windowMinutes ?? 30
        let start = now.addingTimeInterval(-Double(windowMinutes) * 60)
        let shown = sites.filter { chosen.isEmpty || chosen.contains($0.id) }

        // MARK: One pass over the window

        var dated: [Dated] = []
        for site in shown {
            guard let feed = feeds[site.id] else { continue }
            for event in feed.events {
                guard let date = event.date else { continue }
                dated.append(Dated(site: site, event: event, date: date, history: feed.history(of: event)))
            }
        }
        dated.sort { $0.date < $1.date }

        // MARK: Visits

        var byVisitor: [String: [Dated]] = [:]
        for row in dated {
            byVisitor["\(row.site.id)|\(row.event.visitor)", default: []].append(row)
        }

        var visits: [FeedVisit] = []
        visits.reserveCapacity(byVisitor.count)
        for (key, rows) in byVisitor {
            guard let first = rows.first, let last = rows.last else { continue }
            let steps = self.steps(of: rows)
            visits.append(
                FeedVisit(
                    id: key,
                    siteID: first.site.id,
                    siteName: first.site.name,
                    visitor: first.event.visitor,
                    who: LiveFeedRow(siteID: first.site.id, siteName: first.site.name, event: first.event).who,
                    flag: first.event.country.map(flag) ?? "🌐",
                    compactWho: compact(first.event),
                    returns: LiveFeedRow.visits(first.history),
                    returnsHelp: LiveFeedRow.visitsHelp(first.history),
                    steps: steps,
                    firstAt: first.date,
                    lastAt: last.date,
                    isOnline: now.timeIntervalSince(last.date) < onlineWindow,
                    eventCount: steps.filter(\.isEvent).count,
                    age: RelativeAge.labelOrTime(from: last.date, to: now),
                    length: span(last.date.timeIntervalSince(first.date))
                )
            )
        }
        visits.sort { left, right in
            left.lastAt != right.lastAt ? left.lastAt > right.lastAt : left.id > right.id
        }

        // MARK: Pages, per site

        var pages: [String: (site: Site, page: String, views: Int, events: Int, people: Set<String>, lastAt: Date)] = [:]
        for row in dated {
            let key = "\(row.site.id)|\(row.event.page)"
            var bucket = pages[key] ?? (row.site, row.event.page, 0, 0, [], row.date)
            if row.event.kind == .pageview {
                bucket.views += 1
            } else {
                bucket.events += 1
            }
            bucket.people.insert(row.event.visitor)
            bucket.lastAt = max(bucket.lastAt, row.date)
            pages[key] = bucket
        }

        var columns: [FeedSiteColumn] = []
        for site in shown {
            let own = pages.values
                .filter { $0.site.id == site.id }
                .map { bucket in
                    FeedPage(
                        id: "\(site.id)|\(bucket.page)",
                        siteID: site.id,
                        page: bucket.page,
                        views: bucket.views,
                        people: bucket.people.count,
                        events: bucket.events,
                        lastAt: bucket.lastAt,
                        heat: heat(of: bucket.lastAt, now: now, windowMinutes: windowMinutes)
                    )
                }
                .sorted { left, right in
                    let leftWeight = left.views + left.events
                    let rightWeight = right.views + right.events
                    return leftWeight != rightWeight ? leftWeight > rightWeight : left.page < right.page
                }
            guard !own.isEmpty else { continue }
            let siteVisits = visits.filter { $0.siteID == site.id }
            columns.append(
                FeedSiteColumn(
                    id: site.id,
                    name: site.name,
                    pages: own,
                    views: own.reduce(0) { $0 + $1.views },
                    events: own.reduce(0) { $0 + $1.events },
                    online: siteVisits.filter(\.isOnline).count
                )
            )
        }
        columns.sort { left, right in
            let leftWeight = left.views + left.events
            let rightWeight = right.views + right.events
            return leftWeight != rightWeight ? leftWeight > rightWeight : left.name < right.name
        }

        // MARK: Walks

        var walks: [String: (site: Site.ID, from: String, to: String, count: Int)] = [:]
        for visit in visits {
            let loads = visit.steps.filter { $0.kind == .pageview }
            for (left, right) in zip(loads, loads.dropFirst()) where left.label != right.label {
                let key = "\(visit.siteID)|\(left.label)→\(right.label)"
                var walk = walks[key] ?? (visit.siteID, left.label, right.label, 0)
                walk.count += 1
                walks[key] = walk
            }
        }
        let transitions = walks
            .map { FeedTransition(id: $0.key, siteID: $0.value.site, from: $0.value.from, to: $0.value.to, count: $0.value.count) }
            .sorted { left, right in
                left.count != right.count ? left.count > right.count : left.id < right.id
            }

        // MARK: Actions

        let signals = dated
            .reversed()
            .filter { $0.event.kind != .pageview }
            .map { row -> FeedSignal in
                let words = LiveFeedRow(siteID: row.site.id, siteName: row.site.name, event: row.event, history: row.history)
                return FeedSignal(
                    id: "\(row.site.id)|\(row.event.id)",
                    siteID: row.site.id,
                    siteName: row.site.name,
                    kind: row.event.kind,
                    name: words.primary,
                    page: row.event.page,
                    who: words.who,
                    compactWho: compact(row.event),
                    at: row.date,
                    age: RelativeAge.labelOrTime(from: row.date, to: now),
                    returns: words.visits,
                    properties: row.event.properties
                        .keys
                        .sorted()
                        .map { FeedProperty(id: "\(row.event.id)|\($0)", key: $0, value: row.event.properties[$0] ?? "") }
                )
            }

        // MARK: Pulse

        var pulse = [Double](repeating: 0, count: max(windowMinutes, 1))
        for row in dated where row.event.kind == .pageview {
            let minute = Int(row.date.timeIntervalSince(start) / 60)
            guard minute >= 0, minute < pulse.count else { continue }
            pulse[minute] += 1
        }

        return FeedShapes(
            windowMinutes: windowMinutes,
            start: start,
            end: now,
            visits: visits,
            columns: columns,
            transitions: transitions,
            signals: signals,
            pulse: pulse,
            eventCount: dated.count
        )
    }

    /// One visitor's rows as steps, oldest first, with the same thing twice in a row folded
    /// into one step that says how often, and each step's dwell measured to the next.
    private static func steps(of rows: [Dated]) -> [FeedStep] {
        var steps: [FeedStep] = []
        for row in rows {
            let words = LiveFeedRow(siteID: row.site.id, siteName: row.site.name, event: row.event)
            if let last = steps.last, last.kind == row.event.kind, last.label == words.primary {
                // The step keeps the first instant: "on this page since 5m ago, four loads".
                steps[steps.count - 1] = FeedStep(
                    id: last.id,
                    kind: last.kind,
                    label: last.label,
                    detail: last.detail,
                    at: last.at,
                    repeats: last.repeats + 1,
                    dwell: nil
                )
                continue
            }
            steps.append(
                FeedStep(
                    id: "\(row.site.id)|\(row.event.id)",
                    kind: row.event.kind,
                    label: words.primary,
                    detail: words.detail,
                    at: row.date,
                    repeats: 1,
                    dwell: nil
                )
            )
        }
        for index in steps.indices.dropLast() {
            steps[index].dwell = steps[index + 1].at.timeIntervalSince(steps[index].at)
        }
        return steps
    }

    /// A row with its instant parsed once and its site named. Declared beside the shapes so
    /// the private helpers can take it.
    private struct Dated {
        let site: Site
        let event: LiveEvent
        let date: Date
        let history: VisitorHistory?
    }

    /// How fresh a page is, 1 in this minute and 0 at the window's edge.
    static func heat(of date: Date, now: Date, windowMinutes: Int) -> Double {
        let age = now.timeIntervalSince(date)
        let window = max(Double(windowMinutes) * 60, 1)
        return max(0, min(1, 1 - age / window))
    }

    /// "40s", "6m", "1h 4m": a length, not a clock time.
    static func span(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        if whole < 60 { return "\(whole)s" }
        if whole < 3600 { return "\(whole / 60)m" }
        return "\(whole / 3600)h \((whole % 3600) / 60)m"
    }

    /// "🇩🇪 Chrome · Desktop": the flag rather than the country's name, which is what a lane
    /// label or a card footer has room for.
    static func compact(_ event: LiveEvent) -> String {
        let parts = [event.browser, event.device?.capitalized].compactMap { $0 }
        let words = parts.joined(separator: " · ")
        guard let code = event.country else { return words.isEmpty ? "Unknown" : words }
        return words.isEmpty ? flag(code) : "\(flag(code)) \(words)"
    }

    /// A string cut to a length, with the middle taken out: "/eu/silvermoon/dirith" stays
    /// readable at both ends. `Canvas` text cannot truncate itself, so the cut is made here.
    static func short(_ text: String, limit: Int) -> String {
        guard text.count > limit, limit > 4 else { return text }
        let head = (limit - 1) / 2
        let tail = limit - 1 - head
        return "\(text.prefix(head))…\(text.suffix(tail))"
    }

    /// "🇪🇸" from an ISO code: two regional indicator symbols.
    static func flag(_ code: String) -> String {
        let upper = code.uppercased()
        guard upper.count == 2 else { return "🌐" }
        return upper.unicodeScalars
            .compactMap { UnicodeScalar(0x1F1E6 + $0.value - 0x41) }
            .map { String(Character($0)) }
            .joined()
    }
}
