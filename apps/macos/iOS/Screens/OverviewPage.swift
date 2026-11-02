import SwiftUI

/// The projects compared, as the Mac's Overview compares them: the fleet's figures over the
/// period, the chosen one drawn against the period before, then one row per project.
///
/// The arithmetic is the Mac's — `ProjectTrajectory` and `FleetTrajectory` — so the phone and
/// the Mac say the same number for the same period. The figures and the chart are a site's
/// dashboard's, in the same places — see `PeriodFigures`. At a phone's width the page is cut to
/// the screen: the chart keeps a modest height and the rows take what is left. With room, on
/// the Duo's inner display, the page is the Mac's — see `RoomyOverview`.
struct OverviewPage: View {
    @Environment(OverviewModel.self) private var model
    @Environment(HistoryStore.self) private var history
    @Environment(RankingStore.self) private var rankings

    @State private var period: Period = .d28
    @State private var source: OverviewSource = .clicks
    @State private var topHeight: CGFloat = 0

    @Environment(\.isRoomy) private var isRoomy

    private struct LoadKey: Equatable {
        let siteIDs: [Site.ID]
        let period: Period
    }

    var body: some View {
        NavigationStack {
            PhonePage(symbol: PhoneTab.overview.symbol, title: "Overview") {
                PeriodControl(period: $period)
            } content: {
                content
            }
            .navigationDestination(for: SiteRoute.self) { route in
                SitePage(siteID: route.siteID)
            }
        }
        .task(id: LoadKey(siteIDs: model.sites.map(\.id), period: period)) {
            await loadAll(period)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.sites.isEmpty, model.errorMessage == nil {
            ProgressView().frame(maxHeight: .infinity)
        } else if let error = model.errorMessage, model.sites.isEmpty {
            ContentUnavailableView {
                Label("No sites", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await model.refresh() } }
            }
        } else {
            let projects = projects
            let fleet = FleetTrajectory.make(projects)
            let drawn = fleet.growth(source) == nil ? OverviewSource.clicks : source
            let error = model.errorMessage ?? history.errors.values.first ?? rankings.errors.values.first
            if isRoomy {
                RoomyOverview(fleet: fleet, projects: projects, drawn: drawn, source: $source, error: error)
                    .refreshable { await refreshAll() }
            } else {
            GeometryReader { geometry in
                let split = Split.of(
                    room: geometry.size.height - topHeight - RunChart.chrome - Split.rowsChrome,
                    rows: projects.count
                )
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        PeriodFigures(drawn: drawn, growth: { fleet.growth($0) }, currency: fleet.currency, source: $source)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { topHeight = $0 }

                        RunChart(run: fleet.run(drawn), source: drawn, currency: fleet.currency, height: split.chart)

                        ProjectRows(projects: projects, source: drawn, rowHeight: split.row)
                            .padding(.top, 18)
                            .padding(.bottom, 12)

                        if let error {
                            ErrorLine(message: error).padding(.bottom, 16)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .refreshable { await refreshAll() }
            }
        }
    }

    private var projects: [ProjectTrajectory] {
        model.overviews.map { overview in
            ProjectTrajectory.make(
                overview: overview,
                series: history.series[overview.id],
                revenue: rankings.revenue[RankingStore.KeywordsKey(siteID: overview.id, period: period)],
                targets: rankings.registry[overview.id],
                coverage: rankings.coverage[overview.id] ?? [],
                period: period
            )
        }
    }

    private func loadAll(_ period: Period) async {
        let siteIDs = model.sites.map(\.id)
        await withTaskGroup(of: Void.self) { group in
            for siteID in siteIDs {
                group.addTask { await history.load(siteID) }
                group.addTask { await rankings.load(siteID, period: period) }
            }
        }
    }

    private func refreshAll() async {
        await model.refresh()
        let siteIDs = model.sites.map(\.id)
        let period = period
        await withTaskGroup(of: Void.self) { group in
            for siteID in siteIDs {
                group.addTask { await history.refresh(siteID) }
                group.addTask { await rankings.refresh(siteID, period: period) }
            }
        }
    }
}

/// The Overview with a small tablet's room, laid out as the Mac lays it out: every figure in
/// one strip, the chart across the full width, and the projects as the Mac's tiles. The strip
/// and the tiles stand in a column narrower than the display, as the Mac's reading column
/// does, and the chart alone runs edge to edge under them. The chart takes the height the
/// strip and the tiles leave, so the page fills the display; it scrolls only when the tiles
/// need more than the chart's floor leaves them.
private struct RoomyOverview: View {
    let fleet: FleetTrajectory
    let projects: [ProjectTrajectory]
    let drawn: OverviewSource
    @Binding var source: OverviewSource
    let error: String?

    @State private var topHeight: CGFloat = 0
    @State private var bottomHeight: CGFloat = 0

    private static let chartRange: ClosedRange<CGFloat> = 220...520
    /// From this width four tiles across leave each one room for a name and a figure.
    private static let fourAcross: CGFloat = 860

    var body: some View {
        GeometryReader { geometry in
            let room = geometry.size.height - topHeight - bottomHeight - RunChart.chrome
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PeriodFigures(drawn: drawn, growth: { fleet.growth($0) }, currency: fleet.currency, source: $source)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { topHeight = $0 }

                    RunChart(
                        run: fleet.run(drawn),
                        source: drawn,
                        currency: fleet.currency,
                        height: min(max(room, Self.chartRange.lowerBound), Self.chartRange.upperBound)
                    )

                    VStack(alignment: .leading, spacing: 16) {
                        ProjectTiles(
                            projects: projects,
                            source: drawn,
                            perRow: geometry.size.width >= Self.fourAcross ? 4 : 2
                        )
                        .pageColumn()
                        if let error { ErrorLine(message: error) }
                    }
                    .padding(.top, 28)
                    .padding(.bottom, 20)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bottomHeight = $0 }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// The Mac's tiles, `perRow` across. A fleet smaller than a row gets wider tiles rather than
/// narrow ones and a gap, and a short last row keeps a full row's tile width.
private struct ProjectTiles: View {
    let projects: [ProjectTrajectory]
    let source: OverviewSource
    let perRow: Int

    var body: some View {
        let across = max(1, min(perRow, projects.count))
        VStack(spacing: 12) {
            ForEach(Array(stride(from: 0, to: projects.count, by: across)), id: \.self) { start in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(projects[start..<min(start + across, projects.count)]) { project in
                        NavigationLink(value: SiteRoute(siteID: project.site.id)) {
                            ProjectTile(project: project, source: source)
                        }
                        .buttonStyle(PressedSurface())
                    }
                    let missing = across - min(across, projects.count - start)
                    ForEach(0..<missing, id: \.self) { _ in
                        Color.clear.frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }
}

/// The Mac's project tile: the mark and name, the growth as a percentage in its colour, the
/// count it came from, and the period against the period before as a spark. A project without
/// the source keeps its tile and says so, so the tiles stand still whichever source is drawn.
private struct ProjectTile: View {
    let project: ProjectTrajectory
    let source: OverviewSource

    var body: some View {
        let growth = project.growth(source)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                SiteIcon(site: project.site, size: 14)
                Text(project.site.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if project.errorMessage != nil {
                    Spacer(minLength: 0)
                    Circle().fill(Palette.coral).frame(width: 6, height: 6)
                }
            }

            Text(growth.map { ProjectRows.headline($0, source: source) } ?? "—")
                .font(.system(size: 20, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(growth.flatMap { GlanceFigure.tint($0, source: source) } ?? .primary)

            Text(ProjectRows.count(project, growth, source: source))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spark(run: project.run(source), color: source.color, fromZero: !source.isRate, fills: source.fills)
                .frame(height: 30)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .cardSurface(cornerRadius: 12)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// How the height under the figures is shared. The chart keeps a modest height and the rows
/// take what is left, up to a ceiling; only past that does the chart grow. With more projects
/// than fit, the chart and the rows stop at their floors and the page scrolls.
private struct Split {
    let chart: CGFloat
    let row: CGFloat

    /// The gaps around the rows and the hairline above them.
    static let rowsChrome: CGFloat = 18 + 1 + 12

    private static let chartRange: ClosedRange<CGFloat> = 140...300
    private static let chartPreferred: CGFloat = 170
    private static let rowRange: ClosedRange<CGFloat> = 56...72

    static func of(room: CGFloat, rows: Int) -> Split {
        guard rows > 0 else { return Split(chart: chartPreferred, row: rowRange.lowerBound) }
        let count = CGFloat(rows)
        let row = min(max((room - chartPreferred) / count, rowRange.lowerBound), rowRange.upperBound)
        let chart = min(max(room - row * count, chartRange.lowerBound), chartRange.upperBound)
        return Split(chart: chart, row: row)
    }
}

/// Projects as quiet rows: the favicon, the name over the figure it came from, the spark,
/// and the growth. A project without the source keeps its row and says so.
private struct ProjectRows: View {
    let projects: [ProjectTrajectory]
    let source: OverviewSource
    let rowHeight: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Palette.line).frame(height: 1).padding(.horizontal, Phone.inset)
            ForEach(projects) { project in
                let growth = project.growth(source)
                NavigationLink(value: SiteRoute(siteID: project.site.id)) {
                    QuietRow(height: rowHeight) {
                        HStack(spacing: 12) {
                            SiteIcon(site: project.site, size: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.site.name).font(.body).lineLimit(1)
                                Text(Self.count(project, growth, source: source))
                                    .font(.caption)
                                    .monospacedDigit()
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Spark(run: project.run(source), color: source.color, fromZero: !source.isRate, fills: source.fills)
                                .frame(width: 84, height: 22)
                            Text(growth.map { Self.headline($0, source: source) } ?? "—")
                                .font(.callout.weight(.medium))
                                .monospacedDigit()
                                .foregroundStyle(growth.flatMap { GlanceFigure.tint($0, source: source) } ?? .secondary)
                                .lineLimit(1)
                                .frame(width: 58, alignment: .trailing)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(PressedSurface())
            }
        }
    }

    /// How a project moved: a rate in percentage points, a count as a percentage of what it was.
    static func headline(_ growth: Growth, source: OverviewSource) -> String {
        source.isRate ? GlanceFigure.move(growth, source: source, currency: nil) : GrowthReading.label(growth)
    }

    /// The figure the growth came from, as the Mac's tile says it.
    static func count(_ project: ProjectTrajectory, _ growth: Growth?, source: OverviewSource) -> String {
        guard let growth else {
            switch source {
            case .clicks, .impressions: return "No search data"
            case .ctr: return "Nothing shown"
            case .visits: return "No analytics"
            case .sales: return "No shop"
            }
        }
        let now = GlanceFigure.figure(growth.current, source: source, currency: project.sales?.currency)
        guard let previous = growth.previous else { return now }
        return "\(now), was \(GlanceFigure.figure(previous, source: source, currency: project.sales?.currency))"
    }
}

/// A surface that answers the finger: it dims while pressed, as the Mac's surfaces answer the
/// pointer. Nothing else moves.
struct PressedSurface: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
