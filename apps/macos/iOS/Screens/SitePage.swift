import SwiftUI

/// One site, on the Overview's page: the same header row, with the site's mark and name where
/// the Overview has its own and the period at the trailing end, so the dashboard's figures and
/// chart stand exactly where the Overview's do. The site's four screens — `SiteScreen`, the
/// Mac's rail's own list — are a menu on the name; a back button leads the row, and the swipe
/// back still works.
struct SitePage: View {
    let siteID: Site.ID

    @Environment(OverviewModel.self) private var model
    @State private var screen: SiteScreen = .dashboard
    @State private var period: Period = .d28

    var body: some View {
        PhonePage {
            SiteTitle(site: model.sites.first(where: { $0.id == siteID }), screen: $screen)
        } trailing: {
            if screen == .dashboard {
                PeriodControl(period: $period)
            }
        } content: {
            if let overview = model.overviews.first(where: { $0.id == siteID }) {
                switch screen {
                case .dashboard: DashboardScreen(overview: overview, period: $period)
                case .registry: RegistryPane(siteID: siteID)
                case .planning: PlanningPane(siteID: siteID)
                case .log: LogPane(siteID: siteID)
                }
            } else {
                ContentUnavailableView("This site is gone", systemImage: "questionmark.square.dashed")
            }
        }
    }
}

/// The site page's title: back, then the site's mark and name as `PageTitle` sets them, opening
/// the menu of the site's screens. A screen other than the dashboard is named after the site,
/// so the row always says where the reader is.
private struct SiteTitle: View {
    let site: Site?
    @Binding var screen: SiteScreen

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack(spacing: 6) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.title3.weight(.semibold))
                    .frame(width: 28, height: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")

            Menu {
                Picker("Screen", selection: $screen) {
                    ForEach(SiteScreen.allCases, id: \.self) { option in
                        Label(option.title, systemImage: option.symbol).tag(option)
                    }
                }
            } label: {
                HStack(spacing: Page.titleSpacing) {
                    if let site { SiteIcon(site: site, size: Page.markSize) }
                    Text(site?.name ?? "Site")
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                    if screen != .dashboard {
                        Text(screen.title)
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .foregroundStyle(Palette.text)
            }
        }
    }
}

// MARK: - Dashboard

/// The period's figures and chart where the Overview has its own, then who is on the site now,
/// then the strongest search terms.
private struct DashboardScreen: View {
    let overview: SiteOverview
    @Binding var period: Period

    @Environment(HistoryStore.self) private var history
    @Environment(RankingStore.self) private var rankings
    @Environment(LiveStore.self) private var live
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isRoomy) private var isRoomy

    @State private var source: OverviewSource = .clicks

    private var siteID: Site.ID { overview.id }

    private struct LoadKey: Equatable {
        let siteID: Site.ID
        let period: Period
    }

    var body: some View {
        let project = ProjectTrajectory.make(
            overview: overview,
            series: history.series[siteID],
            revenue: rankings.revenue[key],
            targets: rankings.registry[siteID],
            coverage: rankings.coverage[siteID] ?? [],
            period: period
        )
        let drawn = project.growth(source) == nil ? OverviewSource.clicks : source
        let currency = project.sales?.currency

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PeriodFigures(drawn: drawn, growth: { project.growth($0) }, currency: currency, source: $source)

                RunChart(run: project.run(drawn), source: drawn, currency: currency, height: isRoomy ? 300 : 170)

                if live.reports[siteID]?.live != nil {
                    SectionHead(title: "Now")
                    liveLine
                        .pageColumn()
                        .padding(.top, 8)
                }

                queries

                if let error = overview.errorMessage ?? history.errors[siteID] ?? rankings.errors[siteID] {
                    ErrorLine(message: error).padding(.top, 16)
                }
            }
            .padding(.bottom, 32)
        }
        .refreshable {
            async let series: Void = history.refresh(siteID)
            async let lists: Void = rankings.refresh(siteID, period: period)
            async let now: Void = live.refresh(siteID)
            _ = await (series, lists, now)
        }
        .task(id: LoadKey(siteID: siteID, period: period)) {
            async let series: Void = history.load(siteID)
            async let lists: Void = rankings.load(siteID, period: period)
            _ = await (series, lists)
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await live.poll(siteID)
        }
    }

    private var key: RankingStore.KeywordsKey {
        RankingStore.KeywordsKey(siteID: siteID, period: period)
    }

    private var comparison: PeriodComparison {
        PeriodComparison(
            days: OverviewGlance.days(for: overview, series: history.series[siteID]).map(\.asHistoryDay),
            window: period.days
        )
    }

    /// Who is on the site now, in one line over the half hour's strip: the figure in the one
    /// colour while someone is there.
    @ViewBuilder
    private var liveLine: some View {
        if let visitors = live.reports[siteID]?.live {
            let isLit = visitors.onlineNow > 0
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(GlanceFigure.count(visitors.onlineNow))
                        .font(.system(size: 22, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(isLit ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                        .contentTransition(.numericText())
                    Text("online")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let today = live.todays[siteID]?.today?.site {
                        Text("\(GlanceFigure.count(today.visits)) today")
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                HeatStrip(values: visitors.bars).frame(height: 8)
            }
        }
    }

    @ViewBuilder
    private var queries: some View {
        if let rows = rankings.keywords[key], !rows.isEmpty {
            // The site's mean position, which the strip leaves out so its columns match the
            // Overview's, heads the column of positions it is the mean of.
            SectionHead(
                title: "Search terms",
                trailing: "Clicks · Position, \(GlanceFigure.position(comparison.currentStats.position)) avg."
            )
            ForEach(rows.sorted { $0.current.clicks > $1.current.clicks }.prefix(RankingStore.rowLimit)) { row in
                QuietRow {
                    HStack(spacing: 12) {
                        Text(row.query)
                            .font(.subheadline)
                            .foregroundStyle(row.brand ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(GlanceFigure.count(row.current.clicks))
                            .font(.subheadline)
                            .monospacedDigit()
                            .frame(width: 52, alignment: .trailing)
                        Text(GlanceFigure.position(row.current.position))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(width: 36, alignment: .trailing)
                    }
                }
            }
        }
    }
}

// MARK: - Registry

/// Every target page with its phase and its window's figures. A page Google reports as not
/// indexed is dimmed, as on the Mac, and says why in coral, because a phone has no tooltip to
/// hold the reason.
private struct RegistryPane: View {
    let siteID: Site.ID

    @Environment(RankingStore.self) private var rankings

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                let targets = rankings.registry[siteID] ?? []
                if targets.isEmpty {
                    QuietNote(text: rankings.loading.contains(siteID) ? "Loading…" : "No target pages.")
                }
                ForEach(targets) { target in
                    let isIndexed = target.indexed == nil || target.indexed == "indexed"
                    QuietRow(height: isIndexed ? 56 : 72) {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(URL(string: target.targetUrl)?.path() ?? target.targetUrl)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Text(target.phase.capitalized)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if !isIndexed {
                                    Text(target.coverageState ?? "Not indexed")
                                        .font(.caption)
                                        .foregroundStyle(Palette.coral)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Text(GlanceFigure.count(target.window.clicks))
                                .font(.subheadline)
                                .monospacedDigit()
                                .frame(width: 48, alignment: .trailing)
                            Text(GlanceFigure.position(target.window.position))
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 36, alignment: .trailing)
                        }
                        .opacity(isIndexed ? 1 : 0.55)
                    }
                }
            }
        }
        .task { await rankings.load(siteID, period: .d28) }
        .refreshable { await rankings.refresh(siteID, period: .d28) }
    }
}

// MARK: - Planning

/// The plan's keywords with their verdict and their demand. The Mac judges them against a
/// difficulty the reader sets; the phone shows the server's verdict only.
private struct PlanningPane: View {
    let siteID: Site.ID

    @Environment(RankingStore.self) private var rankings

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                let keywords = rankings.health[siteID]?.keywords ?? []
                if keywords.isEmpty {
                    QuietNote(text: rankings.loading.contains(siteID) ? "Loading…" : (rankings.healthErrors[siteID] ?? "No planned keywords."))
                }
                ForEach(keywords.sorted { ($0.searchVolume ?? -1) > ($1.searchVolume ?? -1) }) { keyword in
                    QuietRow(height: 56) {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(keyword.keyword).font(.subheadline).lineLimit(1)
                                Text(KeywordVerdict(rawValue: keyword.verdict)?.label ?? keyword.verdict)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Text(keyword.searchVolume.map(GlanceFigure.count) ?? "—")
                                .font(.subheadline)
                                .monospacedDigit()
                                .frame(width: 56, alignment: .trailing)
                            Text(keyword.difficulty.map { "KD \(GlanceFigure.count($0))" } ?? "")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 44, alignment: .trailing)
                        }
                    }
                }
            }
        }
        .task { await rankings.load(siteID, period: .d28) }
        .refreshable { await rankings.refresh(siteID, period: .d28) }
    }
}

// MARK: - Log

/// The site's work record, a section per day, newest first. The kind is a word in its own
/// zone, not a symbol: a row says what was done the way the Mac's log does.
private struct LogPane: View {
    let siteID: Site.ID

    @Environment(LogStore.self) private var log

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                let entries = log.entries[siteID] ?? []
                if entries.isEmpty {
                    QuietNote(text: log.loading.contains(siteID) ? "Loading…" : (log.errors[siteID] ?? "Nothing logged yet."))
                }
                ForEach(days(entries), id: \.date) { day in
                    SectionHead(title: day.date)
                    ForEach(day.entries) { entry in
                        QuietRow(height: 56) {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(entry.path).font(.subheadline).lineLimit(1).truncationMode(.middle)
                                    Text(entry.note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                Text(LogKind(rawValue: entry.kind)?.label ?? entry.kind)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .frame(width: 92, alignment: .trailing)
                            }
                        }
                    }
                }
            }
        }
        .task { await log.load(siteID) }
        .refreshable { await log.refresh(siteID) }
    }

    private func days(_ entries: [LogEntry]) -> [(date: String, entries: [LogEntry])] {
        Dictionary(grouping: entries, by: \.date)
            .map { (date: $0.key, entries: $0.value) }
            .sorted { $0.date > $1.date }
    }
}
