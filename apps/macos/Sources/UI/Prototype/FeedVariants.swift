import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `FeedPrototype` for the question.
//
// Five shapes of the same half hour. Each one is free to throw out the layout; they share
// the card shell and `FeedShapes`, and nothing else.

// MARK: - A · Visits

/// One row per person, not one per Live event: who they are, and the path they have walked
/// since the window opened, with the wait between each step. The reloading visitor that
/// fills twenty rows of the log is one row here, with "×20" on the page they sat on.
struct FeedVisitsVariant: View {
    let shapes: FeedShapes
    let showsSite: Bool

    /// How many people the card draws. Past this the page is a wall and the glance is lost.
    private static let limit = 14

    var body: some View {
        let shown = Array(shapes.visits.prefix(Self.limit))
        VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, visit in
                FeedVisitRow(visit: visit, showsSite: showsSite, isLast: index == shown.count - 1)
            }
            if shapes.visits.count > shown.count {
                Text("+\(shapes.visits.count - shown.count) more people in the window")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 12)
            }
        }
    }
}

private struct FeedVisitRow: View {
    let visit: FeedVisit
    let showsSite: Bool
    let isLast: Bool

    /// The newest steps, which are the ones worth reading; an older tail is said to be cut.
    private static let steps = 7

    var body: some View {
        let steps = Array(visit.steps.suffix(Self.steps))
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(visit.isOnline ? visitsColor : Palette.line)
                    .frame(width: 7, height: 7)

                if showsSite {
                    Text(visit.siteName)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .frame(width: 104, alignment: .leading)
                }

                Text(visit.who)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if let returns = visit.returns {
                    Text(returns)
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(visitsColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(visitsColor.opacity(0.12), in: .capsule)
                        .help(visit.returnsHelp ?? returns)
                }

                Spacer(minLength: 12)

                Text("\(visit.steps.count) steps · \(visit.length)")
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .lineLimit(1)

                Text(visit.isOnline ? "here now" : visit.age)
                    .foregroundStyle(visit.isOnline ? visitsColor : .secondary)
                    .monospacedDigit()
                    .frame(width: 72, alignment: .trailing)
            }
            .font(.callout)

            FlowRow(spacing: 6) {
                if visit.steps.count > steps.count {
                    Text("…")
                        .foregroundStyle(.tertiary)
                        .help("\(visit.steps.count - steps.count) earlier steps")
                }
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    FeedStepChip(step: step, isLast: index == steps.count - 1 && visit.isOnline)
                    if let dwell = step.dwell {
                        // The same height as a chip, so the wait sits on their centre line.
                        Text(FeedShapes.span(dwell))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .frame(height: 26)
                    }
                }
            }
            .padding(.leading, 17)
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1)
            }
        }
    }
}

/// One step of a path: a page, or an action in the accent colour. A page walked twice in a
/// row carries the count rather than a second chip.
private struct FeedStepChip: View {
    let step: FeedStep
    /// The step this person is on now.
    let isLast: Bool

    var body: some View {
        HStack(spacing: 5) {
            if step.isEvent {
                Image(systemName: step.kind.symbol)
                    .font(.caption2)
            }
            Text(step.label)
                .lineLimit(1)
            if step.repeats > 1 {
                Text("×\(step.repeats)")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .fontWeight(step.isEvent ? .semibold : .regular)
        .foregroundStyle(step.isEvent ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            step.isEvent ? visitsColor.opacity(0.14) : Palette.line.opacity(0.6),
            in: .rect(cornerRadius: 5)
        )
        .overlay {
            if isLast {
                RoundedRectangle(cornerRadius: 5).strokeBorder(visitsColor.opacity(0.6))
            }
        }
        .help(step.detail ?? step.label)
    }
}

// MARK: - B · Lanes

/// The half hour as a time axis, one lane per person, a tick per Live event. Nothing else
/// says when somebody arrived, how long they stayed, who was on the site at the same time,
/// or that a burst of rows is one person and not a crowd.
///
/// Drawn in a single `Canvas`: one pass per poll rather than a view per event, which is
/// what makes a thousand ticks free.
struct FeedLanesVariant: View {
    let shapes: FeedShapes
    let showsSite: Bool

    private static let limit = 18
    private static let laneHeight: CGFloat = 22
    /// Wide enough for a site, a flag, a browser and a device on one line.
    private static let labelWidth: CGFloat = 254

    var body: some View {
        let lanes = Array(shapes.visits.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 10) {
            ruler
            Canvas(rendersAsynchronously: false) { context, size in
                draw(lanes: lanes, in: context, size: size)
            }
            .frame(height: CGFloat(lanes.count) * Self.laneHeight)
            .accessibilityHidden(true)

            HStack(spacing: 16) {
                key(colour: Color.secondary, label: "page load")
                key(colour: visitsColor, label: "action")
                key(colour: Palette.acid, label: "here now")
                Spacer()
                if shapes.visits.count > lanes.count {
                    Text("+\(shapes.visits.count - lanes.count) quieter people not drawn")
                        .foregroundStyle(.tertiary)
                }
            }
            .font(.caption)
        }
    }

    /// The time axis, along the track: −30m on the left, now on the right.
    private var ruler: some View {
        GeometryReader { geometry in
            let track = max(geometry.size.width - Self.labelWidth, 1)
            ZStack(alignment: .topLeading) {
                ForEach([0, 1, 2, 3], id: \.self) { index in
                    let fraction = CGFloat(index) / 3
                    let minutes = Int(Double(shapes.windowMinutes) * (1 - Double(fraction)))
                    Text(minutes == 0 ? "now" : "−\(minutes)m")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        // The last label is pulled inside the card rather than centred on
                        // the track's end, where half of it would sit outside.
                        .position(x: Self.labelWidth + track * fraction - (index == 3 ? 14 : 0), y: 7)
                }
            }
        }
        .frame(height: 14)
    }

    private func key(colour: Color, label: String) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 1).fill(colour).frame(width: 3, height: 9)
            Text(label).foregroundStyle(.secondary)
        }
    }

    private func draw(lanes: [FeedVisit], in context: GraphicsContext, size: CGSize) {
        let trackX = Self.labelWidth
        let trackWidth = max(size.width - trackX, 1)
        let window = max(shapes.end.timeIntervalSince(shapes.start), 1)

        func x(_ date: Date) -> CGFloat {
            let fraction = date.timeIntervalSince(shapes.start) / window
            return trackX + trackWidth * max(0, min(1, fraction))
        }

        // Five-minute grid, behind everything: the ticks read as a time, not a texture.
        var grid = Path()
        var minute = 0
        while minute <= shapes.windowMinutes {
            let position = trackX + trackWidth * CGFloat(minute) / CGFloat(max(shapes.windowMinutes, 1))
            grid.move(to: CGPoint(x: position, y: 0))
            grid.addLine(to: CGPoint(x: position, y: size.height))
            minute += 5
        }
        context.stroke(grid, with: .color(Palette.line), lineWidth: 1)

        for (index, visit) in lanes.enumerated() {
            let centre = CGFloat(index) * Self.laneHeight + Self.laneHeight / 2

            // Who, in the label column: the flag, the site, and the browser and device.
            // Canvas text cannot truncate itself, so the words are cut to the column.
            let words = showsSite ? "\(visit.siteName) · \(visit.compactWho)" : visit.compactWho
            context.draw(
                Text(FeedShapes.short(words, limit: 40))
                    .font(.caption)
                    .foregroundStyle(visit.isOnline ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary)),
                at: CGPoint(x: 0, y: centre),
                anchor: .leading
            )

            // The visit itself: a bar from the first thing they did to the last.
            let from = x(visit.firstAt)
            let to = x(visit.lastAt)
            let bar = Path(
                roundedRect: CGRect(x: from, y: centre - 1.5, width: max(to - from, 2), height: 3),
                cornerRadius: 1.5
            )
            context.fill(bar, with: .color(visit.isOnline ? visitsColor.opacity(0.45) : .secondary.opacity(0.22)))

            for step in visit.steps {
                let position = x(step.at)
                let isEvent = step.isEvent
                let height: CGFloat = isEvent ? 15 : 11
                let width: CGFloat = isEvent ? 3 : 2
                let tick = Path(
                    roundedRect: CGRect(x: position - width / 2, y: centre - height / 2, width: width, height: height),
                    cornerRadius: 1
                )
                context.fill(tick, with: .color(isEvent ? visitsColor : .secondary))
                // A page sat on and reloaded reads as one taller tick, not as a crowd.
                if step.repeats > 1 {
                    context.fill(
                        Path(ellipseIn: CGRect(x: position - 2, y: centre - height / 2 - 5, width: 4, height: 4)),
                        with: .color(.secondary)
                    )
                }
            }

            // Still on the site: the guide's acid, at the end of the lane.
            if visit.isOnline {
                context.fill(
                    Path(ellipseIn: CGRect(x: min(to, size.width - 6) - 3, y: centre - 3, width: 6, height: 6)),
                    with: .color(Palette.acid)
                )
            }
        }
    }
}

// MARK: - C · Pressure

/// No time axis at all: the window summed by page, one column per site, each page a tile as
/// tall as its share of the site's loads. It answers the question the log cannot — where
/// attention is sitting right now — and a page that is being hammered is a block, not
/// twenty rows.
struct FeedPressureVariant: View {
    let shapes: FeedShapes

    /// The height the busiest site's tiles share. Every other site is measured against it,
    /// so the columns can be read side by side: a quiet site is a short column, not a full
    /// one drawn from smaller numbers.
    private static let columnHeight: CGFloat = 300

    var body: some View {
        let peak = max(shapes.columns.map { $0.views + $0.events }.max() ?? 1, 1)
        HStack(alignment: .top, spacing: 12) {
            ForEach(shapes.columns) { column in
                FeedPressureColumn(
                    column: column,
                    budget: Self.columnHeight * CGFloat(column.views + column.events) / CGFloat(peak)
                )
            }
        }
    }
}

private struct FeedPressureColumn: View {
    let column: FeedSiteColumn
    /// The height this site's tiles share: its own weight against the busiest site's.
    let budget: CGFloat

    /// The shortest a tile may be and still carry its page on one line. A tile shorter than
    /// its own words does not clip — it draws over the tile under it.
    private static let floor: CGFloat = 32
    /// Below this a tile has room for the page and nothing else.
    private static let detailFloor: CGFloat = 50

    var body: some View {
        // Only as many pages as the budget can draw at a readable height.
        let room = max(1, Int(budget / Self.floor))
        let shown = Array(column.pages.prefix(room))
        let total = max(column.pages.reduce(0) { $0 + $1.views + $1.events }, 1)
        let gaps = CGFloat(max(shown.count - 1, 0)) * 4
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(column.online > 0 ? visitsColor : Palette.line)
                    .frame(width: 6, height: 6)
                Text(column.name)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text("\(column.views) loads")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .font(.callout)

            VStack(spacing: 4) {
                ForEach(shown) { page in
                    let share = Double(page.views + page.events) / Double(total)
                    let height = max(Self.floor, (budget - gaps) * share)
                    FeedPressureTile(page: page, showsDetail: height >= Self.detailFloor)
                        .frame(height: height)
                }
            }

            if column.pages.count > shown.count {
                let rest = column.pages.count - shown.count
                Text("+\(rest) quieter \(rest == 1 ? "page" : "pages")")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// One page. Size says how much of the site's window it took; the edge says how fresh the
/// last load was, so a page that has gone quiet fades without moving.
private struct FeedPressureTile: View {
    let page: FeedPage
    /// Whether the tile is tall enough for the line under the page.
    let showsDetail: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Text(page.page)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                // A tile too short for the line below still says an action happened on it:
                // it is the most interesting thing a page can carry.
                if page.events > 0, !showsDetail {
                    HStack(spacing: 2) {
                        Image(systemName: "bolt.fill")
                        Text("\(page.events)").monospacedDigit()
                    }
                    .font(.caption2)
                    .foregroundStyle(visitsColor)
                }
                // A page nobody loaded in the window but somebody acted on carries the
                // action count, not a zero that reads as "nothing happened here".
                Text(page.views > 0 ? "\(page.views)" : "\(page.events)")
                    .font(.callout)
                    .monospacedDigit()
                    .fontWeight(.medium)
                    .foregroundStyle(page.views > 0 ? AnyShapeStyle(.primary) : AnyShapeStyle(visitsColor))
            }
            if showsDetail {
                HStack(spacing: 6) {
                    Text("\(page.people) \(page.people == 1 ? "person" : "people")")
                    if page.events > 0 {
                        Text("· \(page.events) \(page.events == 1 ? "action" : "actions")")
                            .foregroundStyle(visitsColor)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(visitsColor.opacity(0.05 + 0.16 * page.heat), in: .rect(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(visitsColor.opacity(0.12 + 0.5 * page.heat))
        )
        .help("\(page.page) — \(page.views) loads by \(page.people) people")
    }
}

// MARK: - D · Paths

/// Where people went next: every walk from one page to the next inside the window, drawn as
/// a flow. One band per site, the busiest first. The log holds the same facts — the same
/// visitor token on two rows in a row — but nothing in its shape lets them be read.
///
/// One step only, never a journey: the window cuts both ends, so a chain of three pages
/// would be a claim the data cannot make.
struct FeedPathsVariant: View {
    let shapes: FeedShapes

    private static let bands = 3

    var body: some View {
        let sites = shapes.columns
            .filter { column in shapes.transitions.contains { $0.siteID == column.id } }
            .prefix(Self.bands)
        VStack(alignment: .leading, spacing: 18) {
            if sites.isEmpty {
                Text("Nobody has walked from one page to another in the window yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                ForEach(Array(sites)) { column in
                    FeedPathBand(
                        name: column.name,
                        walks: shapes.transitions.filter { $0.siteID == column.id }
                    )
                }
                Text("A walk is one page load followed by another by the same visitor, inside the last \(shapes.windowMinutes) minutes.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

/// One site's walks. Left: the pages people left. Right: the pages they went to. The ribbon
/// between them is as thick as the number who took it.
///
/// A walk is worth the same height in every band, so a site with one walk is a thin band and
/// a site with twenty is a deep one. Bands of equal height, each filled from its own total,
/// made one walk on a quiet site look like the busiest thing on the page.
private struct FeedPathBand: View {
    let name: String
    let walks: [FeedTransition]

    private static let nodes = 6
    private static let barWidth: CGFloat = 10
    private static let labelWidth: CGFloat = 190
    /// The height of one walk, everywhere on the card.
    private static let unit: CGFloat = 14
    private static let gap: CGFloat = 8
    /// A page walked once still needs a bar that can be seen.
    private static let floor: CGFloat = 12

    private var sources: [(label: String, total: Int)] { Self.side(walks, by: \.from) }
    private var targets: [(label: String, total: Int)] { Self.side(walks, by: \.to) }

    /// As tall as the side that needs the most room.
    private var height: CGFloat {
        max(Self.height(of: sources), Self.height(of: targets))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(name)
                    .font(.callout.weight(.medium))
                Text("\(walks.reduce(0) { $0 + $1.count }) \(walks.reduce(0) { $0 + $1.count } == 1 ? "walk" : "walks")")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            Canvas(rendersAsynchronously: false) { context, size in
                draw(in: context, size: size)
            }
            .frame(height: height)
            .accessibilityHidden(true)
        }
    }

    /// The pages on one side, biggest first, with everything past the cap folded into one.
    private static func side(_ walks: [FeedTransition], by key: (FeedTransition) -> String) -> [(label: String, total: Int)] {
        var totals: [String: Int] = [:]
        for walk in walks { totals[key(walk), default: 0] += walk.count }
        let sorted = totals
            .map { (label: $0.key, total: $0.value) }
            .sorted { $0.total != $1.total ? $0.total > $1.total : $0.label < $1.label }
        guard sorted.count > nodes else { return sorted }
        let rest = sorted.dropFirst(nodes).reduce(0) { $0 + $1.total }
        return Array(sorted.prefix(nodes)) + [(label: "+\(sorted.count - nodes) other pages", total: rest)]
    }

    private static func height(of entries: [(label: String, total: Int)]) -> CGFloat {
        let bars = entries.reduce(CGFloat.zero) { $0 + max(floor, CGFloat($1.total) * unit) }
        return bars + gap * CGFloat(max(entries.count - 1, 0))
    }

    /// Where each page sits on its side, at the card's one scale.
    private static func slots(_ entries: [(label: String, total: Int)]) -> [String: CGRect] {
        var rects: [String: CGRect] = [:]
        var y: CGFloat = 0
        for entry in entries {
            let bar = max(floor, CGFloat(entry.total) * unit)
            rects[entry.label] = CGRect(x: 0, y: y, width: barWidth, height: bar)
            y += bar + gap
        }
        return rects
    }

    private func draw(in context: GraphicsContext, size: CGSize) {
        let sources = self.sources
        let targets = self.targets
        let leftX = Self.labelWidth
        let rightX = size.width - Self.labelWidth - Self.barWidth
        let leftSlots = Self.slots(sources)
        let rightSlots = Self.slots(targets)
        let names = Set(sources.map(\.label))
        let targetNames = Set(targets.map(\.label))

        // The ribbons first, so the bars close them off.
        var leftUsed: [String: CGFloat] = [:]
        var rightUsed: [String: CGFloat] = [:]
        for walk in walks.sorted(by: { $0.count > $1.count }) {
            let from = names.contains(walk.from) ? walk.from : sources.last?.label ?? walk.from
            let to = targetNames.contains(walk.to) ? walk.to : targets.last?.label ?? walk.to
            guard let leftSlot = leftSlots[from], let rightSlot = rightSlots[to] else { continue }

            let leftTotal = max(sources.first(where: { $0.label == from })?.total ?? 1, 1)
            let rightTotal = max(targets.first(where: { $0.label == to })?.total ?? 1, 1)
            let leftHeight = leftSlot.height * CGFloat(walk.count) / CGFloat(leftTotal)
            let rightHeight = rightSlot.height * CGFloat(walk.count) / CGFloat(rightTotal)
            let leftY = leftSlot.minY + (leftUsed[from] ?? 0)
            let rightY = rightSlot.minY + (rightUsed[to] ?? 0)
            leftUsed[from] = (leftUsed[from] ?? 0) + leftHeight
            rightUsed[to] = (rightUsed[to] ?? 0) + rightHeight

            let startX = leftX + Self.barWidth
            let endX = rightX
            let control = (startX + endX) / 2
            var ribbon = Path()
            ribbon.move(to: CGPoint(x: startX, y: leftY))
            ribbon.addCurve(
                to: CGPoint(x: endX, y: rightY),
                control1: CGPoint(x: control, y: leftY),
                control2: CGPoint(x: control, y: rightY)
            )
            ribbon.addLine(to: CGPoint(x: endX, y: rightY + rightHeight))
            ribbon.addCurve(
                to: CGPoint(x: startX, y: leftY + leftHeight),
                control1: CGPoint(x: control, y: rightY + rightHeight),
                control2: CGPoint(x: control, y: leftY + leftHeight)
            )
            ribbon.closeSubpath()
            context.fill(ribbon, with: .color(visitsColor.opacity(0.22)))
        }

        // The bars and their pages.
        for entry in sources {
            guard let slot = leftSlots[entry.label] else { continue }
            let rect = CGRect(x: leftX, y: slot.minY, width: Self.barWidth, height: slot.height)
            context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(visitsColor.opacity(0.7)))
            context.draw(
                Text("\(FeedShapes.short(entry.label, limit: 26))  \(entry.total)").font(.caption),
                at: CGPoint(x: leftX - 10, y: rect.midY),
                anchor: .trailing
            )
        }
        for entry in targets {
            guard let slot = rightSlots[entry.label] else { continue }
            let rect = CGRect(x: rightX, y: slot.minY, width: Self.barWidth, height: slot.height)
            context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(Palette.acid.opacity(0.7)))
            context.draw(
                Text("\(entry.total)  \(FeedShapes.short(entry.label, limit: 26))").font(.caption),
                at: CGPoint(x: rightX + Self.barWidth + 10, y: rect.midY),
                anchor: .leading
            )
        }
    }
}

// MARK: - E · Signals

/// Actions first. A page load is traffic; a named action is somebody using the product, and
/// in the log the two are the same row, so `update-character` sits between twenty reloads of
/// a shader page. Here the actions are cards with their data, and the page loads are the
/// pulse behind them — present, counted, and never in the way.
struct FeedSignalsVariant: View {
    let shapes: FeedShapes
    let showsSite: Bool

    private static let limit = 8

    var body: some View {
        let shown = Array(shapes.signals.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 18) {
            pulse

            if shown.isEmpty {
                Text("No actions in the window — only page loads.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 72, alignment: .center)
            } else {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: 2),
                    alignment: .leading,
                    spacing: 12
                ) {
                    ForEach(shown) { signal in
                        FeedSignalCard(signal: signal, showsSite: showsSite)
                    }
                }
                if shapes.signals.count > shown.count {
                    Text("+\(shapes.signals.count - shown.count) earlier actions in the window")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    /// Page loads per minute, oldest on the left: the traffic the actions happened inside.
    private var pulse: some View {
        let peak = max(shapes.pulse.max() ?? 1, 1)
        let total = Int(shapes.pulse.reduce(0, +))
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("\(total) page loads")
                    .monospacedDigit()
                Text("in the last \(shapes.windowMinutes) minutes")
                    .foregroundStyle(.tertiary)
                Spacer()
                Text("\(shapes.signals.count) actions")
                    .monospacedDigit()
                    .foregroundStyle(visitsColor)
            }
            .font(.caption)

            HStack(alignment: .bottom, spacing: 2) {
                ForEach(shapes.pulse.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(shapes.pulse[index] > 0 ? Color.secondary.opacity(0.5) : Palette.line)
                        .frame(height: max(3, 22 * shapes.pulse[index] / peak))
                }
            }
            .frame(height: 22)
        }
        .accessibilityHidden(true)
    }
}

private struct FeedSignalCard: View {
    let signal: FeedSignal
    let showsSite: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: signal.kind.symbol)
                    .foregroundStyle(visitsColor)
                Text(signal.name)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 6)
                Text(signal.age)
                    .font(.callout)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }

            if signal.properties.isEmpty {
                Text("no data")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                FlowRow(spacing: 6) {
                    ForEach(signal.properties) { property in
                        HStack(spacing: 5) {
                            Text(property.key)
                                .foregroundStyle(.secondary)
                            Text(property.value)
                                .fontWeight(.medium)
                        }
                        .font(.caption)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Palette.line.opacity(0.6), in: .rect(cornerRadius: 4))
                    }
                }
            }

            HStack(spacing: 6) {
                if showsSite {
                    Text(signal.siteName)
                        .fontWeight(.medium)
                    Text("·")
                        .foregroundStyle(.tertiary)
                }
                Text(signal.page)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 6)
                if let returns = signal.returns {
                    Text(returns)
                        .monospacedDigit()
                        .foregroundStyle(visitsColor)
                }
                Text(signal.compactWho)
                    .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(visitsColor.opacity(0.07), in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(visitsColor.opacity(0.25)))
    }
}
