import SwiftUI

/// The overview: every site at a glance, read from what is stored. The strip sums the sites
/// over the period; under it, one line per site — Search Console's clicks, impressions,
/// click-through rate and position, and the analytics provider's visits over the same days —
/// each figure with its move against the period before. Nothing here polls: the Realtime tab
/// is where the sites are watched, and this page is where they are compared.
///
/// The figures come from the same stores a site's dashboard reads, so the two never
/// disagree: the site's daily series once it is loaded, and until then the 28 days the
/// dashboard keeps on disk, which is what makes a warm launch land with numbers.
struct OverviewScreen: View {
    let model: OverviewModel
    @Bindable var state: OverviewTabState
    let history: HistoryStore
    let favicons: FaviconStore
    let onOpenSite: (Site.ID) -> Void
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    /// Nothing loaded yet and nothing to report: the body itself shows a spinner.
    private var isFirstLoad: Bool {
        model.sites.isEmpty && model.errorMessage == nil
    }

    private var siteIDs: [Site.ID] { model.sites.map(\.id) }

    private var rows: [SiteGlance] {
        OverviewGlance.rows(overviews: model.overviews, series: history.series, period: state.period)
    }

    /// When the newest dashboard was generated, over every site: the footer's figure.
    private var generatedAt: Date? {
        model.overviews.compactMap { SiteTabScreen.instant($0.dashboard?.generatedAt) }.max()
    }

    var body: some View {
        content
            // The series is what carries the visits and reaches back far enough to compare
            // six months with the six before. Loaded once per session per site, cache first,
            // the way a site tab loads its own: a fetch, not a poll. The site list is the id,
            // so a site added in Settings is read without a relaunch.
            .task(id: siteIDs) {
                guard !isPreview, !siteIDs.isEmpty else { return }
                await withTaskGroup(of: Void.self) { group in
                    for siteID in siteIDs {
                        group.addTask { await history.load(siteID) }
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
            // the numbers under it, the card below, the footer last.
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

                SitesCard(
                    rows: rows,
                    icon: { favicons.image(for: $0) },
                    onOpen: onOpenSite
                )
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

    /// Whether anything on the page is still on its way: the dashboards, or any site's series.
    private var busy: Bool {
        model.isRefreshing || !history.refreshing.isEmpty
    }

    private var footer: some View {
        HStack {
            if let error = model.errorMessage ?? history.errors.values.first {
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

// MARK: - Sites

/// One line per site, in the tab bar's order, under a row of column names. Fixed zones left
/// to right: the site, then five figures, each with its move in a slot of its own so the
/// figures line up down the card. Double-click opens the site's tab.
private struct SitesCard: View {
    let rows: [SiteGlance]
    let icon: (Site.ID) -> Image?
    let onOpen: (Site.ID) -> Void

    @Environment(\.isTabPreview) private var isPreview
    /// The row under the pointer: it takes a faint fill, the same as a feed row.
    @State private var hoveredRow: Site.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: SiteGlanceRow.spacing) {
                Text("Sites")
                    .font(.headline)
                    .frame(width: SiteGlanceRow.siteWidth, alignment: .leading)
                ForEach(SiteGlanceRow.columns, id: \.self) { column in
                    Text(column)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(.bottom, 4)

            VStack(spacing: 0) {
                ForEach(rows) { row in
                    SiteGlanceRow(row: row, icon: icon(row.id), isHovered: hoveredRow == row.id)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { onOpen(row.id) }
                        .onHover { inside in
                            guard !isPreview else { return }
                            if inside {
                                hoveredRow = row.id
                            } else if hoveredRow == row.id {
                                hoveredRow = nil
                            }
                        }
                        .help(row.errorMessage ?? "Double-click to open \(row.site.name)")
                }
            }
            .animation(.easeOut(duration: 0.12), value: hoveredRow)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

/// One site's line. The site at callout with its favicon; every figure at body, monospaced,
/// with its move in caption beside it — mint or coral, the one colour with one meaning on
/// the row. A site whose dashboard could not be loaded keeps whatever is cached and carries
/// the reason in its tooltip.
private struct SiteGlanceRow: View {
    let row: SiteGlance
    let icon: Image?
    let isHovered: Bool

    static let height: CGFloat = 40
    static let spacing: CGFloat = 16
    static let siteWidth: CGFloat = 200
    static let columns = ["Clicks", "Impressions", "CTR", "Position", "Visits"]
    /// How far the hover's fill reaches past the row's words on either side.
    private static let overhang: CGFloat = 8

    var body: some View {
        let stats = row.comparison.currentStats
        HStack(alignment: .firstTextBaseline, spacing: Self.spacing) {
            HStack(spacing: 8) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 3))
                    } else {
                        Image(systemName: "globe").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 16, height: 16)
                Text(row.site.name)
                    .font(.callout)
                    .lineLimit(1)
            }
            .frame(width: Self.siteWidth, alignment: .leading)

            Figure(
                value: GlanceFigure.count(stats.clicks),
                change: row.comparison.clicks.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: row.comparison.clicks.map { GlanceFigure.tint($0.delta) }
            )
            Figure(
                value: GlanceFigure.count(stats.impressions),
                change: row.comparison.impressions.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: row.comparison.impressions.map { GlanceFigure.tint($0.delta) }
            )
            Figure(
                value: GlanceFigure.rate(stats.ctr),
                change: row.comparison.ctrPointsDelta.map { Trend.signed($0, fractionDigits: 1) + "pp" },
                tint: row.comparison.ctrPointsDelta.map { GlanceFigure.tint($0) }
            )
            Figure(
                value: GlanceFigure.position(stats.position),
                change: row.comparison.positionDelta.map { Trend.signed($0, fractionDigits: 1) },
                tint: row.comparison.positionDelta.map { GlanceFigure.tint($0, lowerIsBetter: true) }
            )
            Figure(
                value: row.visits.map { GlanceFigure.count($0.current) } ?? "—",
                change: row.visits?.trend.map { Trend.signed($0.delta, fractionDigits: 0) },
                tint: row.visits?.trend.map { GlanceFigure.tint($0.delta) }
            )
        }
        .frame(height: Self.height)
        .padding(.horizontal, Self.overhang)
        .background(isHovered ? Palette.line.opacity(0.45) : Color.clear, in: .rect(cornerRadius: 6))
        .padding(.horizontal, -Self.overhang)
        .accessibilityElement(children: .combine)
    }
}

/// One figure and its move, right-aligned in a flexible zone. The move has a slot of its
/// own whether or not there is one, so the figures of every row end on the same line.
private struct Figure: View {
    let value: String
    let change: String?
    let tint: Color?

    private static let changeWidth: CGFloat = 52

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(value)
                .font(.body)
                .monospacedDigit()
            Text(change ?? "")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(tint ?? .secondary)
                .frame(width: Self.changeWidth, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

#Preview("Overview") {
    OverviewScreen(
        model: .preview,
        state: OverviewTabState(),
        history: HistoryStore(),
        favicons: FaviconStore(),
        onOpenSite: { _ in },
        onRefresh: {}
    )
    .frame(width: 1100, height: 640)
}
