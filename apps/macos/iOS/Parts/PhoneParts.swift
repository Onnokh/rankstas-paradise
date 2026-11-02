import Charts
import SwiftUI

// The Mac's page, at a phone's width. The pieces are the Mac's where they can be — `PageTitle`,
// `WordSwitch`, `Metric`, `Headband`, `Spark` — and drawn the Mac's way where they cannot:
// a header row over a hairline, figures set straight on the panel, cards on the raised
// surface closed by a hairline, and one colour with one meaning.

enum Phone {
    /// The page's inset from the screen's edges.
    static let inset: CGFloat = 20
    /// A quiet row: one height, whatever it holds.
    static let rowHeight: CGFloat = 44
    /// From this width a page has a small tablet's room — the Duo's inner display — and is
    /// laid out the Mac's way: the strip in one row, the chart large, the tiles across.
    static let roomyWidth: CGFloat = 600
    /// The column's inset with that room: a phone page's inset, more than doubled.
    static let roomyInset: CGFloat = 48
}

extension EnvironmentValues {
    /// Whether the window is at least `Phone.roomyWidth` wide. Set once, by the shell.
    @Entry var isRoomy = false
}

/// The column a page's content stands in. At a phone's width, the page's inset from the
/// screen's edges. With room, the Mac's reading column: inset further, never wider than the
/// Mac's column, centred, and its content set at the column's leading edge. Everything on a
/// page stands in it but the charts, which run edge to edge under it.
private struct PageColumn: ViewModifier {
    @Environment(\.isRoomy) private var isRoomy

    func body(content: Content) -> some View {
        if isRoomy {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Phone.roomyInset)
                .frame(maxWidth: Page.columnWidth + 2 * Phone.roomyInset)
                .frame(maxWidth: .infinity)
        } else {
            content.padding(.horizontal, Phone.inset)
        }
    }
}

extension View {
    func pageColumn() -> some View { modifier(PageColumn()) }
}

// MARK: - Page

extension PhonePage where Leading == PageTitle {
    /// A root tab's page, headed by the rail's symbol for it and its name.
    init(
        symbol: String,
        title: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.init(leading: { PageTitle(symbol: symbol, title: title) }, trailing: trailing, content: content)
    }
}

/// A page: the Mac's header row — the page's mark and name, the controls at the trailing end —
/// over the hairline, then the content. The navigation bar is hidden under it, as the Mac's
/// pane has no title bar, so every page's content starts the same distance down: a site's
/// figures and chart stand exactly where the Overview's do.
struct PhonePage<Leading: View, Trailing: View, Content: View>: View {
    @ViewBuilder let leading: Leading
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Page.titleSpacing) {
                leading
                Spacer()
                trailing
            }
            .pageColumn()
            .frame(height: Page.headerHeight)
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(Palette.panel)
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// A site's favicon at the size the Mac sets it, or the globe until it lands.
struct SiteIcon: View {
    let site: Site
    var size: CGFloat = 16

    @Environment(FaviconStore.self) private var favicons

    var body: some View {
        Group {
            if let image = favicons.image(for: site.id) {
                image.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: size * 0.2))
            } else {
                Image(systemName: "globe").foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
    }
}

extension Site {
    /// "sleevy.com": the origin as a reader says it.
    var host: String {
        URL(string: origin)?.host() ?? origin
    }
}

// MARK: - Strip

/// The metric strip at a phone's width: three figures to a row, straight on the panel. A
/// figure the chart can draw carries the headband's slot under it — acid when it is the one
/// drawn, a hairline when it could be — so a choosable figure looks choosable, as on the Mac.
struct MetricStrip: View {
    let figures: [StripFigure]
    @Binding var source: OverviewSource

    @Environment(\.isRoomy) private var isRoomy

    /// Three to a row at a phone's width; with room, all of them in one row, as on the Mac.
    private var perRow: Int { isRoomy ? max(figures.count, 1) : 3 }

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: isRoomy ? 24 : 12, verticalSpacing: 26) {
            ForEach(Array(stride(from: 0, to: figures.count, by: perRow)), id: \.self) { start in
                GridRow {
                    ForEach(figures[start..<min(start + perRow, figures.count)]) { figure in
                        cell(figure)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .animation(.snappy(duration: 0.2), value: source)
    }

    @ViewBuilder
    private func cell(_ figure: StripFigure) -> some View {
        let metric = PhoneMetric(figure: figure)
        if let choice = figure.source, figure.canChoose {
            let isActive = choice == source
            Button { source = choice } label: {
                metric.overlay(alignment: .bottomLeading) {
                    Headband()
                        .fill(isActive ? Palette.acid : Palette.line)
                        .frame(width: 28, height: 3)
                        .offset(y: 10)
                }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isActive ? .isSelected : [])
        } else {
            metric
        }
    }
}

/// One figure in the strip: what `Metric` says on the Mac, a size down, and free to shrink
/// its value into a third of a phone.
struct StripFigure: Identifiable {
    let title: String
    let value: String
    var change: String? = nil
    var tint: Color? = nil
    var dot: Color? = nil
    var footnote: String? = nil
    /// The source the chart draws when this figure is chosen; nil for a figure with no run.
    var source: OverviewSource? = nil
    var canChoose = true

    var id: String { title }
}

private struct PhoneMetric: View {
    let figure: StripFigure

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let dot = figure.dot {
                    Circle().fill(dot).frame(width: 6, height: 6)
                }
                Text(figure.title)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(figure.value)
                .font(.system(size: 22, weight: .medium))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(figure.change ?? figure.footnote ?? " ")
                .font(.caption.weight(figure.change == nil ? .regular : .medium))
                .monospacedDigit()
                .foregroundStyle(figure.change == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(figure.tint ?? .secondary))
                .lineLimit(1)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

extension StripFigure {
    /// A source's figure for a period, written the way the Mac's strip writes it: the count,
    /// and its absolute move.
    static func of(_ source: OverviewSource, growth: Growth?, currency: String?, absent: String? = nil) -> StripFigure {
        StripFigure(
            title: source.label,
            value: growth.map { GlanceFigure.figure($0.current, source: source, currency: currency) } ?? "—",
            change: growth.map { GlanceFigure.move($0, source: source, currency: currency) },
            tint: growth.flatMap { GlanceFigure.tint($0, source: source) },
            dot: source.dot,
            footnote: growth == nil ? absent : nil,
            source: source,
            canChoose: growth != nil
        )
    }
}

// MARK: - Period

/// The period, in a page's header: the Mac's row of words with room; at a phone's width one
/// word that opens a short menu, as five words and a title do not share a phone's row.
struct PeriodControl: View {
    @Binding var period: Period

    @Environment(\.isRoomy) private var isRoomy

    var body: some View {
        if isRoomy {
            WordSwitch(options: OverviewTabState.periods, selection: $period, label: \.label, font: .subheadline)
        } else {
            Menu {
                Picker("Period", selection: $period) {
                    ForEach(OverviewTabState.periods) { Text($0.label).tag($0) }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(period.label).font(.subheadline.weight(.semibold)).monospacedDigit()
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                }
                .foregroundStyle(Palette.text)
            }
        }
    }
}

/// The period's figures over its chart, the same on every page that draws one, so the
/// Overview and a site's dashboard put the same numbers in the same places. At a phone's width
/// the drawn figure stands large over the other four; with room, all five stand in one strip,
/// as on the Mac. A figure the page has nothing behind is a dash, never a gap, so the columns
/// line up from page to page. The gaps above and below are part of it, so the chart under it
/// starts the same distance down on both.
struct PeriodFigures: View {
    let drawn: OverviewSource
    let growth: (OverviewSource) -> Growth?
    let currency: String?
    @Binding var source: OverviewSource

    @Environment(\.isRoomy) private var isRoomy

    var body: some View {
        if isRoomy {
            MetricStrip(
                figures: OverviewSource.allCases.map { StripFigure.of($0, growth: growth($0), currency: currency) },
                source: $source
            )
            .pageColumn()
            .padding(.top, 24)
            .padding(.bottom, 36)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HeroFigure(source: drawn, growth: growth(drawn), currency: currency)
                    .padding(.top, 18)
                FigureLine(
                    options: OverviewSource.allCases.filter { $0 != drawn },
                    growth: growth,
                    currency: currency,
                    source: $source
                )
                .padding(.top, 16)
            }
            .pageColumn()
            .padding(.bottom, 20)
        }
    }
}

/// The drawn figure, large: its source, its value, and how far it moved.
private struct HeroFigure: View {
    let source: OverviewSource
    let growth: Growth?
    let currency: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let dot = source.dot { Circle().fill(dot).frame(width: 6, height: 6) }
                Text(source.label).font(.footnote).foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(growth.map { GlanceFigure.figure($0.current, source: source, currency: currency) } ?? "—")
                    .font(.system(size: 34, weight: .medium))
                    .monospacedDigit()
                if let growth {
                    Text(GlanceFigure.move(growth, source: source, currency: currency))
                        .font(.callout.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(GlanceFigure.tint(growth, source: source) ?? .secondary)
                }
            }
        }
    }
}

/// The other figures in equal columns across the width, each a tap to draw it instead.
private struct FigureLine: View {
    let options: [OverviewSource]
    let growth: (OverviewSource) -> Growth?
    let currency: String?
    @Binding var source: OverviewSource

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(options) { option in
                let growth = growth(option)
                Button { source = option } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 4) {
                            if let dot = option.dot { Circle().fill(dot).frame(width: 5, height: 5) }
                            Text(option.shortLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(growth.map { GlanceFigure.figure($0.current, source: option, currency: currency) } ?? "—")
                            .font(.subheadline.weight(.medium))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Headband()
                            .fill(Palette.line)
                            .frame(width: 16, height: 2)
                            .padding(.top, 3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(growth == nil)
            }
        }
    }
}

private extension OverviewSource {
    /// A source's name where four share one line.
    var shortLabel: String {
        switch self {
        case .clicks: "Clicks"
        case .impressions: "Impr."
        case .ctr: "CTR"
        case .visits: "Visits"
        case .sales: "Sales"
        }
    }
}

// MARK: - Chart

/// The Mac's hero chart: the period in its source's colour over a fading fill, the period
/// before in grey, a hairline at zero and a dot under each point, the first and last date
/// under the plot.
///
/// The Mac reads a point under the resting pointer. A finger has nowhere to rest, so here the
/// reader drags across the plot, and the same label rides above the point under the finger.
struct RunChart: View {
    let run: ComparisonRun
    let source: OverviewSource
    let currency: String?
    var height: CGFloat = 200

    /// What the chart draws under its plot: the dots, the dates and the gaps between.
    static let chrome: CGFloat = 32

    @State private var chosen: Int?

    var body: some View {
        if run.current.count >= 2 {
            VStack(spacing: 6) {
                chart
                    .frame(height: height)
                    .overlay(alignment: .top) {
                        if let chosen, chosen < run.current.count {
                            label(chosen).offset(y: -4)
                        }
                    }
                ticks
                HStack {
                    Text(run.current.first!.date, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(run.current.last!.date, format: .dateTime.day().month(.abbreviated))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Phone.inset)
            }
        } else {
            ContentUnavailableView(
                "Not enough data",
                systemImage: "chart.xyaxis.line",
                description: Text("The chart needs at least two days.")
            )
            .frame(height: height)
        }
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
                if source.fills {
                    AreaMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                        .foregroundStyle(
                            LinearGradient(colors: [source.color.opacity(0.16), source.color.opacity(0)], startPoint: .top, endPoint: .bottom)
                        )
                }
                LineMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                    .foregroundStyle(source.color)
                    .lineStyle(StrokeStyle(lineWidth: 1.75, lineJoin: .round))
            }
            .interpolationMethod(.monotone)

            if let chosen, chosen < run.current.count {
                RuleMark(x: .value("Point", chosen))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Point", chosen), y: .value("Now", run.current[chosen].value))
                    .foregroundStyle(source.color)
                    .symbolSize(70)
            }
        }
        // A fifth above the peaks: the room for the label (see `ChartSpan`).
        .chartYScale(domain: ChartSpan.domain(run.current.map(\.value) + run.previous, fromZero: !source.isRate, headroom: 0.2))
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        // Swift Charts keeps room under the plot for x labels even when a mark has none, and
        // at a phone's height that room read as a hole between the line and its dates. The
        // axis goes; its dots are drawn under the plot by `ticks`.
        .chartXAxis(.hidden)
        .chartXSelection(value: $chosen)
        .accessibilityHidden(true)
    }

    /// A dot under each point: the first at the left edge, the last at the right, as the
    /// plot has no inset on its sides.
    private var ticks: some View {
        HStack(spacing: 0) {
            ForEach(run.current.indices, id: \.self) { index in
                if index > 0 { Spacer(minLength: 0) }
                Circle().fill(Palette.line).frame(width: 2, height: 2)
            }
        }
        .accessibilityHidden(true)
    }

    private func label(_ index: Int) -> some View {
        HStack(spacing: 6) {
            Text(run.current[index].date.formatted(.dateTime.day().month(.abbreviated)))
                .foregroundStyle(.secondary)
            Text(figure(run.current[index].value))
                .fontWeight(.semibold)
            if index < run.previous.count {
                Text(run.previousIsAverage
                    ? "was \(figure(run.previous[index])) on average"
                    : "was \(figure(run.previous[index]))")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.25), radius: 6, y: 3)
        .allowsHitTesting(false)
    }

    private func figure(_ value: Double) -> String {
        // The sales run is kept in the currency's major units, as the report's days are.
        source.isMoney
            ? Money.format(value * 100, currency: currency)
            : GlanceFigure.figure(value, source: source, currency: currency)
    }
}

// MARK: - Live

/// The last half hour, a cell per minute: the Realtime's heat strip. A quiet minute keeps its
/// cell in the line colour, so the strip's length never changes.
struct HeatStrip: View {
    let values: [Double]

    var body: some View {
        let peak = max(values.max() ?? 1, 1)
        let cells = values.isEmpty ? Array(repeating: 0.0, count: 30) : values
        HStack(spacing: 2) {
            ForEach(cells.indices, id: \.self) { index in
                let value = cells[index]
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(value > 0 ? visitsColor.opacity(0.35 + 0.65 * value / peak) : Palette.line)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Rows

/// A quiet row's frame: one height, a hairline under it, nothing else. What goes in it is set
/// in fixed zones by the row itself.
struct QuietRow<Content: View>: View {
    var height: CGFloat = Phone.rowHeight
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(height: height)
                .frame(maxWidth: .infinity, alignment: .leading)
            Rectangle().fill(Palette.line).frame(height: 1)
        }
        .pageColumn()
        .contentShape(.rect)
    }
}

/// A section's opening: the guide's headband, then its name. The rule that opens a section on
/// the Mac's pages.
struct SectionHead: View {
    let title: String
    var trailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Headband().fill(Palette.acid).frame(width: 14, height: 4)
            Text(title).font(.headline)
            Spacer()
            if let trailing {
                Text(trailing).font(.caption).foregroundStyle(.secondary)
            }
        }
        .pageColumn()
        .padding(.top, 28)
        .padding(.bottom, 6)
    }
}

/// What a screen says while it has nothing yet, or nothing at all.
struct QuietNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .pageColumn()
            .padding(.vertical, 14)
    }
}

/// A failure, said where it happened, in the one colour that means it.
struct ErrorLine: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(Palette.coral)
            .frame(maxWidth: .infinity, alignment: .leading)
            .pageColumn()
    }
}
