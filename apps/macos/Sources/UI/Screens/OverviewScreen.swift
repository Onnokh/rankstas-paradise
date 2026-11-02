import Charts
import SwiftUI

/// The overview: how every project does, read from what is stored.
///
/// The page is built the way a project's dashboard is, and on the same frame: the strip
/// first, under it one chart running the pane's full width, and the projects under that.
/// What differs is that the strip is also the switch — Clicks, Visits and Sales each carry a
/// run of days, so the one the reader lights is the one the chart draws, and the projects
/// below show that same source. Nothing here polls: the Realtime screen is where the sites
/// are watched, and this page is where they are compared.
///
/// The figures come from the same stores a project's dashboard reads, so the two never
/// disagree: the site's daily series once it is loaded, and until then the 28 days the
/// dashboard keeps on disk, which is what makes a warm launch land with numbers. The sales
/// come from the ranking store, loaded here the way a project's tab loads it.
struct OverviewScreen: View {
    let model: OverviewModel
    @Bindable var state: OverviewTabState
    let history: HistoryStore
    let rankings: RankingStore
    let favicons: FaviconStore
    let onOpenSite: (Site.ID) -> Void
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    /// Nothing loaded yet and nothing to report: the body itself shows a spinner.
    private var isFirstLoad: Bool {
        model.sites.isEmpty && model.errorMessage == nil
    }

    private var siteIDs: [Site.ID] { model.sites.map(\.id) }

    /// What the loading task is keyed on: the sites, and the period the ranked lists are for.
    private struct LoadKey: Equatable {
        let siteIDs: [Site.ID]
        let period: Period
    }

    private var rows: [SiteGlance] {
        OverviewGlance.rows(overviews: model.overviews, series: history.series, period: state.period)
    }

    private var projects: [ProjectTrajectory] {
        model.overviews.map { overview in
            ProjectTrajectory.make(
                overview: overview,
                series: history.series[overview.id],
                revenue: rankings.revenue[RankingStore.KeywordsKey(siteID: overview.id, period: state.period)],
                targets: rankings.registry[overview.id],
                coverage: rankings.coverage[overview.id] ?? [],
                period: state.period
            )
        }
    }

    var body: some View {
        // The page frame every screen wears — see `PageFrame`.
        PageFrame {
            header
        } content: {
            content
        }
        // The series is what carries the visits and reaches back far enough to compare
        // six months with the six before; the ranked lists carry the sales. Loaded once per
        // session per site, cache first, the way a project's tab loads its own: a fetch, not
        // a poll. The site list and the period are the id, so a site added in Settings is
        // read without a relaunch, and a new period fetches the sales for it.
        .task(id: LoadKey(siteIDs: siteIDs, period: state.period)) {
            guard !isPreview, !siteIDs.isEmpty else { return }
            let period = state.period
            await withTaskGroup(of: Void.self) { group in
                for siteID in siteIDs {
                    group.addTask { await history.load(siteID) }
                    group.addTask { await rankings.load(siteID, period: period) }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isFirstLoad {
            ProgressView("Loading sites…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage = model.errorMessage, model.sites.isEmpty {
            ErrorView(message: errorMessage, retry: onRefresh)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let projects = projects
            let fleet = FleetTrajectory.make(projects)
            let source = drawn(fleet)
            VStack(alignment: .leading, spacing: 0) {
                FleetStrip(
                    fleet: fleet,
                    comparison: OverviewGlance.total(rows),
                    siteCount: rows.count,
                    source: $state.source
                )
                .column()

                FleetChart(run: fleet.run(source), source: source, currency: fleet.currency)
                    .padding(.top, Page.stripInset)

                ProjectTiles(
                    projects: projects,
                    source: source,
                    icon: { favicons.image(for: $0) },
                    onOpen: onOpenSite
                )
                .column()
                .padding(.top, Page.blockInset)

                footer
                    .column()
                    .padding(.top, 24)
                    .padding(.bottom, Page.columnInset)
            }
            .padding(.top, Page.screenInset)
            .readingColumn()
        }
    }

    /// The source the page draws: the reader's choice, or the clicks when what they chose has
    /// nothing behind it. A fleet with no commerce provider has no sales to draw, and a
    /// choice made while a site had one must not leave the page blank after it is taken away.
    private func drawn(_ fleet: FleetTrajectory) -> OverviewSource {
        fleet.growth(state.source) == nil ? .clicks : state.source
    }

    /// One row, centred, like a project's header: the mark and the name; at the trailing edge
    /// the period, beside the refresh button. No live figure — nothing on this page moves on
    /// its own.
    private var header: some View {
        HStack(spacing: Page.titleSpacing) {
            PageTitle(symbol: ScreenRail.overviewSymbol, title: "Overview")

            Spacer()

            HStack(spacing: Page.controlSpacing) {
                WordSwitch(options: OverviewTabState.periods, selection: $state.period, label: \.label)
                    .accessibilityLabel("Period")
                    .disabled(isPreview)

                RefreshControl(busy: busy, action: onRefresh)
            }
        }
    }

    /// Whether anything on the page is still on its way: the dashboards, any site's series,
    /// or any site's ranked lists.
    private var busy: Bool {
        model.isRefreshing || !history.refreshing.isEmpty || !rankings.loading.isEmpty
    }

    /// What is wrong, when something is. How current the page is belongs to the tab bar,
    /// which says it once for every page — see `Freshness`.
    private var footer: some View {
        HStack {
            if let error = model.errorMessage ?? history.errors.values.first ?? rankings.errors.values.first {
                Text(error)
                    .foregroundStyle(Palette.coral)
                    .lineLimit(1)
            }
            Spacer()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}

// MARK: - Strip

/// The fleet's numbers in one row, in the metric strip's place, and the page's switch.
///
/// Clicks, Visits and Sales each have a run of days behind them, so each can be drawn: the
/// chosen one carries the headband, the style guide's mark for an active item, and the other
/// two keep an empty slot for it so a figure that can be chosen looks choosable before it is.
/// Impressions, the rate, the position and the count of projects have no run and stay inert.
///
/// The band is an overlay and takes no room, so this strip stands exactly as tall as a
/// project's — which is what keeps the chart under it on one line across the app.
private struct FleetStrip: View {
    let fleet: FleetTrajectory
    let comparison: PeriodComparison
    let siteCount: Int
    @Binding var source: OverviewSource

    /// Which choosable figure the pointer is over.
    @State private var pointedAt: OverviewSource?

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            choice(.clicks)
            gap
            choice(.impressions)
            gap
            choice(.ctr)
            gap
            Metric(
                title: "Position",
                value: GlanceFigure.position(comparison.currentStats.position),
                change: comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                tint: comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }
            )
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            choice(.visits, absent: "No analytics")
            gap
            choice(.sales, absent: "No sales")
            gap
            Metric(title: "Projects", value: String(siteCount))
        }
        .animation(.snappy(duration: 0.2), value: source)
    }

    /// One figure the chart can be drawn for. A source no project has is shown with its
    /// reason and cannot be chosen: there would be nothing to draw.
    private func choice(_ chosen: OverviewSource, absent: String? = nil) -> some View {
        let growth = fleet.growth(chosen)
        let isActive = source == chosen
        return Button {
            source = chosen
        } label: {
            Metric(
                title: chosen.label,
                value: growth.map { GlanceFigure.figure($0.current, source: chosen, currency: fleet.currency) } ?? "—",
                // The absolute move, as every other figure in the strip writes it; the
                // percentage belongs to the project tiles under the chart.
                change: growth.map { GlanceFigure.move($0, source: chosen, currency: fleet.currency) },
                tint: growth.flatMap { GlanceFigure.tint($0, source: chosen) },
                dot: chosen.dot,
                footnote: growth == nil ? absent : nil
            )
            // An overlay, so the mark costs the strip no height and every page's strip stays
            // the same height. The band sits in the room between the strip and the chart.
            .overlay(alignment: .bottomLeading) {
                if growth != nil {
                    Headband()
                        .fill(isActive ? Palette.acid : (pointedAt == chosen ? Palette.acid.opacity(0.5) : Palette.line))
                        .frame(width: 28, height: 3)
                        .offset(y: 9)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(growth == nil)
        .onHover { inside in
            pointedAt = inside ? chosen : (pointedAt == chosen ? nil : pointedAt)
        }
        .help(growth == nil ? (absent ?? "") : "Draw \(chosen.label.lowercased()) in the chart")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private var gap: some View {
        Spacer(minLength: 24)
    }
}

// MARK: - The chart

/// The fleet's chosen source as the pane's floor: the period as a line over a light fill, the
/// period before as a grey line behind it, one tick under each point, and the baseline as the
/// only rule. Drawn at the pane's full width with its end dates outside the plot, the way a
/// project's dashboard draws its own — a chart in a card is an item on the page; a chart
/// without one is the page's ground.
///
/// An earlier run that is a stand-in (one total spread evenly over the days, which is all the
/// sales report keeps) is dashed, so it never reads as measured days.
private struct FleetChart: View {
    let run: ComparisonRun
    let source: OverviewSource
    let currency: String?

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: Int?

    var body: some View {
        if run.current.count >= 2 {
            VStack(spacing: 6) {
                plot
                    .frame(minHeight: Page.chartHeight.lowerBound, maxHeight: Page.chartHeight.upperBound)
                endLabels
            }
        } else {
            ContentUnavailableView(
                "Not enough data",
                systemImage: "chart.xyaxis.line",
                description: Text("The chart needs at least two days.")
            )
            .frame(minHeight: Page.chartHeight.lowerBound)
        }
    }

    /// The first and last point, at the two ends of the run. Set outside the chart so the plot
    /// can reach the pane's edges while the words keep the column inset.
    private var endLabels: some View {
        HStack {
            Text(run.current.first!.date, format: .dateTime.day().month(.abbreviated))
            Spacer()
            Text(run.current.last!.date, format: .dateTime.day().month(.abbreviated))
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, Page.columnInset)
    }

    private var plot: some View {
        GeometryReader { geometry in
            let slot = geometry.size.width / CGFloat(max(run.current.count, 1))
            chart
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    guard !isPreview else { return }
                    switch phase {
                    case .active(let location):
                        hovered = min(max(Int(location.x / slot), 0), run.current.count - 1)
                    case .ended:
                        hovered = nil
                    }
                }
                // Always present and shown by opacity, never inserted: a label that came and
                // went under the pointer would take the hover with it. See `MinuteBars`.
                .overlay(alignment: .topLeading) {
                    let index = min(hovered ?? 0, run.current.count - 1)
                    let centre = slot * (CGFloat(index) + 0.5)
                    label(index)
                        .fixedSize()
                        .alignmentGuide(.leading) { label in
                            -min(max(centre - label.width / 2, Page.columnInset), max(geometry.size.width - label.width - Page.columnInset, 0))
                        }
                        .alignmentGuide(.top) { _ in -8 }
                        .opacity(hovered == nil ? 0 : 1)
                        .allowsHitTesting(false)
                }
        }
        .accessibilityHidden(true)
    }

    /// The point under the pointer: its day, what the line is at, and what the period before
    /// was on the same day. The numbers are the line's own — see `ComparisonRun`.
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
    }

    /// A value in the label, in the units of its source.
    private func figure(_ value: Double) -> String {
        // The sales run is kept in the currency's major units, as the report's days are.
        source.isMoney
            ? Money.format(value * 100, currency: currency)
            : GlanceFigure.figure(value, source: source, currency: currency)
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

            if let hovered, hovered < run.current.count {
                RuleMark(x: .value("Point", hovered))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Point", hovered), y: .value("Now", run.current[hovered].value))
                    .foregroundStyle(source.color)
                    .symbolSize(70)
            }
        }
        // A rate keeps its own range: a click-through rate that moves between 8 and 9 percent
        // drawn from a floor of nothing is a flat line. The room above the peaks for the label
        // is in the domain (see `ChartSpan`); none on the sides: the plot is the pane.
        .chartYScale(domain: ChartSpan.domain(run.current.map(\.value) + run.previous, fromZero: !source.isRate, headroom: 0.08))
        // The baseline is the only horizontal rule: a hairline at zero.
        .chartYAxis {
            AxisMarks(values: [0]) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(Palette.line)
            }
        }
        // One dot under each point. The dates themselves are set outside the plot.
        .chartXAxis {
            AxisMarks(values: Array(0..<max(run.current.count, 1))) { _ in
                AxisTick(centered: false, length: 2, stroke: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .foregroundStyle(Palette.line)
            }
        }
    }
}

// MARK: - The projects

/// The projects under the chart, four to a row: each one the chosen source, so the row reads
/// as the chart broken up by project. A tile says no verdict — the percentage is the reading,
/// and a word beside it would only say the percentage again.
///
/// Laid out with stacks rather than a lazy grid, so a still of the page draws them: lazy
/// content in an `ImageRenderer` comes out empty, and the peek shows stills.
private struct ProjectTiles: View {
    let projects: [ProjectTrajectory]
    let source: OverviewSource
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    /// Four across at the column's width leaves a tile wide enough for a name and a figure.
    /// A fleet of two gets two wider tiles rather than two narrow ones and a gap.
    private var perRow: Int { max(1, min(4, projects.count)) }

    private var rows: [[ProjectTrajectory]] {
        stride(from: 0, to: projects.count, by: perRow).map {
            Array(projects[$0..<min($0 + perRow, projects.count)])
        }
    }

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(row) { project in
                        // A real button, not a tap gesture: a click opens the project, the
                        // surface answers the pointer and the press, and the keyboard and
                        // VoiceOver reach it. It used to open on a double-click alone, which
                        // nothing on the tile announced.
                        Button { onOpen(project.id) } label: {
                            ProjectTile(project: project, source: source, icon: icon(project.id))
                        }
                        .clickableSurface(cornerRadius: 12, givesOnPress: true)
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
}

/// One project, in the chosen source: its mark and name, the growth as a percentage in its
/// colour, the count that percentage came from, and the period against the period before as a
/// spark. A project without the source keeps its tile and says so, so the tiles stand in the
/// same places whichever source is drawn.
private struct ProjectTile: View {
    let project: ProjectTrajectory
    let source: OverviewSource
    let icon: Image?

    var body: some View {
        let growth = project.growth(source)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 3))
                    } else {
                        Image(systemName: "globe").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 14, height: 14)
                Text(project.site.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let error = project.errorMessage {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(Palette.coral)
                        .help(error)
                }
            }
            .help("Open \(project.site.name)")

            Text(headline(growth))
                .font(.system(size: 20, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(growth.flatMap { GlanceFigure.tint($0, source: source) } ?? .primary)

            Text(line(growth))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spark(run: project.run(source), color: source.color, fromZero: !source.isRate, fills: source.fills)
                .frame(height: 30)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// How the project moved: a rate in percentage points, a count as a percentage of what it
    /// was. A rate's percentage would be a percentage of a percentage.
    private func headline(_ growth: Growth?) -> String {
        guard let growth else { return "—" }
        return source.isRate ? GlanceFigure.move(growth, source: source, currency: nil) : GrowthReading.label(growth)
    }

    /// What the figure was measured on, or why there is none.
    private func line(_ growth: Growth?) -> String {
        guard let growth else {
            switch source {
            case .clicks, .impressions: return "No search data"
            case .ctr: return "Nothing shown in search"
            case .visits: return "No analytics provider"
            case .sales: return "No commerce provider"
            }
        }
        let now = GlanceFigure.figure(growth.current, source: source, currency: project.sales?.currency)
        let unit = source.unit.isEmpty ? "" : " \(source.unit)"
        guard let previous = growth.previous else { return now + unit }
        let was = GlanceFigure.figure(previous, source: source, currency: project.sales?.currency)
        return "\(now)\(unit), was \(was)"
    }
}

#Preview("Overview") {
    OverviewScreen(
        model: .preview,
        state: OverviewTabState(),
        history: HistoryStore(),
        rankings: RankingStore(),
        favicons: FaviconStore(),
        onOpenSite: { _ in },
        onRefresh: {}
    )
    .frame(width: 1100, height: 640)
}
