import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `FeedPrototype` for the question.
//
// Round three. Nine shapes in, the shipped log is still the clearest — and the reason is
// worth writing down: every row is a complete fact (who, where, what, when), and newest
// first is the right order for "what is happening". Round one kept the facts and lost the
// immediacy; round two kept the immediacy and lost the facts.
//
// So these five keep the table and change one thing each. Liveness comes from arrival (a
// new row flashes as it lands), recency (rows cool with age), and grouping (one person's
// consecutive rows become one block) — never from decoration. Each variant is judged on
// the one dimension it moves.

// MARK: - Grouping

/// The log's rows with one person's consecutive rows folded into a block: a header that says
/// who, then the steps, newest first, with the same page twice in a row counted rather than
/// repeated. Built from the screen's rows, so the kind and site filters still hold.
struct FeedLogGroup: Identifiable, Equatable {
    let id: String
    let siteID: Site.ID
    let siteName: String
    let who: String
    let flag: String
    let returns: String?
    let returnsHelp: String?
    /// The block's newest step, which is where it sits in the order.
    let newestAt: Date?
    let age: String
    /// Newest first.
    let steps: [FeedLogStep]
    /// Whether any step is an action rather than a page load: the block is worth a mark.
    let hasAction: Bool

    /// Rows of one visitor closer together than this join one block. Strict adjacency was
    /// tried first: with three sites interleaved, one person's rows are rarely adjacent, and
    /// nothing folded.
    static let gap: TimeInterval = 10 * 60

    /// One visitor's rows on one site as blocks, in the order of each block's newest row.
    /// A row joins its visitor's open block when it is within `gap` of the block's oldest
    /// step; otherwise it opens a new one.
    static func groups(_ rows: [LiveFeedRow], now: Date) -> [FeedLogGroup] {
        var blocks: [(key: String, rows: [LiveFeedRow])] = []
        var open: [String: Int] = [:]

        for row in rows {
            let key = "\(row.siteID)|\(row.event.visitor)"
            if let index = open[key],
               let oldest = blocks[index].rows.last?.event.date,
               let date = row.event.date,
               oldest.timeIntervalSince(date) < gap {
                blocks[index].rows.append(row)
            } else {
                blocks.append((key, [row]))
                open[key] = blocks.count - 1
            }
        }

        return blocks.compactMap { block in
            guard let head = block.rows.first else { return nil }
            var steps: [FeedLogStep] = []
            for row in block.rows {
                if let last = steps.last, last.kind == row.event.kind, last.primary == row.primary {
                    steps[steps.count - 1].repeats += 1
                    continue
                }
                steps.append(FeedLogStep(
                    id: row.id,
                    kind: row.event.kind,
                    primary: row.primary,
                    detail: row.detail,
                    time: row.time,
                    age: row.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? row.time,
                    repeats: 1
                ))
            }
            return FeedLogGroup(
                id: head.id,
                siteID: head.siteID,
                siteName: head.siteName,
                who: head.who,
                flag: head.event.country.map(FeedShapes.flag) ?? "🌐",
                returns: head.visits,
                returnsHelp: head.visitsHelp,
                newestAt: head.event.date,
                age: head.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? head.time,
                steps: steps,
                hasAction: steps.contains { $0.kind != .pageview }
            )
        }
    }
}

struct FeedLogStep: Identifiable, Equatable {
    let id: String
    let kind: LiveEvent.Kind
    let primary: String
    let detail: String?
    let time: String
    let age: String
    var repeats: Int

    var isAction: Bool { kind != .pageview }
}

// MARK: - Shell

/// The card these five sit in: the shipped Feed header, with its kind switch, kept as it is.
struct FeedLogCard<Content: View>: View {
    let title: String
    @Binding var kinds: FeedKinds
    let isEmpty: Bool
    let windowMinutes: Int
    let waiting: Bool
    @ViewBuilder let content: Content

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Text(title)
                    .font(.headline)
                Spacer()
                WordSwitch(options: FeedKinds.allCases, selection: $kinds, label: \.label, font: .subheadline)
                    .accessibilityLabel("Kinds")
            }
            .disabled(isPreview)

            if isEmpty {
                Text(waiting ? "Waiting for the provider…" : "Nothing in the last \(windowMinutes) minutes.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                content
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

// MARK: - J · Grouped

/// The log, with one person's consecutive rows folded into a block. The header says who;
/// the steps under it say what, newest first, and the reload that filled twenty rows is one
/// step with "×20" on it. Every fact of the log is still here — there are just fewer lines
/// to read to get them.
struct FeedGroupedVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    var body: some View {
        let groups = FeedLogGroup.groups(rows, now: now)
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        VStack(spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                // One step is one fact, and the log's row already says it in one line: a
                // header over a single step doubled the card's height and said nothing new.
                if group.steps.count == 1, let row = byID[group.id] {
                    FeedTemperatureRow(
                        row: row,
                        age: group.age,
                        showsSite: showsSite,
                        band: .warm,
                        flash: 0,
                        isLast: index == groups.count - 1
                    )
                } else {
                    FeedGroupBlock(group: group, showsSite: showsSite, isLast: index == groups.count - 1)
                }
            }
        }
    }
}

private struct FeedGroupBlock: View {
    let group: FeedLogGroup
    let showsSite: Bool
    let isLast: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Who: the log's own columns, on one line, once.
            HStack(spacing: 12) {
                Headband()
                    .fill(Palette.acid)
                    .frame(width: Headband.markerSize.width, height: Headband.markerSize.height)
                    .opacity(group.hasAction ? 1 : 0)
                    .accessibilityHidden(true)

                Text(group.age)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 64, alignment: .leading)

                if showsSite {
                    Text(group.siteName)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .frame(width: 104, alignment: .leading)
                }

                Text(group.who)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if let returns = group.returns {
                    Text(returns)
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(visitsColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(visitsColor.opacity(0.12), in: .capsule)
                        .help(group.returnsHelp ?? returns)
                }

                Spacer(minLength: 8)

                if group.steps.count > 1 {
                    Text("\(group.steps.count) steps")
                        .foregroundStyle(.tertiary)
                        .monospacedDigit()
                }
            }
            .font(.callout)
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 4)

            // What, under it, indented past the age and the site.
            ForEach(group.steps) { step in
                HStack(spacing: 8) {
                    Image(systemName: step.kind.symbol)
                        .foregroundStyle(step.isAction ? visitsColor : Color.secondary)
                        .frame(width: 16)
                    Text(step.primary)
                        .fontWeight(step.isAction ? .semibold : .regular)
                        .foregroundStyle(step.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
                    if step.repeats > 1 {
                        Text("×\(step.repeats)")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    if let detail = step.detail {
                        Text("· \(detail)")
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    if group.steps.count > 1 {
                        Text(step.age)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .help(step.time)
                    }
                }
                .font(.callout)
                .lineLimit(1)
                .padding(.leading, 12 + Headband.markerSize.width + 12 + 64 + (showsSite ? 104 + 12 : 0))
                .padding(.trailing, 12)
                .padding(.vertical, 3)
            }
        }
        .padding(.bottom, 8)
        .background(group.hasAction ? visitsColor.opacity(0.06) : Color.clear, in: .rect(cornerRadius: 6))
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1).padding(.horizontal, 12)
            }
        }
    }
}

// MARK: - O · Trail

/// One block per person, and the block is one table row plus one dim line. The row is the
/// shipped log's row for the person's newest step — the table stays the table — and the
/// line under it is where they came from, oldest first, in the quietest type on the page,
/// with no icons, no data and no ages: a trail, not a second table.
///
/// J put every step on its own full row, and on a site where every other step is an action
/// that read as a wall. Here nothing below the header is allowed to compete with it.
struct FeedTrailVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    var body: some View {
        let groups = FeedLogGroup.groups(rows, now: now)
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        VStack(spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                if let head = byID[group.id] {
                    VStack(alignment: .leading, spacing: 0) {
                        FeedTemperatureRow(
                            row: head,
                            age: group.age,
                            showsSite: showsSite,
                            band: .warm,
                            flash: 0,
                            isLast: true
                        )
                        if group.steps.count > 1 {
                            FeedTrailLine(group: group, showsSite: showsSite)
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if index < groups.count - 1 {
                            Palette.line.frame(height: 1).padding(.horizontal, 12)
                        }
                    }
                }
            }
        }
    }
}

/// "/ ×9 › search-character › /eu/tyrande/carmandt   3 earlier · since 4m ago", under the
/// words column of the row above it.
struct FeedTrailLine: View {
    let group: FeedLogGroup
    let showsSite: Bool

    /// Under the row's words: past the mark, the age, the site and the kind's symbol.
    static func indent(showsSite: Bool) -> CGFloat {
        12 + Headband.markerSize.width + 12 + 64 + 12 + (showsSite ? 104 + 12 : 0) + 16 + 12
    }

    var body: some View {
        // Oldest first: a trail is read the way it was walked, and it ends at the row.
        let earlier = Array(group.steps.dropFirst().reversed())
        let oldest = group.steps.last
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            trail(earlier)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let oldest {
                Text("\(earlier.count) earlier · since \(oldest.age)")
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }
        }
        .font(.caption)
        .padding(.leading, Self.indent(showsSite: showsSite))
        .padding(.trailing, 12)
        .padding(.bottom, 8)
        .padding(.top, -2)
    }

    /// The steps as one run of text, so the line truncates as a line. An action keeps a
    /// bolt and the accent, in the caption's weight; a repeated page keeps its count.
    private func trail(_ steps: [FeedLogStep]) -> Text {
        var text = Text("")
        for (index, step) in steps.enumerated() {
            if index > 0 {
                text = text + Text("  ›  ").foregroundStyle(.quaternary)
            }
            if step.isAction {
                text = text + Text(Image(systemName: "bolt.fill")).foregroundStyle(visitsColor.opacity(0.8))
                    + Text(" \(step.primary)").foregroundStyle(visitsColor.opacity(0.85))
            } else {
                text = text + Text(step.primary).foregroundStyle(.secondary)
            }
            if step.repeats > 1 {
                text = text + Text(" ×\(step.repeats)").foregroundStyle(.tertiary)
            }
        }
        return text
    }
}

// MARK: - P · Folded

/// One table row per person and nothing else: the row for their newest step, with a small
/// "+3" where earlier steps are folded behind it. Clicking the row lays the trail out under
/// it; clicking again folds it. The least the feed can show and still be complete — every
/// person is one line, and the history is a click away rather than on the page.
struct FeedFoldedVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    /// The people whose trail is open. By visitor, so the block stays open across polls.
    @State private var open: Set<String> = []

    var body: some View {
        let groups = FeedLogGroup.groups(rows, now: now)
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        VStack(spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                if let head = byID[group.id] {
                    let key = "\(group.siteID)|\(head.event.visitor)"
                    let isOpen = open.contains(key)
                    VStack(alignment: .leading, spacing: 0) {
                        FeedTemperatureRow(
                            row: head,
                            age: group.age,
                            showsSite: showsSite,
                            band: .warm,
                            flash: 0,
                            isLast: true,
                            folded: group.steps.count > 1 ? group.steps.count - 1 : nil
                        )
                        .onTapGesture {
                            guard group.steps.count > 1 else { return }
                            if isOpen { open.remove(key) } else { open.insert(key) }
                        }
                        if isOpen, group.steps.count > 1 {
                            FeedTrailLine(group: group, showsSite: showsSite)
                        }
                    }
                    .overlay(alignment: .bottom) {
                        if index < groups.count - 1 {
                            Palette.line.frame(height: 1).padding(.horizontal, 12)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - K · Temperature

/// The shipped table, row for row — and every row cools with age. The last minute is bright
/// and carries a mark; five minutes on, a row is quieter; a quarter of an hour on, it is
/// nearly gone. A row that has just landed in this client flashes for a few seconds, which
/// is the one true moment of liveness a poll has.
///
/// The flash is a background colour on the rows that have it, never a layout change: the
/// last time rows were animated into place on every poll, the app hung.
struct FeedTemperatureVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date
    let isLive: Bool
    /// Whether rows cool and flash at all. Off, this is the shipped table row for row,
    /// which is what N stands on.
    var cools = true

    /// When each row was first seen by this client — the flash's clock. The first fill of the
    /// screen is not an arrival, so it is primed silently.
    @State private var arrivals: [String: Date] = [:]
    @State private var primed = false

    private static let flash: TimeInterval = 8

    var body: some View {
        let fresh = arrivals.values.contains { Date().timeIntervalSince($0) < Self.flash }
        // One tick a second while any row is flashing, and none at all otherwise.
        TimelineView(.animation(minimumInterval: 1, paused: !isLive || !fresh || !cools)) { context in
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    let age = row.event.date.map { now.timeIntervalSince($0) } ?? 0
                    let landed = arrivals[row.id].map { context.date.timeIntervalSince($0) } ?? .infinity
                    FeedTemperatureRow(
                        row: row,
                        age: row.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? row.time,
                        showsSite: showsSite,
                        band: cools ? FeedTemperatureRow.Band(age: age) : .warm,
                        flash: cools ? max(0, 1 - landed / Self.flash) : 0,
                        isLast: index == rows.count - 1
                    )
                    .equatable()
                }
            }
        }
        .onChange(of: rows.map(\.id), initial: true) { _, ids in
            let shown = Set(ids)
            if !primed {
                primed = true
                for id in ids { arrivals[id] = .distantPast }
                return
            }
            let landed = Date()
            for id in ids where arrivals[id] == nil { arrivals[id] = landed }
            arrivals = arrivals.filter { shown.contains($0.key) }
        }
    }
}

private struct FeedTemperatureRow: View, Equatable {
    /// How old a row is, in the three steps the eye can tell apart.
    enum Band: Equatable {
        case hot, warm, cool, cold

        init(age: TimeInterval) {
            switch age {
            case ..<60: self = .hot
            case ..<(5 * 60): self = .warm
            case ..<(15 * 60): self = .cool
            default: self = .cold
            }
        }

        var text: AnyShapeStyle {
            switch self {
            case .hot, .warm: AnyShapeStyle(.primary)
            case .cool: AnyShapeStyle(.secondary)
            case .cold: AnyShapeStyle(.tertiary)
            }
        }

        var padding: CGFloat {
            switch self {
            case .hot: 9
            case .warm: 8
            case .cool: 6
            case .cold: 5
            }
        }

        /// The whole row, not just its words: the columns with a style of their own
        /// (secondary ages, lilac marks) must cool too.
        var opacity: Double {
            switch self {
            case .hot, .warm: 1
            case .cool: 0.7
            case .cold: 0.45
            }
        }
    }

    let row: LiveFeedRow
    let age: String
    let showsSite: Bool
    let band: Band
    /// 1 as the row lands, 0 a few seconds later.
    let flash: Double
    let isLast: Bool
    /// How many earlier steps of this person are folded behind the row; nil for none, and
    /// for rows that do not fold. Drawn as a small pill after the words.
    var folded: Int? = nil

    private var event: LiveEvent { row.event }

    nonisolated static func == (left: FeedTemperatureRow, right: FeedTemperatureRow) -> Bool {
        left.row == right.row && left.age == right.age && left.showsSite == right.showsSite
            && left.band == right.band && left.flash == right.flash && left.isLast == right.isLast
            && left.folded == right.folded
    }

    var body: some View {
        HStack(spacing: 12) {
            // The last minute's rows carry the mark the hover uses; the flash adds to it.
            Headband()
                .fill(band == .hot ? visitsColor : Palette.line)
                .frame(width: Headband.markerSize.width, height: Headband.markerSize.height)
                .opacity(band == .hot ? 0.6 + 0.4 * flash : 0)
                .accessibilityHidden(true)

            Text(age)
                .monospacedDigit()
                .foregroundStyle(band == .hot ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.secondary))
                .frame(width: 64, alignment: .leading)
                .help(row.time)

            if showsSite {
                Text(row.siteName)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: 104, alignment: .leading)
            }

            Image(systemName: event.kind.symbol)
                .foregroundStyle(event.kind == .event ? visitsColor : Color.secondary)
                .frame(width: 16)

            HStack(spacing: 6) {
                Text(row.primary)
                    .fontWeight(event.kind == .event ? .semibold : .regular)
                if let detail = row.detail {
                    Text("· \(detail)")
                        .foregroundStyle(.secondary)
                }
                if let folded, folded > 0 {
                    Text("+\(folded)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Palette.line.opacity(0.7), in: .capsule)
                        .help("\(folded) earlier \(folded == 1 ? "step" : "steps") by this person — click to show")
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)

            Group {
                if let visits = row.visits {
                    Text(visits)
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(visitsColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(visitsColor.opacity(0.12), in: .capsule)
                        .help(row.visitsHelp ?? visits)
                }
            }
            .frame(width: 52, alignment: .trailing)

            Text(row.who)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 216, alignment: .trailing)
        }
        .font(.callout)
        .foregroundStyle(band.text)
        .opacity(band.opacity)
        .padding(.horizontal, 12)
        .padding(.vertical, band.padding)
        .background(
            visitsColor.opacity((event.kind == .event ? 0.08 : 0) + 0.2 * flash),
            in: .rect(cornerRadius: 6)
        )
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1).padding(.horizontal, 12)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - L · Per site

/// The log split into one column per site, each its own newest-first log. Shadertown's
/// flood stays in Shadertown's column; Missingmounts' two actions are the only things in
/// theirs, and cannot be buried. Rows are the log's rows, made narrow: the column header
/// names the site, so the row does not.
struct FeedPerSiteVariant: View {
    let rows: [LiveFeedRow]
    let shapes: FeedShapes
    let now: Date

    private static let limit = 18

    var body: some View {
        // Every shown site gets a column, busiest first, quiet ones included: a column that
        // says "quiet" is a fact, and a missing one is a question.
        let sites = shapes.columns
        HStack(alignment: .top, spacing: 12) {
            ForEach(sites) { site in
                let own = rows.filter { $0.siteID == site.id }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(site.online > 0 ? visitsColor : Palette.line)
                            .frame(width: 6, height: 6)
                        Text(site.name)
                            .font(.callout.weight(.medium))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(site.online > 0 ? "\(site.online) online" : "quiet")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(site.online > 0 ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                    }
                    .padding(.bottom, 4)

                    if own.isEmpty {
                        Text("Nothing in the window.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.vertical, 8)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(own.prefix(Self.limit).enumerated()), id: \.element.id) { index, row in
                                FeedNarrowRow(
                                    row: row,
                                    age: row.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? row.time,
                                    isLast: index == min(own.count, Self.limit) - 1
                                )
                            }
                        }
                        if own.count > Self.limit {
                            Text("+\(own.count - Self.limit) more")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 6)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

/// A log row with room for a column: age, kind, page, flag.
private struct FeedNarrowRow: View {
    let row: LiveFeedRow
    let age: String
    let isLast: Bool

    var body: some View {
        let isAction = row.event.kind != .pageview
        HStack(spacing: 8) {
            Text(age)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 52, alignment: .leading)
                .help(row.time)
            Image(systemName: row.event.kind.symbol)
                .foregroundStyle(isAction ? visitsColor : Color.secondary)
                .frame(width: 14)
            Text(row.primary)
                .fontWeight(isAction ? .semibold : .regular)
                .foregroundStyle(isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let visits = row.visits {
                Text(visits)
                    .monospacedDigit()
                    .foregroundStyle(visitsColor)
                    .help(row.visitsHelp ?? visits)
            }
            Text(row.event.country.map(FeedShapes.flag) ?? "🌐")
                .help(row.who)
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(isAction ? visitsColor.opacity(0.08) : Color.clear, in: .rect(cornerRadius: 5))
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1).padding(.horizontal, 8)
            }
        }
        .help(row.detail ?? row.primary)
    }
}

// MARK: - M · Transcript

/// The same blocks as J, read as a conversation: each person is a speaker with the flag for
/// a face, and what they did is said in a sentence under their name. The most familiar
/// live text form there is — a chat — and it is not a table.
struct FeedTranscriptVariant: View {
    let rows: [LiveFeedRow]
    let showsSite: Bool
    let now: Date

    var body: some View {
        let groups = FeedLogGroup.groups(rows, now: now)
        VStack(alignment: .leading, spacing: 14) {
            ForEach(groups) { group in
                HStack(alignment: .top, spacing: 12) {
                    Text(group.flag)
                        .font(.title3)
                        .frame(width: 34, height: 34)
                        .background(Palette.line.opacity(0.7), in: .circle)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            if showsSite {
                                Text(group.siteName)
                                    .fontWeight(.semibold)
                            }
                            Text(group.who)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            // One thing said: the sentence sits on the name's line.
                            if group.steps.count == 1, let step = group.steps.first {
                                sentence(step)
                            }
                            if let returns = group.returns {
                                Text(returns)
                                    .monospacedDigit()
                                    .font(.caption)
                                    .foregroundStyle(visitsColor)
                                    .help(group.returnsHelp ?? returns)
                            }
                            Spacer(minLength: 8)
                            Text(group.age)
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                        }
                        .font(.callout)

                        // Oldest first inside the block: a sentence reads forward, even in a
                        // feed that reads down from newest.
                        if group.steps.count > 1 {
                            ForEach(group.steps.reversed()) { step in
                                sentence(step)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        group.hasAction ? visitsColor.opacity(0.08) : Palette.line.opacity(0.35),
                        in: .rect(cornerRadius: 10)
                    )
                }
            }
        }
    }
}

extension FeedTranscriptVariant {
    /// "opened /shaders/ferro ×4", with an action in the accent and its data after a dash.
    fileprivate func sentence(_ step: FeedLogStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(FeedShapes.verb(step.kind))
                .foregroundStyle(.secondary)
            Text(step.primary)
                .fontWeight(step.isAction ? .semibold : .regular)
                .foregroundStyle(step.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
            if step.repeats > 1 {
                Text("×\(step.repeats)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let detail = step.detail, step.isAction {
                Text("— \(detail)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .lineLimit(1)
    }
}

// MARK: - N · Head

/// The shipped table, unchanged, given a head: the actions of the window pinned above it as
/// chips with their counts, and the window's page loads per minute as a small strip. Nothing
/// in the log moves or changes; the two things the log buries are lifted out and set on
/// top of it. The smallest change of the five.
struct FeedHeadVariant: View {
    let rows: [LiveFeedRow]
    let shapes: FeedShapes
    let showsSite: Bool
    let now: Date

    /// The window's actions by name, most frequent first, each with its newest age.
    private var actions: [(name: String, count: Int, age: String)] {
        var counts: [String: (count: Int, newest: Date)] = [:]
        for signal in shapes.signals {
            var entry = counts[signal.name] ?? (0, signal.at)
            entry.count += 1
            entry.newest = max(entry.newest, signal.at)
            counts[signal.name] = entry
        }
        return counts
            .map { (name: $0.key, count: $0.value.count, age: RelativeAge.labelOrTime(from: $0.value.newest, to: now)) }
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.name < $1.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 20) {
                // The actions, lifted out.
                VStack(alignment: .leading, spacing: 8) {
                    Text(actions.isEmpty ? "No actions in the window" : "Actions in the window")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    if !actions.isEmpty {
                        FlowRow(spacing: 6) {
                            ForEach(actions, id: \.name) { action in
                                HStack(spacing: 6) {
                                    Image(systemName: "bolt.fill")
                                        .font(.caption2)
                                    Text(action.name)
                                        .fontWeight(.semibold)
                                    if action.count > 1 {
                                        Text("×\(action.count)")
                                            .monospacedDigit()
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(action.age)
                                        .monospacedDigit()
                                        .foregroundStyle(.tertiary)
                                }
                                .font(.callout)
                                .foregroundStyle(visitsColor)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 5)
                                .background(visitsColor.opacity(0.12), in: .rect(cornerRadius: 6))
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // The window's rhythm, as the strip the tiles already use.
                VStack(alignment: .trailing, spacing: 8) {
                    Text("\(Int(shapes.pulse.reduce(0, +))) page loads · \(shapes.windowMinutes)m")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                    let peak = max(shapes.pulse.max() ?? 1, 1)
                    HStack(alignment: .bottom, spacing: 2) {
                        ForEach(shapes.pulse.indices, id: \.self) { index in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(shapes.pulse[index] > 0 ? visitsColor.opacity(0.6) : Palette.line)
                                .frame(width: 5, height: max(3, 20 * shapes.pulse[index] / peak))
                        }
                    }
                    .frame(height: 20)
                    .accessibilityHidden(true)
                }
            }
            .padding(.bottom, 6)
            .overlay(alignment: .bottom) { Palette.line.frame(height: 1) }

            // The log, exactly as shipped.
            FeedTemperatureVariant(rows: rows, showsSite: showsSite, now: now, isLive: false, cools: false)
        }
    }
}
