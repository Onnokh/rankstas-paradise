import SwiftUI

/// Sub-screen showing a site's work record: every Action taken on one of its pages and every
/// Note written beside one, newest first.
///
/// Drawn as a timeline rather than a table. The other lists here are rankings — a table is
/// the right shape for "which page is strongest" — but the Log answers "what did we do, and
/// when", and its unit is the day. Two entries on the same day were one visit to the site,
/// and a table hides that by repeating the date down a column.
///
/// A Log entry is attached to a page by its path, never to a keyword, so the rows read as
/// pages and many keywords sharing one target share one entry.
struct LogScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let log: LogStore
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview
    @Environment(\.isScreenShown) private var isShown

    /// The record as it is held for this site, in the server's order.
    private var entries: [LogEntry] {
        log.entries[overview.id] ?? []
    }

    private var rows: [LogEntry] {
        LogList.rows(entries, kinds: state.logKinds, search: state.logSearch)
    }

    private var days: [LogDay] { LogList.days(rows) }

    private var tally: LogTally { LogList.tally(entries) }

    private var loading: Bool { log.loading.contains(overview.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.top, SiteTabScreen.screenInset)
                    .padding(.bottom, 24)

                if !entries.isEmpty {
                    controls
                        .padding(.bottom, 20)
                }

                timeline

                if let error = log.errors[overview.id] {
                    Text(error)
                        .foregroundStyle(Palette.coral)
                        .padding(.top, 16)
                }
            }
            .column()
            .padding(.bottom, SiteTabScreen.columnInset)
        }
        .scrollDisabled(isPreview)
        // The screen loads its own record, unlike the Registry and Planning screens, whose
        // rows come down with the site's dashboard. Nothing outside this screen shows the
        // Log, so a site tab that is never taken here costs no request at all. The tab
        // keeps this screen mounted behind the others so the click is instant, which is
        // why the load waits for `isScreenShown` rather than for the view to exist.
        .task(id: LoadKey(siteID: overview.id, shown: isShown)) {
            // Previews share the store with the live screen; only the live screen loads.
            guard !isPreview, isShown else { return }
            await log.load(overview.id)
        }
    }

    private struct LoadKey: Hashable {
        let siteID: Site.ID
        let shown: Bool
    }

    // MARK: Header

    /// What the record holds, in one line, under the tab's header row.
    private var header: some View {
        Text(summary)
            .foregroundStyle(.secondary)
    }

    /// What the record holds, in one line. Actions and Notes are counted apart because they
    /// are different claims: an Action changed the page and can be measured before and
    /// after, a Note only says something about it.
    private var summary: String {
        guard tally.entries > 0 else {
            return loading ? "Loading…" : "Nothing recorded yet."
        }
        var parts = ["\(tally.entries) \(tally.entries == 1 ? "entry" : "entries")"]
        if tally.actions > 0 {
            parts.append("\(tally.actions) \(tally.actions == 1 ? "action" : "actions")")
        }
        if tally.notes > 0 {
            parts.append("\(tally.notes) \(tally.notes == 1 ? "note" : "notes")")
        }
        parts.append("on \(tally.pages) \(tally.pages == 1 ? "page" : "pages")")
        if let latest = tally.latest, let label = LogList.dayLabel(latest) {
            parts.append("latest \(label)")
        }
        return parts.joined(separator: " · ")
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter by page, note or kind", text: $state.logSearch)
                    .textFieldStyle(.plain)
                    .frame(maxWidth: 240)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Palette.raised, in: .rect(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line))

            // The kinds as filters. Nothing selected means every entry, which is the honest
            // default: the reader has not said what they are looking for yet. A kind the
            // record holds none of is shown, disabled, so the reader can see it exists —
            // "no title changes at all" is itself worth reading off this screen.
            let counts = LogList.kindCounts(entries)
            FlowRow(spacing: 6) {
                ForEach(LogKind.allCases) { kind in
                    FilterChip(
                        label: kind.label,
                        count: counts[kind] ?? 0,
                        symbol: kind.symbol,
                        isOn: state.logKinds.contains(kind),
                        action: { toggle(kind) }
                    )
                    .help(kind.meaning)
                }
            }
        }
        .disabled(isPreview)
    }

    private func toggle(_ kind: LogKind) {
        if state.logKinds.contains(kind) {
            state.logKinds.remove(kind)
        } else {
            state.logKinds.insert(kind)
        }
    }

    // MARK: Timeline

    @ViewBuilder
    private var timeline: some View {
        if days.isEmpty {
            ContentUnavailableView(
                entries.isEmpty ? "Nothing recorded yet" : "No entries match",
                systemImage: "clock.arrow.circlepath",
                // An empty record is not a broken screen, and it says nothing about the
                // site's performance. It says nobody has written down what was done to it —
                // which is what makes a before/after window readable later, so the screen
                // names where entries come from rather than leaving the reader guessing.
                description: Text(
                    entries.isEmpty
                        ? "No action or note has been recorded for \(overview.site.name). "
                            + "Entries are written by an agent over MCP or from the terminal client, "
                            + "and they are what makes a page's before and after comparable."
                        : "No entry in the log matches the filter."
                )
            )
            .frame(minHeight: 240)
        } else {
            // Plain sections, drawn in full: a site's whole record is a few hundred entries
            // at most, and a lazy stack here re-phases its rows while the tab's live poll
            // runs behind the screen.
            VStack(alignment: .leading, spacing: 20) {
                ForEach(days) { day in
                    LogDaySection(day: day, origin: overview.site.origin)
                }
            }

            if rows.count < entries.count {
                Text("\(entries.count - rows.count) of \(entries.count) entries hidden by the filter.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
            }
        }
    }
}

// MARK: - Day

/// One day of the record: the date, then that day's entries in a card.
private struct LogDaySection: View {
    let day: LogDay
    let origin: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(LogList.dayLabel(day.date) ?? day.date)
                    .font(.subheadline.weight(.semibold))
                Text(day.date)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                Spacer()
                if day.entries.count > 1 {
                    Text("\(day.entries.count) entries")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(day.entries.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 {
                        Divider().opacity(0.4)
                    }
                    LogRow(entry: entry, origin: origin)
                }
            }
            .padding(.vertical, 4)
            .cardSurface(cornerRadius: 12)
        }
    }
}

// MARK: - Row

/// One entry: what was done, to which page, and what was written about it.
private struct LogRow: View {
    let entry: LogEntry
    /// The site's origin, so the row can reach the page itself.
    let origin: String

    @State private var isHovered = false
    @State private var isExpanded = false
    @Environment(\.openURL) private var openURL

    private static let badgeWidth: CGFloat = 132
    /// How much of a note a collapsed row shows. The notes are written by an agent and run
    /// to a paragraph: shown whole, three of them fill the screen and the timeline stops
    /// being scannable. Three lines is enough to know whether this is the entry you want.
    private static let collapsedLines = 3
    /// How far a Note sits back from an Action. A note changed nothing on the page, and the
    /// screen should not let it read as work done.
    private static let noteOpacity: Double = 0.75

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            LogKindBadge(entry: entry)
                .frame(width: Self.badgeWidth, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.path)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                if !entry.note.isEmpty {
                    Text(entry.note)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(isExpanded ? nil : Self.collapsedLines)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // The link appears on hover: every row has one, and a card of identical arrows
            // would say nothing.
            if let url = pageURL {
                Button("Open page", systemImage: "arrow.up.right.square") { openURL(url) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .opacity(isHovered ? 1 : 0)
                    .help(url.absoluteString)
                    .accessibilityLabel("Open \(entry.path)")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .opacity(entry.isAction ? 1 : Self.noteOpacity)
        .background(isHovered ? Palette.line.opacity(0.5) : .clear)
        .contentShape(.rect)
        // Clicking a row shows the rest of its note. Rows with no note stay inert rather
        // than offering a click that does nothing.
        .onTapGesture {
            guard !entry.note.isEmpty else { return }
            isExpanded.toggle()
        }
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityElement(children: .combine)
        .accessibilityHint(entry.note.isEmpty ? "" : "Shows the whole note")
    }

    /// When the entry was written, and whether that was the day it records. The two differ
    /// whenever work is written up afterwards, and the gap is worth knowing before reading a
    /// before/after window off the date.
    private var help: String {
        guard let createdAt = entry.createdAt,
              let written = LogList.recordedAt(createdAt) else { return "" }
        let stamp = written.formatted(date: .abbreviated, time: .shortened)
        guard let day = LogList.parse(entry.date),
              Calendar.current.isDate(written, inSameDayAs: day) else {
            return "Recorded \(stamp), after the day it records"
        }
        return "Recorded \(stamp)"
    }

    private var pageURL: URL? {
        let base = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
        return URL(string: base + entry.path)
    }
}

/// What was done, in the colour of what it says. A kind this build does not know shows the
/// server's own word: the entry still happened, and a blank badge would understate it.
private struct LogKindBadge: View {
    let entry: LogEntry

    private var tint: Color { entry.knownKind?.tint ?? .secondary }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: entry.knownKind?.symbol ?? "questionmark.circle")
                .font(.caption2)
            Text(entry.kindLabel)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(tint.opacity(0.14), in: .rect(cornerRadius: 4))
        .help(entry.knownKind?.meaning ?? "A kind this build does not know: \(entry.kind)")
    }
}

#Preview("Log") {
    LogScreen(
        overview: OverviewModel.preview.overviews[0],
        state: SiteTabState(siteID: "sleevy"),
        log: LogStore(),
        onRefresh: {}
    )
    .frame(width: 1100, height: 640)
    .background(Palette.panel)
}
