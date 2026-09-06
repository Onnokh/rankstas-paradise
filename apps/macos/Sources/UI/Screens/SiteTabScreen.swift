import Charts
import SwiftUI

struct SiteTabScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        // The path lives in the tab state, so the screen you were on survives a switch.
        // A plain switch instead of NavigationStack: that would install a window toolbar,
        // which clashes with the tab bar owning the title bar area.
        ZStack {
            if let screen = state.path.last {
                Group {
                    switch screen {
                    case .opportunities:
                        OpportunitiesScreen(overview: overview, onBack: pop)
                    case .registry:
                        PlaceholderScreen(
                            title: "Registry",
                            message: "The registry for \(overview.site.name) is not in the macOS app yet.",
                            systemImage: "list.bullet.rectangle",
                            backTitle: overview.site.name,
                            onBack: pop
                        )
                    case .log:
                        PlaceholderScreen(
                            title: "Log",
                            message: "The action log for \(overview.site.name) is not in the macOS app yet.",
                            systemImage: "clock",
                            backTitle: overview.site.name,
                            onBack: pop
                        )
                    }
                }
                .transition(.move(edge: .trailing))
            } else {
                root
                    .transition(.move(edge: .leading))
            }
        }
        .clipped()
        .animation(.snappy(duration: 0.3), value: state.path)
        .task(id: overview.id) {
            // Previews share the stores with the live screen; only the live screen loads.
            guard !isPreview else { return }
            await history.load(overview.id)
        }
        .task(id: RankingStore.KeywordsKey(siteID: overview.id, period: state.period)) {
            guard !isPreview else { return }
            await rankings.load(overview.id, period: state.period)
        }
    }

    private func pop() {
        state.path.removeLast()
    }

    // MARK: Root

    /// The long daily series when it is loaded, else the dashboard's own 28 days.
    private var days: [HistoryReportDay] {
        if let series = history.series[overview.id], !series.isEmpty {
            return series
        }
        return (overview.dashboard?.history ?? []).map {
            HistoryReportDay(date: $0.date, provisional: false, impressions: $0.impressions, clicks: $0.clicks, ctr: $0.ctr, position: $0.position)
        }
    }

    private var comparison: PeriodComparison {
        PeriodComparison(days: days.map(\.asHistoryDay), window: state.period.days)
    }

    private var ratingMove: RatingMove? {
        guard let dashboard = overview.dashboard else { return nil }
        var series = dashboard.domainRatingHistory ?? []
        if series.isEmpty, let rating = dashboard.domainRating {
            series = [DomainRatingDay(date: String(rating.fetchedAt.prefix(10)), rating: rating.rating)]
        }
        return RatingMove(history: series, days: state.period.days)
    }

    /// The reading column. Text, numbers and controls stay in one measured column, centred in the
    /// pane; only the chart runs the full width, so the numbers read like a page and the chart
    /// reads like the pane's own floor.
    static let columnWidth: CGFloat = 880
    static let columnInset: CGFloat = 24

    private var root: some View {
        // The screen scrolls: the two ranked lists under the chart can outgrow the pane.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .column()
                    .padding(.top, Self.columnInset)
                    .padding(.bottom, 40)

                MetricStrip(comparison: comparison, rating: ratingMove)
                    .column()

                TrendChart(days: Array(days.suffix(state.period.days)))
                    .padding(.top, 36)

                rankingCards
                    .column()
                    .padding(.top, 36)

                footer
                    .column()
                    .padding(.top, 24)
                    .padding(.bottom, Self.columnInset)
            }
        }
        .scrollDisabled(isPreview)
    }

    /// Keywords and registry targets side by side, each ranked by clicks.
    private var rankingCards: some View {
        let key = RankingStore.KeywordsKey(siteID: overview.id, period: state.period)
        let loading = rankings.loading.contains(overview.id)
        return HStack(alignment: .top, spacing: 20) {
            RankingCard(
                title: "Keywords",
                rows: (rankings.keywords[key] ?? []).map {
                    RankingCard.Row(id: $0.id, label: $0.query, metrics: $0.current)
                },
                loading: loading,
                emptyMessage: "No searches in this period."
            )
            RankingCard(
                title: "Registry",
                rows: (rankings.registry[overview.id] ?? []).map {
                    RankingCard.Row(id: $0.id, label: $0.targetUrl, metrics: $0.window)
                },
                loading: loading,
                emptyMessage: "No target pages in the registry yet."
            )
        }
    }

    /// The site's favicon beside its name.
    private static let titleIconSize: CGFloat = 20
    private static let titleIconSpacing: CGFloat = 10

    private var header: some View {
        // One row, centred: the favicon, the name, the origin and every control share a
        // centre line. The origin sits beside the name rather than under it, so the header
        // is one line tall and the numbers below get the room.
        HStack(spacing: Self.titleIconSpacing) {
            Group {
                if let icon {
                    icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                } else {
                    Image(systemName: "globe").font(.title3).foregroundStyle(.secondary)
                }
            }
            .frame(width: Self.titleIconSize, height: Self.titleIconSize)

            Text(overview.site.name)
                .font(.title3.weight(.semibold))

            Text(overview.site.origin)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(1)

            Spacer()

            // Every control of the screen sits in one trailing cluster: the period first,
            // as it changes what the whole screen shows, then the places to go.
            HStack(spacing: 20) {
                PeriodSwitch(selection: $state.period)
                    .disabled(isPreview)

                HStack(spacing: 14) {
                    Button("Registry") { state.path.append(.registry) }
                    Button("Log") { state.path.append(.log) }
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        onRefresh()
                        Task { await history.refresh(overview.id) }
                        Task { await rankings.refresh(overview.id, period: state.period) }
                    }
                    .labelStyle(.iconOnly)
                    .disabled(isRefreshing || history.refreshing.contains(overview.id))
                    .help("Refresh")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var footer: some View {
        HStack {
            if let error = history.errors[overview.id] ?? rankings.errors[overview.id] {
                Text(error)
                    .foregroundStyle(Palette.coral)
                    .lineLimit(1)
            }
            Spacer()
            if isRefreshing || history.refreshing.contains(overview.id) {
                ProgressView()
                    .controlSize(.small)
            }
            if let generated = Self.instant(overview.dashboard?.generatedAt) {
                Text("Updated ") + Text(generated, style: .relative) + Text(" ago")
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso = ISO8601DateFormatter()

    static func instant(_ string: String?) -> Date? {
        guard let string else { return nil }
        return isoWithFraction.date(from: string) ?? iso.date(from: string)
    }
}

// MARK: - Column

private extension View {
    /// Places a view in the reading column: capped at the column width, inset from the pane's
    /// edges, and centred in whatever width the pane has.
    func column() -> some View {
        frame(maxWidth: SiteTabScreen.columnWidth, alignment: .leading)
            .padding(.horizontal, SiteTabScreen.columnInset)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Word switch

/// A choice as a row of words. The chosen one is set in primary and carries the headband
/// under it, the style guide's mark for the active item; the others wait in secondary.
private struct WordSwitch<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let label: (Option) -> String
    var font: Font = .callout

    var body: some View {
        HStack(spacing: 14) {
            ForEach(options) { option in
                let isActive = option == selection
                Button {
                    selection = option
                } label: {
                    Text(label(option))
                        .font(font.weight(isActive ? .semibold : .regular))
                        .foregroundStyle(isActive ? .primary : .secondary)
                        .padding(.bottom, 4)
                        .overlay(alignment: .bottom) {
                            Headband()
                                .fill(Palette.acid)
                                .frame(height: 3)
                                .opacity(isActive ? 1 : 0)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
        .animation(.snappy(duration: 0.2), value: selection)
        .accessibilityElement(children: .contain)
    }
}

private struct PeriodSwitch: View {
    @Binding var selection: Period

    var body: some View {
        WordSwitch(options: Period.allCases, selection: $selection, label: \.label)
            .accessibilityLabel("Period")
    }
}

// MARK: - Metric strip

/// The period's numbers in one row, plain on the panel: a label over a large figure, with
/// the move against the previous period set small beside it. A hairline separates the Search
/// Console figures from the Domain Rating, which comes from another source.
private struct MetricStrip: View {
    let comparison: PeriodComparison
    let rating: RatingMove?

    var body: some View {
        let stats = comparison.currentStats
        // Justified: the figures sit at the two ends of the column and the gaps between them
        // share the rest, so the row reads as one line across the page rather than a cluster.
        HStack(alignment: .top, spacing: 0) {
            Metric(
                title: "Clicks",
                value: stats.clicks.formatted(.number.precision(.fractionLength(0))),
                change: comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.clicks.map { $0.delta >= 0 ? Palette.mint : Palette.coral },
                dot: TrendChart.clicksColor
            )
            gap
            Metric(
                title: "Impressions",
                value: stats.impressions.formatted(.number.precision(.fractionLength(0))),
                change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { $0.delta >= 0 ? Palette.mint : Palette.coral },
                dot: TrendChart.impressionsColor
            )
            gap
            Metric(
                title: "Click-through rate",
                value: stats.ctr.formatted(.percent.precision(.fractionLength(1))),
                change: comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                tint: comparison.ctrPointsDelta.map { $0 >= 0 ? Palette.mint : Palette.coral }
            )
            gap
            Metric(
                title: "Position",
                value: stats.position > 0 ? stats.position.formatted(.number.precision(.fractionLength(1))) : "—",
                change: comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                // A lower position is the better one.
                tint: comparison.positionDelta.map { $0 <= 0 ? Palette.mint : Palette.coral }
            )
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            Metric(
                title: "Domain Rating",
                value: rating.map { $0.current.formatted(.number.precision(.fractionLength(1))) } ?? "—",
                change: rating?.delta.map { Trend.signed($0, fractionDigits: 1) },
                tint: rating?.delta.map { $0 >= 0 ? Palette.mint : Palette.coral },
                footnote: rating == nil ? "No reading yet" : nil
            )
        }
    }

    /// One flexible gap. The minimum keeps the figures apart when the pane is narrow.
    private var gap: some View {
        Spacer(minLength: 28)
    }
}

private struct Metric: View {
    let title: String
    let value: String
    var change: String? = nil
    /// The colour of the change: mint when the move is the good way, coral otherwise.
    var tint: Color? = nil
    /// A series dot before the label, tying the figure to its line in the chart.
    var dot: Color? = nil
    var footnote: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                if let dot {
                    Circle()
                        .fill(dot)
                        .frame(width: 6, height: 6)
                }
                Text(title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(value)
                    .font(.system(size: 28, weight: .medium))
                    .monospacedDigit()
                if let change {
                    Text(change)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(tint ?? .secondary)
                } else if let footnote {
                    Text(footnote)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Ranking card

/// What a ranking card ranks by. Each takes the colour of its line in the chart.
private enum RankMetric: String, CaseIterable, Identifiable {
    case clicks, impressions

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clicks: "Clicks"
        case .impressions: "Impressions"
        }
    }

    var color: Color {
        switch self {
        case .clicks: TrendChart.clicksColor
        case .impressions: TrendChart.impressionsColor
        }
    }

    func value(of metrics: TidyMetrics) -> Double {
        switch self {
        case .clicks: metrics.clicks
        case .impressions: metrics.impressions
        }
    }
}

/// A titled list where every row is a bar: the row's tint runs as far as its count reaches
/// against the strongest row, so the list reads as a chart without a chart's furniture.
/// A word switch in the title row picks clicks or impressions; the tint follows.
private struct RankingCard: View {
    struct Row: Identifiable {
        let id: String
        let label: String
        let metrics: TidyMetrics
    }

    let title: String
    let rows: [Row]
    let loading: Bool
    let emptyMessage: String

    @State private var metric = RankMetric.impressions

    /// The strongest rows for the chosen metric. The order among equals is the server's own,
    /// so a run of zeros still lists the searches with the most impressions first.
    private var ranked: [Row] {
        Array(rows.sorted { metric.value(of: $0.metrics) > metric.value(of: $1.metrics) }.prefix(RankingStore.rowLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Text(title)
                    .font(.headline)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
                WordSwitch(options: RankMetric.allCases, selection: $metric, label: \.label, font: .subheadline)
                    .accessibilityLabel("Rank by")
            }

            if rows.isEmpty {
                Text(loading ? "Loading…" : emptyMessage)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                let ranked = ranked
                let strongest = max(ranked.map { metric.value(of: $0.metrics) }.max() ?? 1, 1)
                VStack(spacing: 6) {
                    ForEach(ranked) { row in
                        let value = metric.value(of: row.metrics)
                        HStack(spacing: 12) {
                            Text(row.label)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                            Text(value.formatted(.number.precision(.fractionLength(0))))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(alignment: .leading) {
                            GeometryReader { geometry in
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(metric.color.opacity(0.16))
                                    .frame(width: max(geometry.size.width * (value / strongest), 6))
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .animation(.snappy(duration: 0.25), value: metric)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

// MARK: - Chart

/// Impressions and clicks over the period as gradient areas on one value axis, with a hover
/// rule, point markers and a tooltip. The days Google may still revise continue the same
/// lines at reduced opacity.
///
/// The chart is the one thing on the screen that runs edge to edge. It sits straight on the
/// panel, with no card, no legend and no value axis: a baseline, a dot per day, and the first
/// and last dates are all the framing it gets. The metric strip above carries the series dots.
private struct TrendChart: View {
    let days: [HistoryReportDay]

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: HistoryReportDay?

    static let impressionsColor = Palette.amber
    static let clicksColor = Palette.blue

    var body: some View {
        if days.count >= 2 {
            VStack(spacing: 6) {
                chart
                endLabels
            }
        } else {
            ContentUnavailableView(
                "Not enough data",
                systemImage: "chart.xyaxis.line",
                description: Text("The chart needs at least two days.")
            )
            .frame(minHeight: 200)
        }
    }

    /// The first and last day, at the two ends of the run. Set outside the chart so the plot
    /// can reach the pane's edges while the words keep the column inset.
    private var endLabels: some View {
        HStack {
            Text(days.first!.day, format: .dateTime.day().month(.abbreviated))
            Spacer()
            Text(days.last!.day, format: .dateTime.day().month(.abbreviated))
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, SiteTabScreen.columnInset)
    }

    /// Days Google has finalised.
    private var finalized: [HistoryReportDay] {
        days.filter { !$0.provisional }
    }

    /// Days still being revised, starting from the last finalised day so the lines join.
    private var provisional: [HistoryReportDay] {
        guard let first = days.firstIndex(where: \.provisional) else { return [] }
        return Array(days[max(first - 1, 0)...])
    }

    private var chart: some View {
        Chart {
            series(finalized, suffix: "", opacity: 1)
            series(provisional, suffix: " (provisional)", opacity: 0.45)

            if let hovered {
                RuleMark(x: .value("Date", hovered.day))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(
                        position: .top,
                        alignment: .leading,
                        spacing: 10,
                        overflowResolution: .init(x: .fit(to: .chart), y: .disabled)
                    ) {
                        Tooltip(day: hovered)
                    }
                PointMark(x: .value("Date", hovered.day), y: .value("Impressions", hovered.impressions))
                    .foregroundStyle(Self.impressionsColor)
                    .symbolSize(70)
                PointMark(x: .value("Date", hovered.day), y: .value("Clicks", hovered.clicks))
                    .foregroundStyle(Self.clicksColor)
                    .symbolSize(70)
            }
        }
        .chartForegroundStyleScale(["Impressions": Self.impressionsColor, "Clicks": Self.clicksColor])
        .chartLegend(.hidden)
        .chartYScale(domain: .automatic(includesZero: true))
        // The baseline is the only horizontal rule: a hairline at zero.
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        // One dot under each day. The dates themselves are set outside the plot.
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: tickStride)) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
        // Room above the peaks for the tooltip, and none on the sides: the plot is the pane.
        .chartPlotStyle { plot in
            plot.padding(.top, 8)
        }
        .chartOverlay { proxy in
            if !isPreview {
                GeometryReader { geometry in
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                hovered = day(at: location, proxy: proxy, geometry: geometry)
                            case .ended:
                                hovered = nil
                            }
                        }
                }
            }
        }
        .frame(minHeight: 200, maxHeight: 300)
    }

    /// Area and line for both metrics over one run of days. The suffix keeps provisional runs
    /// as separate series so they are drawn on their own, without adding legend entries.
    @ChartContentBuilder
    private func series(_ run: [HistoryReportDay], suffix: String, opacity: Double) -> some ChartContent {
        ForEach(run) { day in
            AreaMark(
                x: .value("Date", day.day),
                y: .value("Impressions", day.impressions),
                series: .value("Series", "Impressions" + suffix),
                stacking: .unstacked
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(Self.gradient(Self.impressionsColor).opacity(opacity))

            // The finalised lines carry the by-series style, which is what feeds the legend.
            if suffix.isEmpty {
                LineMark(
                    x: .value("Date", day.day),
                    y: .value("Impressions", day.impressions),
                    series: .value("Series", "Impressions")
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(by: .value("Series", "Impressions"))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            } else {
                LineMark(
                    x: .value("Date", day.day),
                    y: .value("Impressions", day.impressions),
                    series: .value("Series", "Impressions" + suffix)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(Self.impressionsColor.opacity(opacity))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }

            AreaMark(
                x: .value("Date", day.day),
                y: .value("Clicks", day.clicks),
                series: .value("Series", "Clicks" + suffix),
                stacking: .unstacked
            )
            .interpolationMethod(.catmullRom)
            .foregroundStyle(Self.gradient(Self.clicksColor).opacity(opacity))

            if suffix.isEmpty {
                LineMark(
                    x: .value("Date", day.day),
                    y: .value("Clicks", day.clicks),
                    series: .value("Series", "Clicks")
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(by: .value("Series", "Clicks"))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            } else {
                LineMark(
                    x: .value("Date", day.day),
                    y: .value("Clicks", day.clicks),
                    series: .value("Series", "Clicks" + suffix)
                )
                .interpolationMethod(.catmullRom)
                .foregroundStyle(Self.clicksColor.opacity(opacity))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }
        }
    }

    /// Days between ticks: one per day up to a month, then thinned so the dots stay dots.
    private var tickStride: Int {
        days.count <= 31 ? 1 : days.count <= 100 ? 3 : 7
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> HistoryReportDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return days.min { abs($0.day.timeIntervalSince(date)) < abs($1.day.timeIntervalSince(date)) }
    }

    private static func gradient(_ color: Color) -> LinearGradient {
        LinearGradient(
            colors: [color.opacity(0.28), color.opacity(0.02)],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

private struct Tooltip: View {
    let day: HistoryReportDay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.day.formatted(.dateTime.day().month(.abbreviated)))
                .font(.callout.weight(.semibold))
            Text("Clicks : \(day.clicks.formatted(.number.precision(.fractionLength(0))))")
            Text("Impressions : \(day.impressions.formatted(.number.precision(.fractionLength(0))))")
            if day.provisional {
                Text("Still being revised")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
    }
}

// MARK: - Sub-screens

/// Sub-screen listing every opportunity signal of a site.
private struct OpportunitiesScreen: View {
    let overview: SiteOverview
    let onBack: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Button(overview.site.name, systemImage: "chevron.left", action: onBack)
                    .keyboardShortcut(isPreview ? nil : KeyboardShortcut("[", modifiers: .command))
                Spacer()
            }

            Text("Opportunities")
                .font(.largeTitle)

            let signals = overview.dashboard?.digest.signals ?? []
            if signals.isEmpty {
                ContentUnavailableView(
                    "No opportunities",
                    systemImage: "checkmark.circle",
                    description: Text("Nothing needs attention in the current snapshot.")
                )
            } else {
                List(Array(signals.enumerated()), id: \.offset) { _, signal in
                    HStack {
                        Label(signal.label, systemImage: "sparkles")
                        Spacer()
                        Text(signal.kind)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(24)
    }
}

private struct PlaceholderScreen: View {
    let title: String
    let message: String
    let systemImage: String
    let backTitle: String
    let onBack: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Button(backTitle, systemImage: "chevron.left", action: onBack)
                    .keyboardShortcut(isPreview ? nil : KeyboardShortcut("[", modifiers: .command))
                Spacer()
            }
            Text(title)
                .font(.largeTitle)
            ContentUnavailableView(title, systemImage: systemImage, description: Text(message))
            Spacer()
        }
        .padding(24)
    }
}

#Preview("Site tab") {
    SiteTabScreen(
        overview: OverviewModel.preview.overviews[0],
        state: SiteTabState(siteID: "sleevy"),
        history: HistoryStore(),
        rankings: RankingStore(),
        icon: nil,
        isRefreshing: false,
        onRefresh: {}
    )
    .frame(width: 1100, height: 640)
}
