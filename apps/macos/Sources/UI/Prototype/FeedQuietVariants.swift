import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `FeedPrototype` for the question.
//
// Round four. The angle is settled — a table, one line per person — and the complaint is
// now about finish: on one shipped row there is an emoji flag, a lilac pill, a lilac bolt,
// lilac bold words, a lilac tint, an acid mark, an eye, a referrer, three facts about the
// visitor, and, in the grouped variants, two row heights. Together that reads as cheap.
//
// So these three strip rather than tune, under one rule: one row height, one type size,
// greys only, no icons, no flags, no pills, no tints. An action differs from a page load by
// weight and nothing else. Everything cut is on hover.

// MARK: - The row

/// A page or an action, in the quiet row's words: what, and the run of steps before it.
struct FeedQuietLine: Identifiable, Equatable {
    let id: String
    let siteName: String
    /// Oldest first, ending at the newest step. One entry for a plain row.
    let steps: [FeedLogStep]
    let country: String
    /// "×3" for a returning visitor, as plain type; nil on a first visit.
    let returns: String?
    let age: String
    /// Everything the row does not show: the pointer's text.
    let help: String

    var newest: FeedLogStep? { steps.last }
}

enum FeedQuiet {
    /// "now", "3m", "14m", then the clock time. Shorter than the log's "3m ago": the column
    /// is a gutter, not a sentence.
    static func age(_ date: Date?, now: Date) -> String {
        guard let date else { return "—" }
        let elapsed = now.timeIntervalSince(date)
        if elapsed < 60 { return "now" }
        if elapsed < 3600 { return "\(Int(elapsed / 60))m" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// The country's name alone: the flag is colour, and the browser and device are data.
    static func country(_ event: LiveEvent) -> String {
        guard let code = event.country else { return "—" }
        return Locale.current.localizedString(forRegionCode: code.uppercased()) ?? code.uppercased()
    }

    /// One line per person, from the log's rows, within `FeedLogGroup.gap` of each other.
    static func lines(grouping rows: [LiveFeedRow], now: Date) -> [FeedQuietLine] {
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        return FeedLogGroup.groups(rows, now: now).compactMap { group in
            guard let head = byID[group.id] else { return nil }
            return FeedQuietLine(
                id: group.id,
                siteName: group.siteName,
                steps: group.steps.reversed(),
                country: country(head.event),
                returns: head.visits,
                age: age(head.event.date, now: now),
                help: help(head, steps: group.steps.count)
            )
        }
    }

    /// One line per row, with the same thing twice in a row by one person counted once.
    static func lines(_ rows: [LiveFeedRow], now: Date) -> [FeedQuietLine] {
        var lines: [FeedQuietLine] = []
        var lastKey: String?
        for row in rows {
            let key = "\(row.siteID)|\(row.event.visitor)|\(row.event.kind)|\(row.primary)"
            if key == lastKey, var last = lines.last, var step = last.steps.last {
                step.repeats += 1
                last = FeedQuietLine(
                    id: last.id, siteName: last.siteName, steps: [step], country: last.country,
                    returns: last.returns, age: last.age, help: last.help
                )
                lines[lines.count - 1] = last
                continue
            }
            lastKey = key
            lines.append(FeedQuietLine(
                id: row.id,
                siteName: row.siteName,
                steps: [FeedLogStep(
                    id: row.id, kind: row.event.kind, primary: row.primary, detail: row.detail,
                    time: row.time, age: age(row.event.date, now: now), repeats: 1
                )],
                country: country(row.event),
                returns: row.visits,
                age: age(row.event.date, now: now),
                help: help(row, steps: 1)
            ))
        }
        return lines
    }

    private static func help(_ row: LiveFeedRow, steps: Int) -> String {
        var parts = [row.time, row.who]
        if let detail = row.detail { parts.append(detail) }
        if let visits = row.visitsHelp { parts.append(visits) }
        if steps > 1 { parts.append("\(steps) steps in the window") }
        return parts.joined(separator: " · ")
    }
}

/// The one row. Fixed height, no background, no hairline: the columns hold the lines.
struct FeedQuietRow: View {
    let line: FeedQuietLine
    let showsSite: Bool

    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 16) {
            Text(line.age)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 40, alignment: .trailing)

            if showsSite {
                Text(line.siteName)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: 112, alignment: .leading)
            }

            path
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                if let returns = line.returns {
                    Text(returns)
                        .monospacedDigit()
                        .foregroundStyle(.quaternary)
                }
                Text(line.country)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .frame(width: 150, alignment: .trailing)
        }
        .font(.callout)
        .frame(height: Self.height)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .help(line.help)
        .accessibilityElement(children: .combine)
    }

    /// The steps as one run of type. Earlier steps are tertiary, the newest is primary, and
    /// an action is set in medium weight — the only mark it gets.
    private var path: Text {
        var text = Text("")
        for (index, step) in line.steps.enumerated() {
            let isNewest = index == line.steps.count - 1
            if index > 0 {
                text = text + Text("  ›  ").foregroundStyle(.quaternary)
            }
            var word = Text(step.primary).fontWeight(step.isAction ? .medium : .regular)
            word = isNewest ? word.foregroundStyle(.primary) : word.foregroundStyle(.tertiary)
            text = text + word
            if step.repeats > 1 {
                text = text + Text(" ×\(step.repeats)").monospacedDigit().foregroundStyle(.quaternary)
            }
        }
        return text
    }
}

// MARK: - Q · Quiet

/// The shipped log, stripped. Same rows, same order; every row the same height and the same
/// four columns: when, where, what, who. The only thing that stands out is an action, and it
/// stands out by weight.
struct FeedQuietVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    var body: some View {
        VStack(spacing: 0) {
            ForEach(FeedQuiet.lines(rows, now: now)) { line in
                FeedQuietRow(line: line, showsSite: showsSite)
            }
        }
    }
}

// MARK: - R · Quiet, one line per person

/// One row per person, and the row is their path: the steps they took, oldest to newest,
/// in one run of type that ends at what they are doing now. The grouping of J and O, with
/// nothing under the row — the path *is* the row, so every row is the same height.
struct FeedQuietPathVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    var body: some View {
        VStack(spacing: 0) {
            ForEach(FeedQuiet.lines(grouping: rows, now: now)) { line in
                FeedQuietRow(line: line, showsSite: showsSite)
            }
        }
    }
}

// MARK: - S · Quiet, per site

/// R's rows, one column per site. The column header names the site, so the row does not;
/// one site's crowd stays in its own column and cannot bury another's.
struct FeedQuietPerSiteVariant: View {
    let rows: [LiveFeedRow]
    let shapes: FeedShapes
    let now: Date

    private static let limit = 16

    var body: some View {
        let lines = FeedQuiet.lines(grouping: rows, now: now)
        HStack(alignment: .top, spacing: 24) {
            ForEach(shapes.columns) { site in
                let own = lines.filter { $0.siteName == site.name }
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text(site.name)
                            .font(.callout.weight(.medium))
                        Spacer()
                        Text(site.online > 0 ? "\(site.online) online" : "quiet")
                            .font(.callout)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: FeedQuietRow.height)
                    .overlay(alignment: .bottom) { Palette.line.frame(height: 1).padding(.horizontal, 12) }

                    if own.isEmpty {
                        Text("—")
                            .foregroundStyle(.quaternary)
                            .padding(.horizontal, 12)
                            .frame(height: FeedQuietRow.height)
                    } else {
                        ForEach(own.prefix(Self.limit)) { line in
                            FeedQuietNarrowRow(line: line)
                        }
                        if own.count > Self.limit {
                            Text("+\(own.count - Self.limit)")
                                .font(.callout)
                                .monospacedDigit()
                                .foregroundStyle(.quaternary)
                                .padding(.horizontal, 12)
                                .frame(height: FeedQuietRow.height)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

/// The quiet row with room for a column: when, what, who.
private struct FeedQuietNarrowRow: View {
    let line: FeedQuietLine

    var body: some View {
        HStack(spacing: 12) {
            Text(line.age)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 34, alignment: .trailing)
            // A path is read from its end: "…/duotone" says more than "/shad…uotone".
            Text(line.newest?.primary ?? "—")
                .fontWeight(line.newest?.isAction == true ? .medium : .regular)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(line.country)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .frame(width: 72, alignment: .trailing)
        }
        .font(.callout)
        .frame(height: FeedQuietRow.height)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .help(line.help)
    }
}
