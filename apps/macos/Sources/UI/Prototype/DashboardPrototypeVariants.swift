#if DEBUG
import AppKit
import Charts
import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `DashboardPrototype` for the question.

// MARK: - Shared small parts

/// A run drawn small: the period as a line over a faint fill, the period before as a grey
/// line behind it. No axes, no hover — a spark is a shape, and the figure beside it is the
/// number. Drawn as a path rather than with Charts, because a page can hold thirty of them.
struct ProtoSpark: View {
    let run: ComparisonRun
    let color: Color
    var showsPrevious = true

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let now = run.current.map(\.value)
            let was = showsPrevious ? run.previous : []
            let top = max((now + was).max() ?? 0, 0.0001)
            ZStack {
                if was.count > 1 {
                    Self.path(was, in: size, top: top)
                        .stroke(Color.secondary.opacity(0.55), style: StrokeStyle(lineWidth: 1, lineJoin: .round))
                }
                if now.count > 1 {
                    Self.area(now, in: size, top: top)
                        .fill(LinearGradient(colors: [color.opacity(0.18), color.opacity(0.01)], startPoint: .top, endPoint: .bottom))
                    Self.path(now, in: size, top: top)
                        .stroke(color, style: StrokeStyle(lineWidth: 1.4, lineJoin: .round))
                }
            }
        }
        .accessibilityHidden(true)
    }

    private static func points(_ values: [Double], in size: CGSize, top: Double) -> [CGPoint] {
        let step = values.count > 1 ? size.width / CGFloat(values.count - 1) : size.width
        return values.enumerated().map { index, value in
            CGPoint(x: CGFloat(index) * step, y: size.height - CGFloat(value / top) * (size.height - 1) - 0.5)
        }
    }

    private static func path(_ values: [Double], in size: CGSize, top: Double) -> Path {
        Path { path in path.addLines(points(values, in: size, top: top)) }
    }

    private static func area(_ values: [Double], in size: CGSize, top: Double) -> Path {
        let marks = points(values, in: size, top: top)
        // Built point by point: `addLines` starts a subpath of its own, which closed the
        // fill from the last point straight back to the first and drew a wedge.
        return Path { path in
            guard let first = marks.first, let last = marks.last else { return }
            path.move(to: CGPoint(x: first.x, y: size.height))
            for mark in marks {
                path.addLine(to: mark)
            }
            path.addLine(to: CGPoint(x: last.x, y: size.height))
            path.closeSubpath()
        }
    }
}

/// A site's mark and name on one line, at one of two sizes.
struct ProtoSiteName: View {
    let site: Site
    let icon: Image?
    var font: Font = .headline
    var markSize: CGFloat = 16

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let icon {
                    icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 3))
                } else {
                    Image(systemName: "globe").foregroundStyle(.secondary)
                }
            }
            .frame(width: markSize, height: markSize)
            Text(site.name)
                .font(font)
                .lineLimit(1)
        }
    }
}

/// A figure with its move under it, right-aligned: the pair the dense shapes repeat.
struct ProtoFigure: View {
    let value: String
    let move: String?
    let tint: Color?
    var size: CGFloat = 15

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(value)
                .font(.system(size: size, weight: .regular))
                .monospacedDigit()
            Text(move ?? " ")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(tint ?? .secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The growth as the app already reads it: the percentage in its colour, the word beside it.
struct ProtoGrowthLine: View {
    let growth: Growth?
    var size: CGFloat = 22

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(growth.map { GrowthReading.label($0) } ?? "—")
                .font(.system(size: size, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(growth.flatMap { GrowthReading.tint($0) } ?? .primary)
            if let growth {
                Text(GrowthReading.word(growth))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - H — Hero

/// The fleet leads. One large chart of the chosen source across every site — the period over
/// the period before — with the fleet's own figure beside the switch that picks the source;
/// under it the four projects as small tiles, each carrying that same source. The page reads
/// top-down as one question: how is the whole thing doing, and who is doing it.
struct HeroVariant: View {
    let projects: [ProtoProject]
    let period: Period
    @Binding var metric: ProtoMetric
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            hero
            ProtoTileGrid(projects: projects, perRow: 4) { project in
                tile(project)
            }
        }
        .column()
    }

    private var hero: some View {
        let growth = ProtoSeries.growth(projects, metric: metric)
        let run = ProtoSeries.total(projects, metric: metric)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Circle().fill(metric.color).frame(width: 6, height: 6)
                        Text(metric.label)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(figure(growth))
                            .font(.system(size: 34, weight: .medium))
                            .monospacedDigit()
                        ProtoGrowthLine(growth: growth, size: 17)
                    }
                    Text(was(growth))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                WordSwitch(options: ProtoMetric.allCases, selection: $metric, label: \.label)
            }
            .padding(.bottom, 18)

            ComparisonChart(run: run, color: metric.color, format: label)
                .frame(height: 180)

            // The three Search Console figures the chart cannot carry, on the chart's foot.
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(totals.enumerated()), id: \.offset) { _, total in
                    Metric(title: total.title, value: total.value, change: total.change, tint: total.tint, dot: total.dot)
                    Spacer(minLength: 20)
                }
                Metric(title: "Projects", value: String(projects.count))
            }
            .padding(.top, 18)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(cornerRadius: 12)
    }

    /// One project, small: the name, the chosen source's growth, the count it came from, and
    /// the spark. Every tile the same height, whatever the site has.
    private func tile(_ project: ProtoProject) -> some View {
        let growth = project.growth(metric)
        return VStack(alignment: .leading, spacing: 8) {
            ProtoSiteName(site: project.site, icon: icon(project.id), font: .subheadline.weight(.semibold), markSize: 14)
            ProtoGrowthLine(growth: growth, size: 20)
            Text(growth == nil ? "No \(metric.label.lowercased()) source" : "\(project.figure(metric)) \(metric.unit)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            ProtoSpark(run: project.run(metric), color: metric.color)
                .frame(height: 30)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { onOpen(project.id) }
    }

    private func figure(_ growth: Growth?) -> String {
        guard let growth else { return "—" }
        return metric == .sales
            ? Money.format(growth.current, currency: ProtoSeries.currency(projects))
            : GlanceFigure.count(growth.current)
    }

    private func label(_ value: Double) -> String {
        metric == .sales
            ? Money.format(value * 100, currency: ProtoSeries.currency(projects))
            : GlanceFigure.count(value)
    }

    private func was(_ growth: Growth?) -> String {
        guard let previous = growth?.previous else { return "Nothing stored for the period before" }
        return "was \(metric == .sales ? Money.format(previous, currency: ProtoSeries.currency(projects)) : GlanceFigure.count(previous)) the period before"
    }

    /// Impressions, the click-through rate and the position, summed the way the strip does.
    private var totals: [(title: String, value: String, change: String?, tint: Color?, dot: Color?)] {
        let comparison = OverviewGlance.total(projects.map(\.glance))
        let stats = comparison.currentStats
        return [
            ("Impressions", GlanceFigure.count(stats.impressions),
             comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
             comparison.impressions.map { GlanceFigure.tint($0.delta) }, Palette.amber),
            ("Click-through rate", GlanceFigure.rate(stats.ctr),
             comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
             comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }, nil),
            ("Position", GlanceFigure.position(stats.position),
             comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
             comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }, nil),
        ]
    }
}

/// Tiles in rows of a fixed count, laid with stacks rather than a lazy grid: a still has to
/// draw them, and lazy content in an `ImageRenderer` comes out empty.
struct ProtoTileGrid<Tile: View>: View {
    let projects: [ProtoProject]
    let perRow: Int
    @ViewBuilder let tile: (ProtoProject) -> Tile

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(row) { project in
                        tile(project)
                    }
                    // A short last row keeps the tile width of a full one.
                    if row.count < perRow {
                        ForEach(0..<(perRow - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var rows: [[ProtoProject]] {
        stride(from: 0, to: projects.count, by: perRow).map {
            Array(projects[$0..<min($0 + perRow, projects.count)])
        }
    }
}

// MARK: - M — Mosaic

/// The page cut by source instead of by site: four tiles — Search, Visitors, Sales, Plan —
/// and inside each the fleet's figure over the sites ranked against one another, strongest
/// first, with a bar for each site's share of that source. The only shape here that answers
/// "which project is carrying this", and the only one that leaves the reading column: a
/// mosaic wants the pane's whole width.
struct MosaicVariant: View {
    let projects: [ProtoProject]
    let period: Period
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                sourceTile(.clicks)
                sourceTile(.visits)
            }
            HStack(alignment: .top, spacing: 14) {
                sourceTile(.sales)
                planTile
            }
        }
        .padding(.horizontal, SiteTabScreen.columnInset)
        .frame(maxWidth: .infinity)
    }

    private func sourceTile(_ metric: ProtoMetric) -> some View {
        let growth = ProtoSeries.growth(projects, metric: metric)
        let ranked = projects.sorted { ($0.growth(metric)?.current ?? 0) > ($1.growth(metric)?.current ?? 0) }
        return TileFrame(
            title: metric.label,
            dot: metric.color,
            figure: metric == .sales
                ? Money.format(growth?.current ?? 0, currency: ProtoSeries.currency(projects))
                : GlanceFigure.count(growth?.current ?? 0),
            growth: growth,
            chart: AnyView(
                ProtoSpark(run: ProtoSeries.total(projects, metric: metric), color: metric.color)
                    .frame(height: 44)
            )
        ) {
            ForEach(ranked) { project in
                shareRow(project, metric: metric)
            }
        }
    }

    /// One site inside a source tile: the mark, the name, the share of the source as a bar,
    /// then its own figure and its own move. The bar is what ranks; the figure is the fact.
    private func shareRow(_ project: ProtoProject, metric: ProtoMetric) -> some View {
        let share = ProtoSeries.share(project, of: projects, metric: metric)
        let growth = project.growth(metric)
        return HStack(spacing: 10) {
            ProtoSiteName(site: project.site, icon: icon(project.id), font: .callout, markSize: 13)
                .frame(width: 132, alignment: .leading)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.line)
                    Capsule()
                        .fill(metric.color.opacity(growth == nil ? 0 : 0.75))
                        .frame(width: max(geometry.size.width * share, share > 0 ? 3 : 0))
                }
            }
            .frame(height: 6)

            Text(project.figure(metric))
                .font(.callout)
                .monospacedDigit()
                .frame(width: 74, alignment: .trailing)

            Text(growth.map { GrowthReading.label($0) } ?? "—")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(growth.flatMap { GrowthReading.tint($0) } ?? .secondary)
                .frame(width: 46, alignment: .trailing)
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { onOpen(project.id) }
        .accessibilityElement(children: .combine)
    }

    /// The plan has no run to draw, so its tile carries the fleet's funnel instead: planned,
    /// published, indexed, reached, clicked, each a bar against the pages planned; and one
    /// row per site with the share Google holds.
    private var planTile: some View {
        let plans = projects.compactMap(\.trajectory.plan)
        let planned = plans.reduce(0) { $0 + $1.funnel.planned }
        let indexed = plans.reduce(0) { $0 + $1.funnel.indexed }
        let steps: [(String, Int)] = [
            ("Planned", planned),
            ("Published", plans.reduce(0) { $0 + $1.funnel.published }),
            ("Indexed", indexed),
            ("Reached", plans.reduce(0) { $0 + $1.funnel.reached }),
            ("Clicked", plans.reduce(0) { $0 + $1.funnel.clicked }),
        ]
        return TileFrame(
            title: "Plan",
            dot: Palette.mint,
            figure: planned > 0 ? (Double(indexed) / Double(planned)).formatted(.percent.precision(.fractionLength(0))) : "—",
            growth: nil,
            subtitle: "\(indexed) of \(planned) planned pages indexed",
            chart: AnyView(
                VStack(spacing: 5) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        HStack(spacing: 10) {
                            Text(step.0)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 70, alignment: .leading)
                            GeometryReader { geometry in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Palette.line)
                                    Capsule()
                                        .fill(Palette.mint.opacity(0.75))
                                        .frame(width: planned > 0 ? geometry.size.width * Double(step.1) / Double(planned) : 0)
                                }
                            }
                            .frame(height: 6)
                            Text(String(step.1))
                                .font(.caption)
                                .monospacedDigit()
                                .frame(width: 34, alignment: .trailing)
                        }
                    }
                }
            )
        ) {
            ForEach(projects) { project in
                HStack(spacing: 10) {
                    ProtoSiteName(site: project.site, icon: icon(project.id), font: .callout, markSize: 13)
                        .frame(width: 132, alignment: .leading)
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Palette.line)
                            Capsule()
                                .fill(Palette.mint.opacity(0.75))
                                .frame(width: geometry.size.width * (project.trajectory.plan?.indexedShare ?? 0))
                        }
                    }
                    .frame(height: 6)
                    Text(project.trajectory.plan.map { "\($0.funnel.indexed) of \($0.funnel.planned)" } ?? "—")
                        .font(.callout)
                        .monospacedDigit()
                        .frame(width: 74, alignment: .trailing)
                    Text(project.trajectory.plan?.indexedShare.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(width: 46, alignment: .trailing)
                }
            }
        }
    }
}

/// One tile of the mosaic: the source's name and figure, its picture, a hairline, then the
/// sites. Every tile the same frame, so the four read as one board.
private struct TileFrame<Rows: View>: View {
    let title: String
    let dot: Color
    let figure: String
    let growth: Growth?
    var subtitle: String? = nil
    let chart: AnyView
    @ViewBuilder let rows: () -> Rows

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Circle().fill(dot).frame(width: 6, height: 6)
                        Text(title)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(figure)
                            .font(.system(size: 24, weight: .medium))
                            .monospacedDigit()
                        if growth != nil {
                            ProtoGrowthLine(growth: growth, size: 14)
                        }
                    }
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            chart

            Palette.line.frame(height: 1)

            VStack(spacing: 9) {
                rows()
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(cornerRadius: 12)
    }
}

// MARK: - C — Calendar

/// No line anywhere: the period as cells, one per day, one band per site, each cell tinted by
/// how strong that day was for that site against its own best day. What it answers that a
/// line does not: which weekdays a site is found on, the day a site started counting, and
/// the week where nothing happened at all.
struct CalendarVariant: View {
    let projects: [ProtoProject]
    let period: Period
    @Binding var metric: ProtoMetric
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center) {
                Text(period.days > 31 ? "Week by week" : "Day by day")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                WordSwitch(options: ProtoMetric.allCases, selection: $metric, label: \.label)
                Spacer().frame(width: 24)
                legend
            }

            VStack(spacing: 14) {
                ForEach(projects) { project in
                    band(project)
                }
            }

            Palette.line.frame(height: 1)
            scale
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(cornerRadius: 12)
        .column()
    }

    /// One site: the name and its period total on the left, then the days.
    private func band(_ project: ProtoProject) -> some View {
        let points = project.run(metric).current
        let best = points.map(\.measured).max() ?? 0
        return HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                ProtoSiteName(site: project.site, icon: icon(project.id), font: .subheadline.weight(.semibold), markSize: 14)
                HStack(spacing: 6) {
                    Text(project.figure(metric))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text(project.growth(metric).map { GrowthReading.label($0) } ?? "")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(project.growth(metric).flatMap { GrowthReading.tint($0) } ?? .secondary)
                }
                // Each band is tinted against its own best day, so the band has to say what
                // that day was: without it a site with two clicks a day reads as strong as
                // one with a hundred.
                Text(best > 0 ? "best day \(GlanceFigure.count(best))" : "nothing this period")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .frame(width: 160, alignment: .leading)

            HStack(spacing: 3) {
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(metric.color.opacity(Self.weight(point.measured, best: best)))
                        .frame(maxWidth: .infinity)
                        .frame(height: 26)
                        .help("\(point.date.formatted(.dateTime.day().month(.abbreviated))): \(GlanceFigure.count(point.measured))")
                }
                if points.isEmpty {
                    Text("Nothing stored")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { onOpen(project.id) }
    }

    /// A day with nothing keeps a cell, faint: an empty day is a fact, not a gap.
    private static func weight(_ value: Double, best: Double) -> Double {
        guard best > 0 else { return 0.06 }
        guard value > 0 else { return 0.06 }
        return 0.18 + 0.82 * (value / best)
    }

    private var legend: some View {
        HStack(spacing: 5) {
            Text("less")
                .font(.caption2)
                .foregroundStyle(.secondary)
            ForEach(Array([0.06, 0.3, 0.55, 0.8, 1.0].enumerated()), id: \.offset) { _, weight in
                RoundedRectangle(cornerRadius: 2)
                    .fill(metric.color.opacity(weight))
                    .frame(width: 12, height: 12)
            }
            Text("more")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    /// The first and last day under the cells, with the middle marked, so a cell can be
    /// placed in time without a tooltip.
    private var scale: some View {
        let points = projects.map { $0.run(metric).current }.max(by: { $0.count < $1.count }) ?? []
        return HStack {
            Spacer().frame(width: 174)
            if let first = points.first, let last = points.last {
                Text(first.date.formatted(.dateTime.day().month(.abbreviated)))
                Spacer()
                if points.count > 6, let middle = points[safe: points.count / 2] {
                    Text(middle.date.formatted(.dateTime.day().month(.abbreviated)))
                    Spacer()
                }
                Text(last.date.formatted(.dateTime.day().month(.abbreviated)))
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - L — League

/// The scoreboard: one table, one row per project, fixed columns, every figure right-aligned
/// and monospaced with its move under it, and the fleet on a foot row under a hairline. The
/// quietest of the four and the only one that lets two projects be compared by running the
/// eye down a column.
struct LeagueVariant: View {
    let projects: [ProtoProject]
    let period: Period
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @State private var hovered: Site.ID?

    private static let nameWidth: CGFloat = 168
    private static let cellWidth: CGFloat = 86
    private static let rowHeight: CGFloat = 46

    var body: some View {
        VStack(spacing: 0) {
            head
            Palette.line.frame(height: 1)
            ForEach(Array(ranked.enumerated()), id: \.element.id) { index, project in
                if index > 0 {
                    Palette.line.frame(height: 1)
                }
                row(project)
            }
            Palette.line.frame(height: 1)
            foot
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .cardSurface(cornerRadius: 12)
        .column()
    }

    /// Strongest first by clicks — a scoreboard has an order, and the fleet's own order is
    /// the tab bar's, which says nothing about how a project does.
    private var ranked: [ProtoProject] {
        projects.sorted { $0.trajectory.clicks.current > $1.trajectory.clicks.current }
    }

    private var head: some View {
        HStack(spacing: 0) {
            Text("Project")
                .frame(width: Self.nameWidth, alignment: .leading)
            column("Clicks")
            column("Impressions")
            column("Visits")
            column("Sales")
            column("Indexed")
            Text(period == .m3 || period == .m6 ? period.label : "\(period.days) days")
                .frame(width: 96, alignment: .trailing)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .padding(.top, 6)
    }

    private func column(_ title: String) -> some View {
        Text(title)
            .frame(width: Self.cellWidth, alignment: .trailing)
            .padding(.trailing, 14)
    }

    private func row(_ project: ProtoProject) -> some View {
        let trajectory = project.trajectory
        let comparison = project.glance.comparison
        return HStack(spacing: 0) {
            ProtoSiteName(site: project.site, icon: icon(project.id), font: .callout.weight(.medium))
                .frame(width: Self.nameWidth, alignment: .leading)

            cell(GlanceFigure.count(trajectory.clicks.current), growth: trajectory.clicks)
            cell(
                GlanceFigure.count(comparison.currentStats.impressions),
                move: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { GlanceFigure.tint($0.delta) }
            )
            cell(trajectory.visits.map { GlanceFigure.count($0.current) } ?? "—", growth: trajectory.visits)
            cell(
                trajectory.sales.map { Money.format($0.growth.current, currency: $0.currency) } ?? "—",
                growth: trajectory.sales?.growth
            )
            cell(
                trajectory.plan?.indexedShare.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "—",
                move: trajectory.plan?.indexedMove.map { Trend.signed($0, fractionDigits: 0) + "pp" },
                tint: trajectory.plan?.indexedMove.map { GlanceFigure.tint($0) }
            )

            ProtoSpark(run: trajectory.clicksRun, color: Palette.blue)
                .frame(width: 96, height: 26)
        }
        .padding(.horizontal, 16)
        .frame(height: Self.rowHeight)
        .background(hovered == project.id ? Palette.line.opacity(0.5) : .clear)
        .contentShape(Rectangle())
        .onHover { hovered = $0 ? project.id : nil }
        .onTapGesture(count: 2) { onOpen(project.id) }
        .accessibilityElement(children: .combine)
    }

    /// The fleet on the same columns, so the table adds up in front of the reader.
    private var foot: some View {
        let comparison = OverviewGlance.total(projects.map(\.glance))
        let clicks = ProtoSeries.growth(projects, metric: .clicks)
        let visits = ProtoSeries.growth(projects, metric: .visits)
        let sales = ProtoSeries.growth(projects, metric: .sales)
        let plans = projects.compactMap(\.trajectory.plan)
        let planned = plans.reduce(0) { $0 + $1.funnel.planned }
        let indexed = plans.reduce(0) { $0 + $1.funnel.indexed }
        return HStack(spacing: 0) {
            Text("\(projects.count) projects")
                .font(.callout.weight(.semibold))
                .frame(width: Self.nameWidth, alignment: .leading)
            cell(GlanceFigure.count(comparison.currentStats.clicks), growth: clicks)
            cell(
                GlanceFigure.count(comparison.currentStats.impressions),
                move: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { GlanceFigure.tint($0.delta) }
            )
            cell(visits.map { GlanceFigure.count($0.current) } ?? "—", growth: visits)
            cell(sales.map { Money.format($0.current, currency: ProtoSeries.currency(projects)) } ?? "—", growth: sales)
            cell(planned > 0 ? (Double(indexed) / Double(planned)).formatted(.percent.precision(.fractionLength(0))) : "—")
            ProtoSpark(run: ProtoSeries.total(projects, metric: .clicks), color: Palette.blue)
                .frame(width: 96, height: 26)
        }
        .padding(.horizontal, 16)
        .frame(height: Self.rowHeight)
    }

    private func cell(_ value: String, growth: Growth? = nil) -> some View {
        cell(value, move: growth.map { GrowthReading.label($0) }, tint: growth.flatMap { GrowthReading.tint($0) })
    }

    private func cell(_ value: String, move: String? = nil, tint: Color? = nil) -> some View {
        ProtoFigure(value: value, move: move, tint: tint)
            .frame(width: Self.cellWidth, alignment: .trailing)
            .padding(.trailing, 14)
    }
}

// MARK: - H2 / H3 — Broken out

/// Round two of H. Three things change from round one.
///
/// The chart leaves its card and runs the pane's full width, the way a site's dashboard
/// draws its own: the strip and the projects keep the reading column, the plot reaches both
/// edges, and its end dates are set outside the plot at the column inset. A card around a
/// chart makes the chart an item on the page; without one it is the page's floor.
///
/// The strip becomes the switch. Taking the card away took the corner the word switch sat
/// in, and the strip is the better place anyway: Clicks, Visits and Sales are the three
/// figures a run can be drawn for, so the chosen one carries the headband — the style
/// guide's mark for an active item, the same mark the period words carry — and the chart
/// draws it. Impressions, the rate, the position and the count of projects are facts with no
/// run behind them, and stay inert.
///
/// And a tile says no verdict. "Growing" and "Flat" are the page's reading of a percentage
/// the reader can read themselves, four times over; what is left is the name, the
/// percentage, the count it came from, and the shape.
struct BreakoutVariant: View {
    enum Tiles {
        /// One card per project, side by side.
        case cards
        /// One container, the projects divided by hairlines.
        case oneContainer
    }

    let projects: [ProtoProject]
    let period: Period
    @Binding var metric: ProtoMetric
    let tiles: Tiles
    /// Whether the switch says so in words at the strip's end, beside the figures that can
    /// be chosen, for a reader who never thinks to click a number.
    var showsWordSwitch = false
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    /// Which choosable figure the pointer is over, so a figure can say it is choosable
    /// before it is chosen.
    @State private var pointedAt: ProtoMetric?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                if showsWordSwitch {
                    HStack {
                        Text("Draw")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        WordSwitch(options: ProtoMetric.allCases, selection: $metric, label: \.label)
                        Spacer()
                    }
                }
                strip
            }
                .column()

            // The breakout: no `.column()`, no card. See `TrendChart` on the site dashboard.
            chart
                .padding(.top, 36)

            projectTiles
                .column()
                .padding(.top, 36)
        }
    }

    // MARK: The strip, which is also the switch

    private var strip: some View {
        let comparison = OverviewGlance.total(projects.map(\.glance))
        let stats = comparison.currentStats
        let visits = ProtoSeries.growth(projects, metric: .visits)
        let sales = ProtoSeries.growth(projects, metric: .sales)
        let clicks = ProtoSeries.growth(projects, metric: .clicks)
        return HStack(alignment: .top, spacing: 0) {
            choice(.clicks, title: "Clicks", value: GlanceFigure.count(clicks?.current ?? 0), growth: clicks)
            gap
            fact(
                title: "Impressions",
                value: GlanceFigure.count(stats.impressions),
                change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { GlanceFigure.tint($0.delta) },
                dot: Palette.amber
            )
            gap
            fact(
                title: "Click-through rate",
                value: GlanceFigure.rate(stats.ctr),
                change: comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                tint: comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }
            )
            gap
            fact(
                title: "Position",
                value: GlanceFigure.position(stats.position),
                change: comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                tint: comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }
            )
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            choice(.visits, title: "Visits", value: visits.map { GlanceFigure.count($0.current) } ?? "—", growth: visits)
            gap
            choice(
                .sales,
                title: "Sales",
                value: sales.map { Money.format($0.current, currency: ProtoSeries.currency(projects)) } ?? "—",
                growth: sales
            )
            gap
            fact(title: "Projects", value: String(projects.count))
        }
        .animation(.snappy(duration: 0.2), value: metric)
    }

    /// A figure the chart can be drawn for: it takes the headband when it is the one drawn.
    /// Sales moves in money, the other two in counts, so the move is written the way its own
    /// figure is written.
    ///
    /// A figure that can be chosen has to look choosable while nothing is pointing at it, or
    /// the switch is a secret: the first cut lit the headband on the chosen figure only, and
    /// the other two were indistinguishable from the inert ones beside them. So the three
    /// carry an empty slot the headband can fill — a hairline at rest, acid when chosen, half
    /// lit under the pointer — and the pointer itself turns into a hand.
    private func choice(_ source: ProtoMetric, title: String, value: String, growth: Growth?) -> some View {
        let isActive = metric == source
        return Button {
            metric = source
        } label: {
            Metric(
                title: title,
                value: value,
                // The same absolute move the shipped strip shows, so the strip keeps reading
                // as one row written one way; the percentage belongs to the project tiles.
                change: growth.map { growth in
                    guard let previous = growth.previous else { return "new" }
                    let move = growth.current - previous
                    return source == .sales
                        ? Money.signed(move, currency: ProtoSeries.currency(projects))
                        : Trend.signed(move, fractionDigits: 0)
                },
                tint: growth.flatMap { GrowthReading.tint($0) },
                dot: source.color
            )
            .padding(.bottom, 8)
            .overlay(alignment: .bottomLeading) {
                Headband()
                    .fill(isActive ? Palette.acid : (pointedAt == source ? Palette.acid.opacity(0.5) : Palette.line))
                    .frame(width: 28, height: 3)
            }
        }
        .buttonStyle(.plain)
        .onHover { inside in
            pointedAt = inside ? source : (pointedAt == source ? nil : pointedAt)
            if inside {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
        .help("Draw \(title.lowercased()) in the chart")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// A figure with no run behind it: shown, never chosen.
    private func fact(title: String, value: String, change: String? = nil, tint: Color? = nil, dot: Color? = nil) -> some View {
        Metric(title: title, value: value, change: change, tint: tint, dot: dot)
            .padding(.bottom, 6)
    }

    private var gap: some View {
        Spacer(minLength: 24)
    }

    // MARK: The chart, which is the pane

    private var chart: some View {
        let run = ProtoSeries.total(projects, metric: metric)
        return VStack(spacing: 6) {
            ProtoBreakoutChart(run: run, color: metric.color, format: label)
                .frame(height: 200)
            HStack {
                if let first = run.current.first, let last = run.current.last {
                    Text(first.date, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(last.date, format: .dateTime.day().month(.abbreviated))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, SiteTabScreen.columnInset)
        }
    }

    private func label(_ value: Double) -> String {
        metric == .sales
            ? Money.format(value * 100, currency: ProtoSeries.currency(projects))
            : GlanceFigure.count(value)
    }

    // MARK: The projects

    @ViewBuilder
    private var projectTiles: some View {
        switch tiles {
        case .cards:
            ProtoTileGrid(projects: projects, perRow: 4) { project in
                tile(project)
                    .padding(14)
                    .cardSurface(cornerRadius: 12)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { onOpen(project.id) }
            }
        case .oneContainer:
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                    if index > 0 {
                        Rectangle()
                            .fill(Palette.line)
                            .frame(width: 1)
                            .frame(maxHeight: .infinity)
                    }
                    tile(project)
                        .padding(16)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { onOpen(project.id) }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .cardSurface(cornerRadius: 12)
        }
    }

    /// A project, with no verdict on it: the name, the percentage in its colour, the count it
    /// came from, and the shape of the period against the one before.
    private func tile(_ project: ProtoProject) -> some View {
        let growth = project.growth(metric)
        return VStack(alignment: .leading, spacing: 8) {
            ProtoSiteName(site: project.site, icon: icon(project.id), font: .subheadline.weight(.semibold), markSize: 14)
            Text(growth.map { GrowthReading.label($0) } ?? "—")
                .font(.system(size: 20, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(growth.flatMap { GrowthReading.tint($0) } ?? .primary)
            Text(growth == nil ? "No \(metric.label.lowercased())" : "\(project.figure(metric)) \(metric.unit)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            ProtoSpark(run: project.run(metric), color: metric.color)
                .frame(height: 30)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The hero chart as the pane's floor: the period as a line over a fill light enough to read
/// as ground rather than as a block, the period before as a grey line behind it, one tick
/// under each day, and the baseline as the only rule. Its own view because the card's chart
/// (`ComparisonChart`) is drawn for a 36-point picture: at the pane's full width and 200
/// points tall, that fill fills a third of the page.
struct ProtoBreakoutChart: View {
    let run: ComparisonRun
    let color: Color
    var format: (Double) -> String = { $0.formatted(.number.precision(.fractionLength(0))) }

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: Int?

    var body: some View {
        GeometryReader { geometry in
            let count = max(run.current.count, 1)
            let slot = geometry.size.width / CGFloat(count)
            chart
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    guard !isPreview else { return }
                    switch phase {
                    case .active(let location):
                        hovered = min(max(Int(location.x / slot), 0), count - 1)
                    case .ended:
                        hovered = nil
                    }
                }
                .overlay(alignment: .topLeading) {
                    if !run.current.isEmpty {
                        let index = min(hovered ?? 0, run.current.count - 1)
                        let centre = slot * (CGFloat(index) + 0.5)
                        label(index)
                            .fixedSize()
                            .alignmentGuide(.leading) { label in
                                -min(max(centre - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                            }
                            .opacity(hovered == nil ? 0 : 1)
                            .allowsHitTesting(false)
                    }
                }
        }
        .accessibilityHidden(true)
    }

    private func label(_ index: Int) -> some View {
        HStack(spacing: 6) {
            Text(run.current[index].date.formatted(.dateTime.day().month(.abbreviated)))
                .foregroundStyle(.secondary)
            Text(format(run.current[index].measured))
                .fontWeight(.semibold)
            if index < run.previousMeasured.count {
                Text(run.previousIsAverage
                    ? "was \(format(run.previousMeasured[index])) on average"
                    : "was \(format(run.previousMeasured[index]))")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
        .padding(.leading, SiteTabScreen.columnInset)
        .padding(.top, 8)
    }

    private var chart: some View {
        Chart {
            ForEach(Array(run.previous.enumerated()), id: \.offset) { index, value in
                LineMark(x: .value("Point", index), y: .value("Was", value), series: .value("Run", "was"))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1.25, lineJoin: .round, dash: run.previousIsAverage ? [3, 3] : []))
            }
            .interpolationMethod(.monotone)

            ForEach(Array(run.current.enumerated()), id: \.offset) { index, point in
                AreaMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                    .foregroundStyle(
                        LinearGradient(colors: [color.opacity(0.16), color.opacity(0)], startPoint: .top, endPoint: .bottom)
                    )
                LineMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 1.75, lineJoin: .round))
            }
            .interpolationMethod(.monotone)

            if let hovered, hovered < run.current.count {
                RuleMark(x: .value("Point", hovered))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Point", hovered), y: .value("Now", run.current[hovered].value))
                    .foregroundStyle(color)
                    .symbolSize(70)
            }
        }
        .chartYScale(domain: .automatic(includesZero: true))
        // The baseline is the only horizontal rule, as on a site dashboard.
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        // One dot under each point; the end dates are set outside the plot.
        .chartXAxis {
            AxisMarks(values: Array(0..<max(run.current.count, 1))) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
        .chartPlotStyle { plot in plot.padding(.top, 8) }
    }
}
#endif
