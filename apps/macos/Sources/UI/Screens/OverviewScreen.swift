import SwiftUI

/// The overview: how every project does, read from what is stored. The strip sums the
/// sites over the period; under it, one card per project — the site in its own zone with
/// what it sold, then Search, Visitors and Plan, each the period against the period before
/// as a percentage and as two runs on one chart. Nothing here polls: the Realtime tab is
/// where the sites are watched, and this page is where they are compared.
///
/// The figures come from the same stores a site's dashboard reads, so the two never
/// disagree: the site's daily series once it is loaded, and until then the 28 days the
/// dashboard keeps on disk, which is what makes a warm launch land with numbers. The
/// sales and the plan come from the ranking store, loaded here the way a site tab loads it.
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

    /// When the newest dashboard was generated, over every site: the footer's figure.
    private var generatedAt: Date? {
        model.overviews.compactMap { SiteTabScreen.instant($0.dashboard?.generatedAt) }.max()
    }

    var body: some View {
        content
            // The series is what carries the visits and reaches back far enough to compare
            // six months with the six before; the ranked lists carry the sales and the
            // registry. Loaded once per session per site, cache first, the way a site tab
            // loads its own: a fetch, not a poll. The site list and the period are the id, so
            // a site added in Settings is read without a relaunch, and a new period fetches
            // the sales for it.
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
            // The same page as a site's tab: one reading column, centred, header at the top,
            // the numbers under it, the cards below, the footer last.
            let rows = rows
            VStack(alignment: .leading, spacing: 0) {
                header
                    .column()
                    .padding(.top, SiteTabScreen.columnInset)
                    .padding(.bottom, 40)

                GlanceStrip(
                    comparison: OverviewGlance.total(rows),
                    visits: OverviewGlance.totalVisits(rows),
                    siteCount: rows.count
                )
                .column()

                VStack(spacing: 12) {
                    ForEach(projects) { project in
                        ProjectCard(project: project, period: state.period, icon: favicons.image(for: project.id))
                            .onTapGesture(count: 2) { onOpenSite(project.id) }
                            .help(project.errorMessage ?? "Double-click to open \(project.site.name)")
                    }
                }
                .column()
                .padding(.top, 36)

                footer
                    .column()
                    .padding(.top, 24)
                    .padding(.bottom, SiteTabScreen.columnInset)
            }
            .readingColumn()
        }
    }

    /// One row, centred, like a site's header: the mark and the name; at the trailing edge
    /// the period, beside the refresh button. No live figure — nothing on this page moves on
    /// its own.
    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: ScreenRail.overviewSymbol)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)

            Text("Overview")
                .font(.title3.weight(.semibold))

            Spacer()

            HStack(spacing: 20) {
                WordSwitch(options: OverviewTabState.periods, selection: $state.period, label: \.label)
                    .accessibilityLabel("Period")
                    .disabled(isPreview)

                HStack(spacing: 10) {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                        .labelStyle(.iconOnly)
                        .disabled(busy)
                        .help("Refresh (⌘R)")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }

    /// Whether anything on the page is still on its way: the dashboards, any site's series,
    /// or any site's ranked lists.
    private var busy: Bool {
        model.isRefreshing || !history.refreshing.isEmpty || !rankings.loading.isEmpty
    }

    private var footer: some View {
        HStack {
            if let error = model.errorMessage ?? history.errors.values.first ?? rankings.errors.values.first {
                Text(error)
                    .foregroundStyle(Palette.coral)
                    .lineLimit(1)
            }
            Spacer()
            Text("\(model.loadedSiteCount) of \(model.sites.count) sites loaded")
            if model.isCached {
                Text("Cached")
            }
            if let generatedAt {
                // Ticks from a coarse timeline, not SwiftUI's relative date text: that style
                // asks for a new frame continuously and costs a fifth of a core while idle.
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    Text("Updated \(RelativeAge.label(from: generatedAt, to: context.date) ?? "at \(generatedAt.formatted(date: .omitted, time: .shortened))")")
                        .help(generatedAt.formatted(date: .abbreviated, time: .standard))
                }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}

// MARK: - Figures

/// How the Overview writes its numbers: whole counts, a rate in percent to one place, a
/// position to one place, and a move with its sign. One place for every cell, so a row and
/// the strip above it say the same thing the same way.
enum GlanceFigure {
    static func count(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0)))
    }

    static func rate(_ value: Double) -> String {
        value.formatted(.percent.precision(.fractionLength(1)))
    }

    /// A position of zero is no position: no impression put the site anywhere.
    static func position(_ value: Double) -> String {
        value > 0 ? value.formatted(.number.precision(.fractionLength(1))) : "—"
    }

    /// Mint when the move is the good way, coral otherwise. For a position, down is up.
    static func tint(_ delta: Double, lowerIsBetter: Bool = false) -> Color {
        (lowerIsBetter ? delta <= 0 : delta >= 0) ? Palette.mint : Palette.coral
    }
}

// MARK: - Strip

/// All sites' numbers in one row, in the metric strip's place: Search Console's four summed
/// over every site with their moves, then, beyond the hairline, the visits and how many
/// sites there are.
private struct GlanceStrip: View {
    let comparison: PeriodComparison
    let visits: VisitsComparison?
    let siteCount: Int

    var body: some View {
        let stats = comparison.currentStats
        HStack(alignment: .top, spacing: 0) {
            Metric(
                title: "Clicks",
                value: GlanceFigure.count(stats.clicks),
                change: comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.clicks.map { GlanceFigure.tint($0.delta) },
                dot: Palette.blue
            )
            gap
            Metric(
                title: "Impressions",
                value: GlanceFigure.count(stats.impressions),
                change: comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: comparison.impressions.map { GlanceFigure.tint($0.delta) },
                dot: Palette.amber
            )
            gap
            Metric(
                title: "Click-through rate",
                value: GlanceFigure.rate(stats.ctr),
                change: comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                tint: comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }
            )
            gap
            Metric(
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
            Metric(
                title: "Visits",
                value: visits.map { GlanceFigure.count($0.current) } ?? "—",
                change: visits?.trend.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: visits?.trend.map { GlanceFigure.tint($0.delta) },
                dot: visits == nil ? nil : visitsColor,
                footnote: visits == nil ? "No analytics" : nil
            )
            gap
            Metric(title: "Sites", value: String(siteCount))
        }
    }

    private var gap: some View {
        Spacer(minLength: 28)
    }
}

// MARK: - Reading a growth

/// What the screen says about a growth: the percentage, a word, a colour. The bands are the
/// screen's: ten percent either way is the line between moving and standing still. One
/// colour with one meaning — mint up, coral down, nothing for flat or unknown.
enum GrowthReading {
    static let band = 0.1

    /// "+34%", or "new" for a count that came from nothing, or a dash for nothing at all.
    static func label(_ growth: Growth) -> String {
        if let ratio = growth.ratio { return Trend.signed(ratio * 100, fractionDigits: 0) + "%" }
        return growth.current > 0 ? "new" : "—"
    }

    static func word(_ growth: Growth) -> String {
        guard let ratio = growth.ratio else { return growth.current > 0 ? "Started this period" : "Nothing yet" }
        if ratio >= band { return "Growing" }
        if ratio <= -band { return "Slipping" }
        return "Flat"
    }

    static func tint(_ growth: Growth) -> Color? {
        guard let ratio = growth.ratio else { return nil }
        if ratio >= band { return Palette.mint }
        if ratio <= -band { return Palette.coral }
        return nil
    }
}

// MARK: - Project card

/// One project: the site in a zone of its own on the left — its mark, name and origin, and
/// at the foot what it sold over the period when it sells — then three columns every site
/// has, Search, Visitors and Plan. A source the site does not have keeps its column and
/// says why, so the columns stand in the same place on every card. Double-click opens the
/// site's tab.
private struct ProjectCard: View {
    let project: ProjectTrajectory
    let period: Period
    let icon: Image?

    static let nameWidth: CGFloat = 150
    static let figureSize: CGFloat = 20
    static let pictureHeight: CGFloat = 36

    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            nameZone
                .frame(width: Self.nameWidth, alignment: .leading)
                // The zone takes the card's height, so the sales line at its foot sits on
                // the baseline the three charts share.
                .frame(maxHeight: .infinity, alignment: .top)

            HStack(alignment: .top, spacing: 20) {
                searchColumn
                visitorsColumn
                PlanColumn(plan: project.plan, period: period)
            }
        }
        // The row takes its own height — the columns' — and not what it is offered: a zone
        // let grow to the row's height would otherwise grow the row instead.
        .fixedSize(horizontal: false, vertical: true)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
        .contentShape(Rectangle())
    }

    private var nameZone: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 3))
                    } else {
                        Image(systemName: "globe").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 16, height: 16)
                Text(project.site.name)
                    .font(.headline)
                    .lineLimit(1)
            }
            Text(project.site.origin.replacingOccurrences(of: "https://", with: ""))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let error = project.errorMessage {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(Palette.coral)
                    .help(error)
            }
            if let sales = project.sales {
                Spacer(minLength: 12)
                SalesLine(sales: sales)
            }
        }
    }

    private var searchColumn: some View {
        let clicks = project.clicks
        return SourceColumn(
            title: "Search",
            growth: clicks,
            line: "\(GlanceFigure.count(clicks.current)) clicks" + (clicks.previous.map { ", was \(GlanceFigure.count($0))" } ?? ""),
            absent: nil
        ) {
            ComparisonChart(run: project.clicksRun, color: Palette.blue)
        }
    }

    private var visitorsColumn: some View {
        SourceColumn(
            title: "Visitors",
            growth: project.visits,
            line: project.visits.map { "\(GlanceFigure.count($0.current)) visits" + ($0.previous.map { ", was \(GlanceFigure.count($0))" } ?? "") } ?? "",
            absent: "No analytics provider"
        ) {
            ComparisonChart(run: project.visitsRun, color: visitsColor)
        }
    }
}

/// What the site sold over the period, as one line: the source's dot, the amount, the
/// growth in its colour. What it was is on hover.
private struct SalesLine: View {
    let sales: ProjectTrajectory.Sales

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(Palette.mint)
                .frame(width: 5, height: 5)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(Money.format(sales.growth.current, currency: sales.currency))
                .font(.callout)
                .monospacedDigit()
                .lineLimit(1)
            Text(GrowthReading.label(sales.growth))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(GrowthReading.tint(sales.growth) ?? .secondary)
        }
        .help("Sales this period. Was \(Money.format(sales.growth.previous ?? 0, currency: sales.currency)) the period before.")
        .accessibilityElement(children: .combine)
    }
}

/// One source's column: its name, the growth as the figure with its word beside it, the
/// counts it came from in a line, and the two runs as the picture. A source the site lacks
/// is a dash over the reason, with the picture's baseline and nothing on it.
private struct SourceColumn<Picture: View>: View {
    let title: String
    let growth: Growth?
    let line: String
    let absent: String?
    @ViewBuilder let picture: () -> Picture

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if let growth {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(GrowthReading.label(growth))
                        .font(.system(size: ProjectCard.figureSize, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(GrowthReading.tint(growth) ?? .primary)
                    Text(GrowthReading.word(growth))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                picture()
                    .frame(height: ProjectCard.pictureHeight)
                    .padding(.top, 6)
            } else {
                Text("—")
                    .font(.system(size: ProjectCard.figureSize, weight: .medium))
                Text(absent ?? "")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                EmptyPicture(text: "")
                    .frame(height: ProjectCard.pictureHeight)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}

/// The plan's column: the indexed share as the figure, its move over the period beside it,
/// how many planned pages a search has brought someone to, and the Indexed series as the
/// picture — or why there is none.
private struct PlanColumn: View {
    let plan: ProjectTrajectory.Plan?
    let period: Period

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Plan")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            if let plan, let share = plan.indexedShare {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(share.formatted(.percent.precision(.fractionLength(0))))
                        .font(.system(size: ProjectCard.figureSize, weight: .medium))
                        .monospacedDigit()
                    Text(plan.indexedMove.map { Trend.signed($0, fractionDigits: 0) + "pp" } ?? "indexed")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(plan.indexedMove.map { GlanceFigure.tint($0) } ?? .secondary)
                }
                Text("\(plan.funnel.clicked) of \(plan.funnel.planned) planned pages clicked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Group {
                    if plan.coverage.count >= 2 {
                        ComparisonChart(
                            run: ComparisonRun(
                                current: plan.coverage.compactMap { day in
                                    day.day.map { ComparisonRun.Point(date: $0, value: (day.indexedShare ?? 0) * 100) }
                                },
                                previous: [],
                                previousIsAverage: false
                            ),
                            color: Palette.mint,
                            format: { $0.formatted(.number.precision(.fractionLength(0))) + "%" },
                            fromZero: false
                        )
                    } else {
                        EmptyPicture(text: "Indexing series too young")
                    }
                }
                .frame(height: ProjectCard.pictureHeight)
                .padding(.top, 6)
            } else {
                Text("—")
                    .font(.system(size: ProjectCard.figureSize, weight: .medium))
                Text(plan == nil ? "No registry yet" : "No keyword pages planned")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                EmptyPicture(text: "")
                    .frame(height: ProjectCard.pictureHeight)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .help(plan.map { Self.help($0) } ?? "")
        .accessibilityElement(children: .combine)
    }

    /// The funnel, in words, for the pointer: what the share is measured over, and the steps.
    private static func help(_ plan: ProjectTrajectory.Plan) -> String {
        let f = plan.funnel
        return "Indexed over the \(f.planned) pages a keyword aims at. Planned \(f.planned), published \(f.published), indexed \(f.indexed), reached by a search \(f.reached), clicked \(f.clicked)."
    }
}

/// The picture's zone when there is nothing to draw: the reason, small, over the baseline
/// the chart would have had.
private struct EmptyPicture: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text(text)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
            Palette.line.frame(height: 1)
        }
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
