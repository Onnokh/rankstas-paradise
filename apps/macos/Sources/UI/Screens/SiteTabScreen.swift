import Charts
import SwiftUI

struct SiteTabScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let log: LogStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview
    /// The screens this tab holds a view for. The one it opens on is mounted at once; the
    /// others are warmed one by one in the moments after, hidden, so the first click on any
    /// of them is a visibility flip and not a build. See `screens`.
    @State private var mounted: Set<SiteScreen> = []

    /// The screen on show. A preview is a still of the site and always shows the dashboard:
    /// a card in the peek is for picking a site, not for reading its registry at a fifth of
    /// the size, and following the live screen made every rail click build the chosen screen
    /// a second time inside a card nobody had open.
    private var shown: SiteScreen { isPreview ? .dashboard : state.screen }

    var body: some View {
        // One header row for every screen, pinned above the content, so the site's name,
        // its live count and the period never scroll away and never change shape between
        // screens. The rail beside the pane chooses the screen; the swap is instant, like a
        // tab's. A plain switch instead of NavigationStack: that would install a window
        // toolbar, which clashes with the tab bar owning the title bar area.
        VStack(spacing: 0) {
            header
                .column()
                .frame(height: Self.headerHeight)
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
            screens
        }
        // The live count polls only while the real screen is shown: a preview is a still.
        .task(id: overview.id) {
            guard !isPreview else { return }
            await live.poll(overview.id)
        }
        .task(id: overview.id) {
            // Previews share the stores with the live screen; only the live screen loads.
            guard !isPreview else { return }
            await history.load(overview.id)
        }
        .task(id: RankingStore.KeywordsKey(siteID: overview.id, period: state.period)) {
            // Today has no Search Console window to rank by; its lists come with the live poll.
            guard !isPreview, state.period != .today else { return }
            await rankings.load(overview.id, period: state.period)
        }
    }

    /// The chosen screen in front, the ones visited before kept behind it, hidden. The swap
    /// is instant the way a tab's is: nothing is built or torn down, only shown. Each hidden
    /// screen keeps its scroll position and its open page. A preview is a still of one
    /// screen and mounts only that.
    /// The chosen screen in front, the others kept behind it, hidden. A swap is instant the
    /// way a tab's is: nothing is built or torn down, only shown.
    ///
    /// Two things make that true, and both are load-bearing. Each screen sits in a
    /// `ScreenSlot` drawn with `.equatable()`, so this body re-evaluating for a click does
    /// not re-evaluate, and so not re-lay-out, the screens behind it — a swap back to the
    /// dashboard used to cost its four charts again, 130 ms in a Release build. And the
    /// screens are warmed after the tab's first frame rather than on first click, which put
    /// the registry's 340 ms of layout between the click and the pane.
    private var screens: some View {
        ZStack {
            ForEach(SiteScreen.allCases) { screen in
                let isActive = screen == shown
                if isActive || (!isPreview && mounted.contains(screen)) {
                    ScreenSlot(
                        screen: screen,
                        overview: overview,
                        state: state,
                        history: history,
                        rankings: rankings,
                        preferences: preferences,
                        live: live,
                        log: log,
                        isRefreshing: isRefreshing,
                        onRefresh: onRefresh
                    )
                    .equatable()
                    // Read by the Log screen, which fetches its record only once it is in
                    // front. An environment value rather than a slot field, so the slot
                    // stays equal across a click and the screens behind it stay untouched.
                    .environment(\.isScreenShown, isActive)
                    .opacity(isActive ? 1 : 0)
                    .allowsHitTesting(isActive)
                    .accessibilityHidden(!isActive)
                    .zIndex(isActive ? 1 : 0)
                }
            }
        }
        .onChange(of: shown, initial: true) { _, screen in
            mounted.insert(screen)
        }
        // Warm the other screens once the first frame is up, one per beat, so the work lands
        // between the reader's glances and never in front of a click. A preview stays one screen.
        .task(id: overview.id) {
            guard !isPreview else { return }
            for screen in SiteScreen.allCases where !mounted.contains(screen) {
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                mounted.insert(screen)
            }
        }
    }

    /// The reading column. Text, numbers and controls stay in one measured column, centred in the
    /// pane; only the chart runs the full width, so the numbers read like a page and the chart
    /// reads like the pane's own floor.
    static let columnWidth: CGFloat = 880
    static let columnInset: CGFloat = 24
    /// The header row's height. The rail beside the pane centres its first icon on it.
    static let headerHeight: CGFloat = 56
    /// The room between the header's hairline and the first line of a screen.
    static let screenInset: CGFloat = 32

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

            // The people on the site right now, beside the name: the one figure in the header
            // that moves on its own. Its own view, so the poll that feeds it invalidates a
            // label and not the screen below — see `OnlineCount`.
            OnlineCount(live: live, siteID: overview.id)

            Spacer()

            // The controls sit in one trailing cluster. The period only means something on
            // the dashboard — the registry and the plan have their own windows — so it
            // leaves with the dashboard rather than staying and lying.
            HStack(spacing: 20) {
                if shown == .dashboard {
                    PeriodSwitch(selection: $state.period)
                        .disabled(isPreview)
                }

                HStack(spacing: 10) {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .disabled(busy)
                        .help("Refresh (⌘R)")
                }
            }
        }
    }

    /// Whether anything this tab shows is still on its way: the overview, the site's series,
    /// or its ranked lists.
    private var busy: Bool {
        isRefreshing || history.refreshing.contains(overview.id) || rankings.loading.contains(overview.id)
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

// MARK: - Online count

/// The provider's "online" count, the last five minutes; the realtime card on the dashboard
/// draws the wider half hour by the minute.
///
/// The header is pinned above every screen, and the live store lands a new report every few
/// seconds. This is the only view in the header that reads that store, so a poll re-renders
/// one label. If the header read `live` itself, every poll would rebuild the screen under it,
/// and the Planning screen's lazy list re-phases its rows each time — the idle-CPU hazard
/// `ProposalsList` documents.
private struct OnlineCount: View {
    let live: LiveStore
    let siteID: Site.ID

    var body: some View {
        if let liveVisitors = live.reports[siteID]?.live {
            let count = liveVisitors.onlineNow.formatted(.number.precision(.fractionLength(0)))
            HStack(spacing: 6) {
                Circle()
                    .fill(visitsColor)
                    .frame(width: 7, height: 7)
                Text("\(count) online")
                    .monospacedDigit()
            }
            .foregroundStyle(.secondary)
            .padding(.leading, 6)
            .help("Distinct people on the site in the last \(liveVisitors.onlineMinutes) minutes")
            .accessibilityLabel("\(count) people online")
        }
    }
}

// MARK: - Word switch

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
    let visits: VisitsComparison?
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
            // Visits (sessions) rather than visitors: visits sum over a period, distinct
            // people do not. The chart's tooltip shows both for a single day.
            Metric(
                title: "Visits",
                value: visits.map { $0.current.formatted(.number.precision(.fractionLength(0))) } ?? "—",
                change: visits?.trend.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: visits?.trend.map { $0.delta >= 0 ? Palette.mint : Palette.coral },
                dot: visits == nil ? nil : visitsColor,
                footnote: visits == nil ? "No analytics" : nil
            )
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

// MARK: - Today

/// Today's numbers in the metric strip's place: the provider's four, then the Domain Rating
/// beyond the hairline as on every other period. No moves: there is no "previous today".
private struct TodayStrip: View {
    let today: TodayVisits
    let rating: RatingMove?

    var body: some View {
        let count = { (value: Double?) in value.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "0" }
        HStack(alignment: .top, spacing: 0) {
            Metric(title: "Visits", value: count(today.site?.visits), dot: visitsColor)
            gap
            Metric(title: "Pageviews", value: count(today.site?.pageviews))
            gap
            Metric(title: "Visitors", value: count(today.site?.visitors))
            gap
            Metric(title: "Events", value: count(today.eventCount))
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            Metric(
                title: "Domain Rating",
                value: rating.map { $0.current.formatted(.number.precision(.fractionLength(1))) } ?? "—",
                footnote: rating == nil ? "No reading yet" : nil
            )
        }
    }

    private var gap: some View {
        Spacer(minLength: 28)
    }
}

/// Today by the hour, in the big chart's place: one bar per hour that has begun, the hours
/// to come left as room so the day keeps its width as it fills. Same hover as the Visits card.
private struct HoursChart: View {
    let today: TodayVisits

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: VisitsHour?
    @State private var hoverX: CGFloat = 0

    private var elapsed: [VisitsHour] {
        Array(today.hours.prefix(max(1, min(24, today.hoursElapsed))))
    }

    var body: some View {
        VStack(spacing: 6) {
            chart
            HStack {
                Text("00:00")
                Spacer()
                Text("Now")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, SiteTabScreen.columnInset)
        }
    }

    private var chart: some View {
        Chart {
            RuleMark(y: .value("Visits", 0))
                .foregroundStyle(Palette.line)
                .lineStyle(StrokeStyle(lineWidth: 1))

            ForEach(elapsed) { hour in
                BarMark(x: .value("Hour", hour.hour), y: .value("Visits", hour.visits), width: .ratio(0.6))
                    .foregroundStyle(visitsColor.opacity(hovered == nil || hovered == hour ? 1 : 0.4))
                    .cornerRadius(2)
            }

            if let hovered {
                RuleMark(x: .value("Hour", hovered.hour))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartXScale(domain: -0.5...23.5)
        .chartYScale(domain: .automatic(includesZero: true))
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks(values: Array(stride(from: 0, through: 23, by: 1))) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
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
                                hovered = hour(at: location, proxy: proxy, geometry: geometry)
                                if let hovered,
                                   let plotFrame = proxy.plotFrame,
                                   let x = proxy.position(forX: hovered.hour) {
                                    hoverX = geometry[plotFrame].origin.x + x
                                }
                            case .ended:
                                hovered = nil
                            }
                        }
                }
            }
        }
        .frame(height: 220)
        .overlay(alignment: .topLeading) {
            GeometryReader { geometry in
                HourTooltip(hour: hovered ?? elapsed[elapsed.count - 1])
                    .fixedSize()
                    .alignmentGuide(.leading) { label in
                        -min(max(hoverX - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                    }
                    .alignmentGuide(.top) { label in label.height + 8 }
                    .opacity(hovered == nil ? 0 : 1)
            }
            .allowsHitTesting(false)
        }
    }

    private func hour(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> VisitsHour? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let value: Double = proxy.value(atX: location.x - origin.x) else { return nil }
        let index = Int(value.rounded())
        guard elapsed.indices.contains(index) else { return nil }
        return elapsed[index]
    }
}

private struct HourTooltip: View {
    let hour: VisitsHour

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(String(format: "%02d:00 – %02d:00", hour.hour, (hour.hour + 1) % 24))
                .font(.callout.weight(.semibold))
            Text("Visits : \(hour.visits.formatted(.number.precision(.fractionLength(0))))")
            Text("Visitors : \(hour.visitors.formatted(.number.precision(.fractionLength(0))))")
            Text("Pageviews : \(hour.pageviews.formatted(.number.precision(.fractionLength(0))))")
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
    }
}

/// Today's pages by visits, in the Visits card's place: the list-as-chart of the ranking
/// cards, lilac like every visits figure.
private struct PagesTodayCard: View {
    let pages: [TodayPage]

    private var ranked: [TodayPage] {
        Array(pages.sorted { $0.visits > $1.visits }.prefix(RankingStore.rowLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Pages today")
                    .font(.headline)
                Spacer()
                Text("Visits")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if ranked.isEmpty {
                Text("No visits yet today.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                let strongest = max(ranked.map(\.visits).max() ?? 1, 1)
                VStack(spacing: 6) {
                    ForEach(ranked) { page in
                        HStack(spacing: 12) {
                            Text(page.page)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                            Text(page.visits.formatted(.number.precision(.fractionLength(0))))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(alignment: .leading) {
                            GeometryReader { geometry in
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(visitsColor.opacity(0.16))
                                    .frame(width: max(geometry.size.width * (page.visits / strongest), 6))
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

// MARK: - Ranking card

/// What a ranking card ranks by. Each takes the colour of its line in the chart.
private enum RankMetric: String, CaseIterable, Identifiable {
    case clicks, impressions, visits

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clicks: "Clicks"
        case .impressions: "Impressions"
        case .visits: "Visits"
        }
    }

    var color: Color {
        switch self {
        case .clicks: TrendChart.clicksColor
        case .impressions: TrendChart.impressionsColor
        case .visits: visitsColor
        }
    }

    func value(of row: RankingCard.Row) -> Double {
        switch self {
        case .clicks: row.metrics.clicks
        case .impressions: row.metrics.impressions
        case .visits: row.visits ?? 0
        }
    }
}

/// A titled list where every row is a bar: the row's tint runs as far as its count reaches
/// against the strongest row, so the list reads as a chart without a chart's furniture.
/// A word switch in the title row picks clicks, impressions or, when the rows carry them,
/// visits; the tint follows.
private struct RankingCard: View {
    struct Row: Identifiable {
        let id: String
        let label: String
        let metrics: TidyMetrics
        /// Visits from the analytics provider over the same window. Nil for rows that have
        /// none (keywords, or a site without a provider); the switch then hides the option.
        var visits: Double? = nil
        /// Google reports this page is not in its index: the row is dimmed. Always false for
        /// rows that are not pages.
        var unindexed: Bool = false
        /// Google's own words for that verdict, shown on hover.
        var indexNote: String? = nil
    }

    let title: String
    let rows: [Row]
    let loading: Bool
    let emptyMessage: String

    /// How far a row drops when Google reports the page is not indexed. Enough to read as a
    /// second rank, not so far that the row's numbers stop being legible.
    private static let unindexedOpacity: Double = 0.45

    @State private var chosen = RankMetric.impressions

    /// Visits is offered only when some row has them, so the keyword card and a site without
    /// a provider keep their two words.
    private var options: [RankMetric] {
        rows.contains { $0.visits != nil } ? RankMetric.allCases : [.clicks, .impressions]
    }

    /// The choice, unless the rows stopped carrying it (a site switch), then impressions.
    private var metric: RankMetric { options.contains(chosen) ? chosen : .impressions }

    /// The strongest rows for the chosen metric. The order among equals is the server's own,
    /// so a run of zeros still lists the searches with the most impressions first.
    private var ranked: [Row] {
        Array(rows.sorted { metric.value(of: $0) > metric.value(of: $1) }.prefix(RankingStore.rowLimit))
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
                WordSwitch(options: options, selection: $chosen, label: \.label, font: .subheadline)
                    .accessibilityLabel("Rank by")
            }

            if rows.isEmpty {
                Text(loading ? "Loading…" : emptyMessage)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                let ranked = ranked
                let strongest = max(ranked.map { metric.value(of: $0) }.max() ?? 1, 1)
                VStack(spacing: 6) {
                    ForEach(ranked) { row in
                        bar(row, strongest: strongest)
                    }
                }
                .animation(.snappy(duration: 0.25), value: metric)

                if ranked.contains(where: \.unindexed) {
                    Text("Dimmed rows are pages Google reports as not indexed.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }

    /// One row of the list: its label, its count, and the tint reaching as far as the count
    /// does. A page Google reports as not indexed keeps its place in the ranking and drops
    /// back instead, the same reading the other clients give it.
    @ViewBuilder
    private func bar(_ row: Row, strongest: Double) -> some View {
        let value = metric.value(of: row)
        let plain = HStack(spacing: 12) {
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

        if row.unindexed {
            plain
                .opacity(Self.unindexedOpacity)
                .accessibilityHint("Not indexed")
                .help(row.indexNote ?? "Google reports this page is not indexed")
        } else {
            plain
        }
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
    /// The curve is monotone, so a day is a soft crest rather than a corner. Monotone never
    /// overshoots the data: Catmull-Rom dipped below the baseline between two empty days.
    @ChartContentBuilder
    private func series(_ run: [HistoryReportDay], suffix: String, opacity: Double) -> some ChartContent {
        ForEach(run) { point in
            AreaMark(
                x: .value("Date", point.day),
                y: .value("Impressions", point.impressions),
                series: .value("Series", "Impressions" + suffix),
                stacking: .unstacked
            )
            .foregroundStyle(Self.gradient(Self.impressionsColor).opacity(opacity))

            // The finalised lines carry the by-series style, which is what feeds the legend.
            if suffix.isEmpty {
                LineMark(
                    x: .value("Date", point.day),
                    y: .value("Impressions", point.impressions),
                    series: .value("Series", "Impressions")
                )
                .foregroundStyle(by: .value("Series", "Impressions"))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            } else {
                LineMark(
                    x: .value("Date", point.day),
                    y: .value("Impressions", point.impressions),
                    series: .value("Series", "Impressions" + suffix)
                )
                .foregroundStyle(Self.impressionsColor.opacity(opacity))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }

            AreaMark(
                x: .value("Date", point.day),
                y: .value("Clicks", point.clicks),
                series: .value("Series", "Clicks" + suffix),
                stacking: .unstacked
            )
            .foregroundStyle(Self.gradient(Self.clicksColor).opacity(opacity))

            if suffix.isEmpty {
                LineMark(
                    x: .value("Date", point.day),
                    y: .value("Clicks", point.clicks),
                    series: .value("Series", "Clicks")
                )
                .foregroundStyle(by: .value("Series", "Clicks"))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            } else {
                LineMark(
                    x: .value("Date", point.day),
                    y: .value("Clicks", point.clicks),
                    series: .value("Series", "Clicks" + suffix)
                )
                .foregroundStyle(Self.clicksColor.opacity(opacity))
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }
        }
        .interpolationMethod(.monotone)
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

// MARK: - Analytics cards

/// Money is green: the fourth series, from the site's commerce provider.
private let revenueColor = Palette.mint

/// The last half hour by the minute: one bar per minute, the newest at the right, with the
/// window's total beside the title. The people online right now are the header's figure,
/// beside the site name; this card is the wider picture. The store behind it asks again
/// every half minute, so the bars are the screen's one moving part.
private struct RealtimeCard: View {
    let live: LiveVisitors?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Realtime")
                    .font(.headline)
                Spacer()
                if let live {
                    Text("\(live.visitors.formatted(.number.precision(.fractionLength(0)))) in the last \(live.windowMinutes) min")
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .help(Self.windowHelp(live))
                }
            }

            if let live {
                MinuteBars(values: live.bars, fetchedAt: SiteTabScreen.instant(live.fetchedAt))
                    .frame(height: 96)

                HStack {
                    Text("\(live.windowMinutes) minutes ago")
                    Spacer()
                    Text("Now")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } else {
                Text("Waiting for the provider…")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .accessibilityElement(children: .combine)
    }

    /// "Distinct people in the last 30 minutes. 4 online now." When the server only knows
    /// the whole window there is no separate now, so it is said once.
    static func windowHelp(_ live: LiveVisitors) -> String {
        let window = "Distinct people in the last \(live.windowMinutes) minutes."
        guard let online = live.online else { return window }
        return "\(window) \(online.formatted(.number.precision(.fractionLength(0)))) online now."
    }
}

/// The period's custom events, one row per event, strongest first: the name, the count and
/// its move against the previous period, over a bar as long as the count against the
/// strongest row, the same list-as-chart as the ranking cards. Events are what visitors did
/// (a purchase, a download), so this is the provider's view that carries meaning, not
/// volume, and it gets the whole column.
private struct EventsCard: View {
    let rows: [EventRow]
    let loading: Bool

    /// Strongest first; the server already sorts, this only defends against a tie order change.
    private var ranked: [EventRow] {
        Array(rows.sorted { $0.current > $1.current }.prefix(RankingStore.rowLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Text("Events")
                    .font(.headline)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                }
                Spacer()
                let total = rows.reduce(0) { $0 + $1.current }
                Text("\(total.formatted(.number.precision(.fractionLength(0)))) in the period")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }

            if rows.isEmpty {
                Text(loading ? "Loading…" : "No events in this period.")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                let ranked = ranked
                let strongest = max(ranked.map(\.current).max() ?? 1, 1)
                VStack(spacing: 6) {
                    ForEach(ranked) { row in
                        HStack(spacing: 12) {
                            Text(row.name)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                            if row.previous > 0 || row.delta != 0 {
                                Text(Trend.signed(row.delta, fractionDigits: 0))
                                    .font(.caption)
                                    .monospacedDigit()
                                    .foregroundStyle(row.delta >= 0 ? Palette.mint : Palette.coral)
                            }
                            Text(row.current.formatted(.number.precision(.fractionLength(0))))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 48, alignment: .trailing)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(alignment: .leading) {
                            GeometryReader { geometry in
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(visitsColor.opacity(0.16))
                                    .frame(width: max(geometry.size.width * (row.current / strongest), 6))
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

/// The period's visits, one bar per day, with the period total and its move in the title
/// row. Visits (sessions) sum over the period; a day the provider has not synced yet is
/// left empty rather than drawn as zero, so a series that started recently reads as short,
/// not as a flat start.
private struct VisitsCard: View {
    let days: [HistoryReportDay]
    let comparison: VisitsComparison?

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: HistoryReportDay?
    /// The hovered day's centre, in the chart's own coordinates, for placing the tooltip.
    @State private var hoverX: CGFloat = 0

    private var points: [HistoryReportDay] {
        days.filter { $0.visits != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Visits")
                    .font(.headline)
                Spacer()
                if let comparison {
                    Text(comparison.current.formatted(.number.precision(.fractionLength(0))))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                    if let trend = comparison.trend {
                        Text(Trend.signed(trend.delta, fractionDigits: 0))
                            .font(.caption.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(trend.delta >= 0 ? Palette.mint : Palette.coral)
                    }
                }
            }

            if points.count >= 2 {
                Chart {
                    // The baseline is a mark, not an axis grid line: Charts draws the grid
                    // line for zero a few points above where the bars actually start, so
                    // bars sat below their own baseline. A rule at zero is placed on the
                    // same scale as the bars and meets them exactly. Drawn first, under them.
                    RuleMark(y: .value("Visits", 0))
                        .foregroundStyle(Palette.line)
                        .lineStyle(StrokeStyle(lineWidth: 1))

                    ForEach(points) { point in
                        BarMark(
                            x: .value("Date", point.day, unit: .day),
                            y: .value("Visits", point.visits?.visits ?? 0)
                        )
                        // The hovered day keeps its colour; the others step back.
                        .foregroundStyle(visitsColor.opacity(hovered == nil || hovered == point ? 1 : 0.4))
                        .cornerRadius(2)
                    }

                    if let hovered {
                        RuleMark(x: .value("Date", hovered.day))
                            .foregroundStyle(.secondary.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartYScale(domain: .automatic(includesZero: true))
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
                .chartPlotStyle { plot in
                    plot.padding(.top, 8)
                }
                // The view that tracks the pointer stands alone here and never changes: on
                // macOS, inserting a sibling beside it rebuilds its tracking area and ends the
                // hover until the pointer leaves and comes back. The tooltip lives in a
                // separate overlay below, always present, shown and hidden by opacity only.
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
                                        if let hovered,
                                           let plotFrame = proxy.plotFrame,
                                           let x = proxy.position(forX: hovered.day) {
                                            hoverX = geometry[plotFrame].origin.x + x
                                        }
                                    case .ended:
                                        hovered = nil
                                    }
                                }
                        }
                    }
                }
                .frame(height: 96)
                // Not a chart annotation either: an annotation is part of the chart's layout,
                // and one taller than this small plot made the chart resize on every move.
                .overlay(alignment: .topLeading) {
                    GeometryReader { geometry in
                        VisitsTooltip(day: hovered ?? points[points.count - 1])
                            .fixedSize()
                            .alignmentGuide(.leading) { label in
                                -min(max(hoverX - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                            }
                            .alignmentGuide(.top) { label in label.height + 8 }
                            .opacity(hovered == nil ? 0 : 1)
                    }
                    .allowsHitTesting(false)
                }

                HStack {
                    Text(points.first!.day, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(points.last!.day, format: .dateTime.day().month(.abbreviated))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } else {
                Text("Not enough days of visits yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .accessibilityElement(children: .combine)
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> HistoryReportDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return points.min { abs($0.day.timeIntervalSince(date)) < abs($1.day.timeIntervalSince(date)) }
    }
}

/// The period's revenue, one bar per day, with the period total and its move in the title
/// row: the Visits card's twin for the commerce provider. Amounts arrive in cents and are
/// shown in the report's currency. A day never synced is left empty rather than drawn as
/// zero; a day without sales is a zero bar, because the ledger knows the difference.
private struct RevenueCard: View {
    let report: RevenueReport

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: RevenueDay?
    /// The hovered day's centre, in the chart's own coordinates, for placing the tooltip.
    @State private var hoverX: CGFloat = 0

    private var points: [RevenueDay] { report.days }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Revenue")
                    .font(.headline)
                Spacer()
                if !points.isEmpty {
                    Text(Money.format(report.current.revenue, currency: report.currency))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                    // No move when the earlier period has nothing to compare against, as
                    // the Visits card does; a first month reads as a figure, not as growth.
                    if report.previous.orders > 0 || report.previous.revenue > 0 {
                        Text(Money.signed(report.delta.revenue, currency: report.currency))
                            .font(.caption.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(report.delta.revenue >= 0 ? Palette.mint : Palette.coral)
                    }
                }
            }

            if points.count >= 2 {
                Chart {
                    // A rule at zero rather than the axis grid line, for the reason the
                    // Visits card gives: it meets the bars exactly.
                    RuleMark(y: .value("Revenue", 0))
                        .foregroundStyle(Palette.line)
                        .lineStyle(StrokeStyle(lineWidth: 1))

                    ForEach(points) { point in
                        BarMark(
                            x: .value("Date", point.day, unit: .day),
                            y: .value("Revenue", point.revenue / 100)
                        )
                        .foregroundStyle(revenueColor.opacity(hovered == nil || hovered == point ? 1 : 0.4))
                        .cornerRadius(2)
                    }

                    if let hovered {
                        RuleMark(x: .value("Date", hovered.day))
                            .foregroundStyle(.secondary.opacity(0.6))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    }
                }
                .chartYScale(domain: .automatic(includesZero: true))
                .chartYAxis(.hidden)
                .chartXAxis(.hidden)
                .chartPlotStyle { plot in
                    plot.padding(.top, 8)
                }
                // The same hover arrangement as the Visits card: the tracking view stands
                // alone and never changes; the tooltip is an overlay shown by opacity.
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
                                        if let hovered,
                                           let plotFrame = proxy.plotFrame,
                                           let x = proxy.position(forX: hovered.day) {
                                            hoverX = geometry[plotFrame].origin.x + x
                                        }
                                    case .ended:
                                        hovered = nil
                                    }
                                }
                        }
                    }
                }
                .frame(height: 96)
                .overlay(alignment: .topLeading) {
                    GeometryReader { geometry in
                        RevenueTooltip(day: hovered ?? points[points.count - 1], currency: report.currency)
                            .fixedSize()
                            .alignmentGuide(.leading) { label in
                                -min(max(hoverX - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                            }
                            .alignmentGuide(.top) { label in label.height + 8 }
                            .opacity(hovered == nil ? 0 : 1)
                    }
                    .allowsHitTesting(false)
                }

                HStack {
                    Text(points.first!.day, format: .dateTime.day().month(.abbreviated))
                    Spacer()
                    Text(points.last!.day, format: .dateTime.day().month(.abbreviated))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } else if let status = report.revenue, !status.ready {
                Text(status.reason ?? "The commerce provider cannot be read.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                Text("Not enough days of revenue yet.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .accessibilityElement(children: .combine)
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> RevenueDay? {
        guard let plotFrame = proxy.plotFrame else { return nil }
        let origin = geometry[plotFrame].origin
        guard let date: Date = proxy.value(atX: location.x - origin.x) else { return nil }
        return points.min { abs($0.day.timeIntervalSince(date)) < abs($1.day.timeIntervalSince(date)) }
    }
}

/// The day under the pointer in the Revenue card: what was paid, how many orders, and the net.
private struct RevenueTooltip: View {
    let day: RevenueDay
    let currency: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.day.formatted(.dateTime.day().month(.abbreviated)))
                .font(.callout.weight(.semibold))
            Text("Revenue : \(Money.format(day.revenue, currency: currency))")
            Text("Orders : \(day.orders.formatted(.number.precision(.fractionLength(0))))")
            Text("Net : \(Money.format(day.net, currency: currency))")
        }
        .font(.callout)
        .monospacedDigit()
        .padding(12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
    }
}

/// The day under the pointer in the Visits card: its visits, visitors and pageviews.
private struct VisitsTooltip: View {
    let day: HistoryReportDay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(day.day.formatted(.dateTime.day().month(.abbreviated)))
                .font(.callout.weight(.semibold))
            if let visits = day.visits {
                Text("Visits : \(visits.visits.formatted(.number.precision(.fractionLength(0))))")
                Text("Visitors : \(visits.visitors.formatted(.number.precision(.fractionLength(0))))")
                Text("Pageviews : \(visits.pageviews.formatted(.number.precision(.fractionLength(0))))")
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

// MARK: - Dashboard

/// The site's first screen: the period's figures, the chart, the provider's cards and the
/// ranked lists. Its own view rather than part of the tab so it can sit in a `ScreenSlot`
/// and be left alone while another screen is in front.
private struct SiteDashboard: View {
    let overview: SiteOverview
    let state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let live: LiveStore
    let isRefreshing: Bool

    @Environment(\.isTabPreview) private var isPreview


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

    private var visitsComparison: VisitsComparison? {
        VisitsComparison(days: days, window: state.period.days)
    }

    private var liveVisitors: LiveVisitors? {
        live.reports[overview.id]?.live
    }

    private var todayVisits: TodayVisits? {
        live.todays[overview.id]?.today
    }

    /// The period's sales, once loaded. Nil until then, and for a site without a commerce
    /// provider the report itself says so and the card is not shown.
    private var revenueReport: RevenueReport? {
        rankings.revenue[RankingStore.KeywordsKey(siteID: overview.id, period: state.period)]
    }

    /// Whether the site has an analytics provider with anything to show: a live count, or
    /// at least one day of visits in the series.
    private var hasAnalytics: Bool {
        liveVisitors != nil || visitsComparison != nil
    }

    private var ratingMove: RatingMove? {
        guard let dashboard = overview.dashboard else { return nil }
        var series = dashboard.domainRatingHistory ?? []
        if series.isEmpty, let rating = dashboard.domainRating {
            series = [DomainRatingDay(date: String(rating.fetchedAt.prefix(10)), rating: rating.rating)]
        }
        return RatingMove(history: series, days: state.period.days)
    }

    var body: some View {
        // The screen scrolls: the two ranked lists under the chart can outgrow the pane.
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if state.period == .today {
                    todayBody
                } else {
                    periodBody
                }

                footer
                    .column()
                    .padding(.top, 24)
                    .padding(.bottom, SiteTabScreen.columnInset)
            }
            .padding(.top, SiteTabScreen.screenInset)
        }
        .scrollDisabled(isPreview)
    }

    /// A stored period: Search Console figures and chart, then the provider's cards.
    @ViewBuilder
    private var periodBody: some View {
        MetricStrip(comparison: comparison, visits: visitsComparison, rating: ratingMove)
            .column()

        TrendChart(days: Array(days.suffix(state.period.days)))
            .padding(.top, 36)

        // The analytics provider's two views, side by side under the Search Console
        // chart and apart from it: the people on the site this half hour, and the
        // period's visits. A site without a provider has neither and gets no row.
        // A site that also sells gets its commerce provider's view as a third card:
        // the period's revenue, one bar per day like the visits.
        if hasAnalytics {
            HStack(alignment: .top, spacing: 20) {
                RealtimeCard(live: liveVisitors)
                VisitsCard(days: Array(days.suffix(state.period.days)), comparison: visitsComparison)
                if let report = revenueReport, report.revenue != nil {
                    RevenueCard(report: report)
                }
            }
            .column()
            .padding(.top, 36)

            // What visitors did, over the same period: the provider's third view,
            // the full column wide because event names run long.
            EventsCard(
                rows: rankings.events[RankingStore.KeywordsKey(siteID: overview.id, period: state.period)] ?? [],
                loading: rankings.loading.contains(overview.id)
            )
            .column()
            .padding(.top, 20)
        }

        rankingCards
            .column()
            .padding(.top, 36)
    }

    /// Today: nothing is stored yet, so everything here is the provider's, read live. Search
    /// Console has no figures for today at all, so its strip, chart and lists are not shown
    /// rather than shown empty.
    @ViewBuilder
    private var todayBody: some View {
        if let today = todayVisits {
            TodayStrip(today: today, rating: ratingMove)
                .column()

            HoursChart(today: today)
                .padding(.top, 36)

            HStack(alignment: .top, spacing: 20) {
                RealtimeCard(live: liveVisitors)
                PagesTodayCard(pages: today.pages)
            }
            .column()
            .padding(.top, 36)

            EventsCard(
                rows: today.events.map { EventRow(name: $0.name, current: $0.count, previous: 0, delta: 0) },
                loading: false
            )
            .column()
            .padding(.top, 20)
        } else if let report = live.todays[overview.id] {
            ContentUnavailableView(
                report.analytics == nil ? "No analytics provider" : "Analytics not ready",
                systemImage: "chart.bar.xaxis",
                description: Text(report.analytics?.reason ?? "Today is read live from the site's analytics provider, and \(overview.site.name) has none configured.")
            )
            .frame(minHeight: 320)
        } else {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, minHeight: 320)
        }
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
                    RankingCard.Row(
                        id: $0.id,
                        label: $0.targetUrl,
                        metrics: $0.window,
                        visits: $0.visits?.current.visits,
                        unindexed: $0.isUnindexed,
                        indexNote: $0.coverageState
                    )
                },
                loading: loading,
                emptyMessage: "No target pages in the registry yet."
            )
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
            if let generated = SiteTabScreen.instant(overview.dashboard?.generatedAt) {
                // Ticks from a coarse timeline, not SwiftUI's relative date text: that style
                // asks for a new frame continuously and costs a fifth of a core while idle.
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    Text("Updated \(RelativeAge.label(from: generated, to: context.date) ?? "at \(generated.formatted(date: .omitted, time: .shortened))")")
                        .help(generated.formatted(date: .abbreviated, time: .standard))
                }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}

// MARK: - Screen slot

/// One screen of a site tab, in a shell that SwiftUI can skip.
///
/// `Equatable` by the values a screen is drawn from, ignoring the refresh closure, which
/// cannot be compared and only ever refreshes the tab it belongs to. The stores are compared
/// by identity: the screens observe them directly, so a new row or a finished load
/// invalidates the rows that read it without passing through here. What this buys is that
/// a click on the rail, which re-evaluates the tab's body, leaves the screens behind the
/// active one untouched — their layout, and the dashboard's charts, stay as they are.
private struct ScreenSlot: View, Equatable {
    let screen: SiteScreen
    let overview: SiteOverview
    let state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let log: LogStore
    let isRefreshing: Bool
    let onRefresh: () -> Void

    nonisolated static func == (lhs: ScreenSlot, rhs: ScreenSlot) -> Bool {
        lhs.screen == rhs.screen
            && lhs.overview.site == rhs.overview.site
            && lhs.overview.dashboard?.generatedAt == rhs.overview.dashboard?.generatedAt
            && lhs.overview.errorMessage == rhs.overview.errorMessage
            && lhs.state === rhs.state
            && lhs.history === rhs.history
            && lhs.rankings === rhs.rankings
            && lhs.preferences === rhs.preferences
            && lhs.live === rhs.live
            && lhs.log === rhs.log
            && lhs.isRefreshing == rhs.isRefreshing
    }

    var body: some View {
        switch screen {
        case .dashboard:
            SiteDashboard(overview: overview, state: state, history: history, rankings: rankings, live: live, isRefreshing: isRefreshing)
        case .registry:
            RegistryScreen(overview: overview, state: state, rankings: rankings, onRefresh: onRefresh)
        case .planning:
            PlanningScreen(overview: overview, state: state, rankings: rankings, preferences: preferences, onRefresh: onRefresh)
        case .log:
            LogScreen(overview: overview, state: state, log: log, onRefresh: onRefresh)
        }
    }
}

#Preview("Site tab") {
    SiteTabScreen(
        overview: OverviewModel.preview.overviews[0],
        state: SiteTabState(siteID: "sleevy"),
        history: HistoryStore(),
        rankings: RankingStore(),
        preferences: PlanningPreferences(),
        live: LiveStore(),
        log: LogStore(),
        icon: nil,
        isRefreshing: false,
        onRefresh: {}
    )
    .frame(width: 1100, height: 640)
}
