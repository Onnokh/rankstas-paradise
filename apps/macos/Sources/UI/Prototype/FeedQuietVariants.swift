import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `FeedPrototype` for the question.
//
// Round four. The angle is settled — a table, one line per person — and the complaint is
// now about finish: on one shipped row there is an emoji flag, a lilac pill, a lilac bolt,
// lilac bold words, a lilac tint, an acid mark, an eye, a referrer, three facts about the
// visitor, and, in the grouped variants, two row heights. Together that reads as cheap.
//
// So these three strip rather than tune, under one rule: one row height, one type size, no
// icons, no flags, no pills, no tints, and one colour with one meaning — an action is set in
// the analytics colour, a page load in grey. Everything cut is on hover, in a real tooltip.

// MARK: - The row

/// A page or an action, in the quiet row's words: what, and the run of steps before it.
struct FeedQuietLine: Identifiable, Equatable {
    let id: String
    let siteID: Site.ID
    let siteName: String
    /// Oldest first, ending at the newest step. One entry for a plain row.
    let steps: [FeedLogStep]
    let country: String
    /// "🇩🇪": the country as one glyph, for the end of a row.
    let flag: String
    /// "🇩🇪 Germany · Chrome · Desktop": the tooltip's first line.
    let who: String
    /// "×3" for a returning visitor; nil on a first visit.
    let returns: String?
    /// "3 visits since 12 Aug", for the tooltip.
    let returnsHelp: String?
    let age: String
    /// "from google.com": how the visit began, when the provider says. The caption's words
    /// for a row that has no history yet.
    let origin: String?

    var newest: FeedLogStep? { steps.last }
}

enum FeedQuiet {
    /// "/eu/ravencrest/bãrlah", not "/eu/ravencrest/b%C3%A3rlah": a path is read, not sent.
    static func readable(_ path: String) -> String {
        path.removingPercentEncoding ?? path
    }

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
                siteID: group.siteID,
                siteName: group.siteName,
                steps: group.steps.reversed(),
                country: country(head.event),
                flag: head.event.country.map(FeedShapes.flag) ?? "",
                who: head.who,
                returns: head.visits,
                returnsHelp: head.visitsHelp,
                age: age(head.event.date, now: now),
                origin: byID[group.steps.last?.id ?? ""]?.detail
            )
        }
    }

    /// One line per row, with the same thing twice in a row by one person counted once.
    static func lines(_ rows: [LiveFeedRow], now: Date) -> [FeedQuietLine] {
        var lines: [FeedQuietLine] = []
        var lastKey: String?
        for row in rows {
            let key = "\(row.siteID)|\(row.event.visitor)|\(row.event.kind)|\(row.primary)"
            if key == lastKey, let last = lines.last, var step = last.steps.last {
                step.repeats += 1
                lines[lines.count - 1] = FeedQuietLine(
                    id: last.id, siteID: last.siteID, siteName: last.siteName, steps: [step],
                    country: last.country, flag: last.flag, who: last.who, returns: last.returns,
                    returnsHelp: last.returnsHelp, age: last.age, origin: last.origin
                )
                continue
            }
            lastKey = key
            lines.append(FeedQuietLine(
                id: row.id,
                siteID: row.siteID,
                siteName: row.siteName,
                steps: [FeedLogStep(
                    id: row.id, kind: row.event.kind, primary: row.primary, detail: row.detail,
                    time: row.time, age: age(row.event.date, now: now), repeats: 1
                )],
                country: country(row.event),
                flag: row.event.country.map(FeedShapes.flag) ?? "",
                who: row.who,
                returns: row.visits,
                returnsHelp: row.visitsHelp,
                age: age(row.event.date, now: now),
                origin: row.event.kind == .pageview ? row.detail : nil
            ))
        }
        return lines
    }
}

/// The one row. Fixed height, no background, no hairline: the columns hold the lines.
///
/// The history is the two steps before the newest, and a count for the rest: a run of every
/// step cut from the head left "…×2 ›" on the page, which is not a word. The whole path,
/// with ages and data, is the tooltip's.
struct FeedQuietRow: View {
    let line: FeedQuietLine
    let showsSite: Bool
    /// Whether the pointer is on this row: the row lifts a little, and the tooltip opens.
    var isHovered = false

    static let height: CGFloat = 32
    /// How many steps before the newest the row shows in full.
    static let shownEarlier = 2

    /// Where the words column starts: where the tooltip hangs from.
    private var wordsX: CGFloat { 12 + 40 + 16 + (showsSite ? 112 + 16 : 0) }

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

            // How many times this person has been here. Its own column, so the figure lines
            // up down the page and a first visit is a visible blank, not a missing mark.
            Text(line.returns ?? "")
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 32, alignment: .trailing)

            Text(line.country)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .frame(width: 120, alignment: .trailing)
        }
        .font(.callout)
        .frame(height: Self.height)
        .padding(.horizontal, 12)
        .background(isHovered ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .contentShape(Rectangle())
        .overlay(alignment: .topLeading) {
            if isHovered {
                FeedQuietTooltip(line: line)
                    .fixedSize()
                    .offset(x: wordsX, y: Self.height + 4)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        // Over the rows below it, or the tooltip is painted under them.
        .zIndex(isHovered ? 1 : 0)
        .accessibilityElement(children: .combine)
    }

    /// The steps as one run of type: "+3 › /shaders › search-character › /eu/emeriss".
    /// Earlier steps are tertiary and the newest is primary. An action is set in medium
    /// weight and in the analytics colour — the one colour on the row, so a page load and a
    /// thing done on it can be told apart at a glance and nothing else competes.
    private var path: Text {
        let earlier = Array(line.steps.dropLast())
        let shown = Array(earlier.suffix(Self.shownEarlier))
        var text = Text("")
        if earlier.count > shown.count {
            text = text + Text("+\(earlier.count - shown.count)").monospacedDigit().foregroundStyle(.quaternary)
                + Text("  ›  ").foregroundStyle(.quaternary)
        }
        for step in shown {
            text = text + Text(FeedShapes.short(step.primary, limit: 30))
                .fontWeight(step.isAction ? .medium : .regular)
                .foregroundStyle(step.isAction ? AnyShapeStyle(visitsColor.opacity(0.55)) : AnyShapeStyle(.tertiary))
            if step.repeats > 1 {
                text = text + Text(" ×\(step.repeats)").monospacedDigit().foregroundStyle(.quaternary)
            }
            text = text + Text("  ›  ").foregroundStyle(.quaternary)
        }
        if let newest = line.newest {
            text = text + Text(newest.primary)
                .fontWeight(newest.isAction ? .medium : .regular)
                .foregroundStyle(newest.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
            if newest.repeats > 1 {
                text = text + Text(" ×\(newest.repeats)").monospacedDigit().foregroundStyle(.tertiary)
            }
        }
        return text
    }
}

/// What the row does not say, under the pointer: who this is, how often they have been
/// here, and every step of the window with its age and data — oldest first, so it reads as
/// it was walked. The same panel as the realtime bars' minute label.
struct FeedQuietTooltip: View {
    let line: FeedQuietLine

    private static let limit = 12

    var body: some View {
        let shown = Array(line.steps.suffix(Self.limit))
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(line.who)
                    .fontWeight(.medium)
                if let returnsHelp = line.returnsHelp {
                    Text("·").foregroundStyle(.tertiary)
                    Text(returnsHelp)
                        .foregroundStyle(.secondary)
                } else {
                    Text("·").foregroundStyle(.tertiary)
                    Text("first visit")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)

            VStack(alignment: .leading, spacing: 4) {
                if line.steps.count > shown.count {
                    Text("\(line.steps.count - shown.count) earlier steps")
                        .foregroundStyle(.quaternary)
                }
                ForEach(shown) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(step.age)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .frame(width: 60, alignment: .trailing)
                        Text(step.primary)
                            .fontWeight(step.isAction ? .medium : .regular)
                            .foregroundStyle(step.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
                        if step.repeats > 1 {
                            Text("×\(step.repeats)")
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                        }
                        if let detail = step.detail {
                            Text(detail)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .lineLimit(1)
                }
            }
            .font(.callout)
            .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: 520, alignment: .leading)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.3), radius: 10, y: 4)
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
        FeedQuietList(lines: FeedQuiet.lines(rows, now: now), showsSite: showsSite)
    }
}

/// The rows, with one of them under the pointer. The hover is by visitor, so the same
/// person stays lit across a poll that gives their row a new id.
struct FeedQuietList: View {
    let lines: [FeedQuietLine]
    let showsSite: Bool

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: String?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(lines) { line in
                FeedQuietRow(line: line, showsSite: showsSite, isHovered: hovered == line.id)
                    .onHover { inside in
                        guard !isPreview else { return }
                        if inside {
                            hovered = line.id
                        } else if hovered == line.id {
                            hovered = nil
                        }
                    }
            }
        }
        .animation(.easeOut(duration: 0.12), value: hovered)
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
        FeedQuietList(lines: FeedQuiet.lines(grouping: rows, now: now), showsSite: showsSite)
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
                .foregroundStyle(line.newest?.isAction == true ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
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
        .help([line.who, line.returnsHelp ?? "first visit"].joined(separator: " · "))
    }
}

// MARK: - T · Hierarchy

/// One row per person, two lines, every row the same. The site leads, under its favicon;
/// then the first line is one thing only — what they are doing now: a page in grey, an
/// action in the analytics colour, a link out with an arrow — and the second line is one
/// caption in one grey: how often they have been here, and the steps that led here. The age
/// is a gutter on the left; the country is a flag at the end.
///
/// R put six things on one line at four greys and three strengths of lilac, each row
/// starting with a different one of them. Here a row has three tones and a fixed order,
/// so the eye lands on the same thing in every row.
struct FeedHierarchyVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date
    /// A site's favicon, when the store has it.
    var icon: (Site.ID) -> Image? = { _ in nil }

    var body: some View {
        FeedHierarchyList(lines: FeedQuiet.lines(grouping: rows, now: now), showsSite: showsSite, icon: icon)
    }
}

struct FeedHierarchyList: View {
    let lines: [FeedQuietLine]
    let showsSite: Bool
    let icon: (Site.ID) -> Image?

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: String?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(lines) { line in
                FeedHierarchyRow(line: line, showsSite: showsSite, icon: icon(line.siteID), isHovered: hovered == line.id)
                    .onHover { inside in
                        guard !isPreview else { return }
                        if inside {
                            hovered = line.id
                        } else if hovered == line.id {
                            hovered = nil
                        }
                    }
            }
        }
        .animation(.easeOut(duration: 0.12), value: hovered)
    }
}

struct FeedHierarchyRow: View {
    let line: FeedQuietLine
    let showsSite: Bool
    let icon: Image?
    var isHovered = false

    static let height: CGFloat = 44
    private static let gutter: CGFloat = 40
    private static let siteWidth: CGFloat = 136

    /// Where the words start: where the tooltip hangs from.
    private var wordsX: CGFloat { 12 + Self.gutter + 16 + (showsSite ? Self.siteWidth + 16 : 0) }

    var body: some View {
        // Three sizes for three roles: the headline at body, the site at callout, and the
        // age and caption at caption size. One size in three greys was not a hierarchy.
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(line.age)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: Self.gutter, alignment: .trailing)

            if showsSite {
                HStack(spacing: 7) {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit()
                            .frame(width: 14, height: 14)
                            .clipShape(.rect(cornerRadius: 3))
                    }
                    Text(line.siteName)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(width: Self.siteWidth, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 2) {
                headline
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                caption
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(line.flag)
                .font(.body)
                .frame(width: 24, alignment: .trailing)
                .help(line.country)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(height: Self.height, alignment: .top)
        .background(isHovered ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .contentShape(Rectangle())
        .overlay(alignment: .topLeading) {
            if isHovered {
                FeedQuietTooltip(line: line)
                    .fixedSize()
                    .offset(x: wordsX, y: Self.height + 2)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .zIndex(isHovered ? 1 : 0)
        .accessibilityElement(children: .combine)
    }

    /// What they are doing now, and nothing else. An action in the analytics colour; a link
    /// out with an arrow, in grey, because leaving is navigation and not a thing done here.
    @ViewBuilder private var headline: some View {
        if let newest = line.newest {
            HStack(spacing: 6) {
                switch newest.kind {
                case .event, .buttonClick, .copy, .formSubmit, .inputChange:
                    Text(newest.primary)
                        .fontWeight(.medium)
                        .foregroundStyle(visitsColor)
                case .outbound:
                    Text("→ \(FeedQuiet.readable(newest.primary))")
                case .pageview:
                    Text(FeedQuiet.readable(newest.primary))
                }
                if newest.repeats > 1 {
                    Text("×\(newest.repeats)")
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
        } else {
            Text("—")
        }
    }

    /// Everything else, in one grey: "3rd visit · after /eu/drakthul/felmasakr · 5 steps".
    /// Only the step before this one is named, in full — two, shortened, cut paths in the
    /// middle of a word, and the whole trail is the tooltip's. A row with no history says
    /// how the visit began instead, when the provider knows: "from google.com". The line is
    /// kept even when it is empty, so every row is the same height.
    private var caption: Text {
        var parts: [String] = []
        if let returns = line.returns, let count = Int(returns.dropFirst()) {
            parts.append("\(FeedShapes.ordinal(count)) visit")
        }
        if line.steps.count > 1, let previous = line.steps.dropLast().last {
            parts.append("after \(FeedQuiet.readable(previous.primary))\(previous.repeats > 1 ? " ×\(previous.repeats)" : "")")
            if line.steps.count > 2 {
                parts.append("\(line.steps.count) steps")
            }
        } else if let origin = line.origin {
            parts.append(origin)
        }
        return Text(parts.isEmpty ? " " : parts.joined(separator: "  ·  "))
    }
}
