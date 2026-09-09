import Foundation
import SwiftUI

/// What a Log entry records. Five of the six are Actions — a concrete change made to a page
/// so a before/after window can be compared — and the sixth is a Note, which changed nothing.
///
/// The raw values are the server's own words, so a kind decodes straight off the wire. A
/// build that meets a word it does not know shows the word rather than dropping the row: the
/// entry still happened, and hiding it would understate the work done on a page.
enum LogKind: String, CaseIterable, Identifiable, Sendable {
    case publish
    case contentUpdate = "content-update"
    case titleChange = "title-change"
    case internalLinks = "internal-links"
    case consolidation
    case note

    var id: Self { self }

    var label: String {
        switch self {
        case .publish: "Publish"
        case .contentUpdate: "Content update"
        case .titleChange: "Title change"
        case .internalLinks: "Internal links"
        case .consolidation: "Consolidation"
        case .note: "Note"
        }
    }

    /// The TUI's icon for the kind, in SF Symbols. The two clients name the same thing, so a
    /// reader moving between them recognises a row by its shape.
    var symbol: String {
        switch self {
        case .publish: "paperplane"
        case .contentUpdate: "doc.text"
        case .titleChange: "textformat"
        case .internalLinks: "link"
        case .consolidation: "arrow.triangle.merge"
        case .note: "text.bubble"
        }
    }

    /// Whether the entry changed the page. A Note is the one kind that did not, and the
    /// screen sets it back for exactly that reason.
    var isAction: Bool { self != .note }

    /// The badge's colour. Publishing a page is the move the whole plan is built on, so it
    /// carries the accent; the other actions share the amber of work in progress, and a note
    /// stays out of the way.
    var tint: Color {
        switch self {
        case .publish: Palette.acid
        case .contentUpdate, .titleChange, .internalLinks, .consolidation: Palette.amber
        case .note: .secondary
        }
    }

    /// What the kind means, for the badge's tooltip.
    var meaning: String {
        switch self {
        case .publish: "The page went live."
        case .contentUpdate: "The page's content was changed."
        case .titleChange: "The page's title or meta description was changed."
        case .internalLinks: "Links pointing at the page were changed."
        case .consolidation: "The page absorbed another, or was merged into one."
        case .note: "An annotation. Nothing on the page changed."
        }
    }
}

extension LogEntry {
    /// The kind as this build knows it, or nil for a word it does not. Nil is not an error:
    /// the screen shows the server's word plainly and the row keeps its place.
    var knownKind: LogKind? { LogKind(rawValue: kind) }

    /// The kind's label, or the server's own word when this build does not know it.
    var kindLabel: String { knownKind?.label ?? kind }

    /// Whether the entry changed the page. An unknown kind is read as an Action: every kind
    /// the server has ever had except `note` is one, so that is the safer reading — and it
    /// keeps an unknown row out of the note count rather than inflating it.
    var isAction: Bool { knownKind?.isAction ?? true }
}

/// How many entries of each sort the record holds, and when the last one was. The Log's
/// headline, worked out in one pass so the screen's summary line is not four filters.
struct LogTally: Equatable, Sendable {
    let entries: Int
    let actions: Int
    let notes: Int
    /// The newest entry's date, "YYYY-MM-DD". Nil for an empty record.
    let latest: String?

    /// How many pages the record touches. The Log is attached to pages, so this is the
    /// figure that says whether the work is spread or concentrated.
    let pages: Int
}

/// One day of the Log, with the entries recorded against it. The screen draws the record as
/// a timeline rather than a table, because a day is the unit the work was done in and two
/// entries on the same day are one visit to the site.
struct LogDay: Identifiable, Equatable, Sendable {
    let date: String
    let entries: [LogEntry]

    var id: String { date }
}

/// The Log as the screen shows it: the server's entries narrowed by what the reader asked
/// for, then grouped by day. A pure function of its inputs, so the screen holds no list of
/// its own and a refresh replaces the rows under the same order.
enum LogList {
    /// - Parameters:
    ///   - kinds: keeps only entries of these kinds. Empty keeps every one, which is the
    ///     honest default: the reader has not said what they are looking for yet. An entry
    ///     whose kind this build does not know is kept only when nothing is selected —
    ///     it cannot be claimed to match a kind it was never matched against.
    ///   - path: keeps only entries against this exact page. Nil keeps every one.
    ///   - search: matched against the path, the note and the kind's label,
    ///     case-insensitively. Blank matches every entry.
    static func rows(
        _ entries: [LogEntry],
        kinds: Set<LogKind> = [],
        path: String? = nil,
        search: String = ""
    ) -> [LogEntry] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        let kept = entries.filter { entry in
            if let path, entry.path != path { return false }
            if !kinds.isEmpty {
                guard let known = entry.knownKind, kinds.contains(known) else { return false }
            }
            guard !needle.isEmpty else { return true }
            if entry.path.lowercased().contains(needle) { return true }
            if entry.note.lowercased().contains(needle) { return true }
            return entry.kindLabel.lowercased().contains(needle)
        }
        // The server's own order, restated rather than trusted: newest day first, and the
        // last entry written first among a day's own. A cached list and a fresh one then
        // read the same whichever arrived first.
        return kept.sorted { left, right in
            left.date == right.date ? left.id > right.id : left.date > right.date
        }
    }

    /// The rows as a timeline, newest day first. Expects the rows `rows(_:)` returned, and
    /// keeps their order inside each day.
    static func days(_ rows: [LogEntry]) -> [LogDay] {
        var order: [String] = []
        var byDate: [String: [LogEntry]] = [:]
        for row in rows {
            if byDate[row.date] == nil { order.append(row.date) }
            byDate[row.date, default: []].append(row)
        }
        return order.map { LogDay(date: $0, entries: byDate[$0] ?? []) }
    }

    /// What the record holds, counted once.
    static func tally(_ entries: [LogEntry]) -> LogTally {
        let actions = entries.filter(\.isAction).count
        return LogTally(
            entries: entries.count,
            actions: actions,
            notes: entries.count - actions,
            latest: entries.map(\.date).max(),
            pages: Set(entries.map(\.path)).count
        )
    }

    /// How many entries of each kind the record holds, for the filter chips. Counted before
    /// the kind filter, so a chip's figure does not change as chips are pressed.
    static func kindCounts(_ entries: [LogEntry]) -> [LogKind: Int] {
        var counts: [LogKind: Int] = [:]
        for entry in entries {
            guard let kind = entry.knownKind else { continue }
            counts[kind, default: 0] += 1
        }
        return counts
    }

    /// The day's date as the timeline heads it: the weekday and the day for a date in this
    /// year, with the year added once it is not. Nil when the text is not a date at all,
    /// which leaves the screen showing the server's own string.
    static func dayLabel(_ date: String, today: Date = .now, calendar: Calendar = .current) -> String? {
        guard let parsed = parse(date, calendar: calendar) else { return nil }
        if calendar.isDate(parsed, inSameDayAs: today) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today),
           calendar.isDate(parsed, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        // Two styles rather than one with an omitted year: `.omitted` needs macOS 15, and
        // this app runs from 14.
        let sameYear = calendar.component(.year, from: parsed) == calendar.component(.year, from: today)
        return sameYear
            ? parsed.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
            : parsed.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
    }

    /// When an entry was written, as an instant.
    ///
    /// `created_at` defaults to SQLite's own `current_timestamp`, which is
    /// "YYYY-MM-DD HH:MM:SS" in UTC with no zone written on it — not the ISO 8601 instant
    /// every other timestamp in this app carries. Read as local it lands hours out, and near
    /// midnight that names the wrong day, so the space form is read as UTC. An ISO value is
    /// read too: only the column's *default* produces the space form, and an entry written
    /// with an explicit value would carry the other.
    static func recordedAt(_ createdAt: String) -> Date? {
        if let instant = Instant.parse(createdAt) { return instant }
        let parser = DateFormatter()
        parser.dateFormat = "yyyy-MM-dd HH:mm:ss"
        parser.timeZone = .gmt
        parser.locale = Locale(identifier: "en_US_POSIX")
        return parser.date(from: createdAt)
    }

    /// A "YYYY-MM-DD" day as a date in the reader's own zone. The Log's dates are days, not
    /// instants: the day the work was done, wherever the person doing it was.
    static func parse(_ date: String, calendar: Calendar = .current) -> Date? {
        let parts = date.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
            return nil
        }
        return calendar.date(from: DateComponents(year: year, month: month, day: day))
    }
}
