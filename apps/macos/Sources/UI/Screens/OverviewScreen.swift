import SwiftUI

/// The overview: every site at once, live, on the same page as a site's own tab. The header
/// and the metric strip say how many people are on all the sites now and what today has
/// brought; the site tiles give each site its own — online now, the last half hour by the
/// minute, today so far; the Feed card is what visitors are doing on all of them, newest
/// first. Search Console has its figures on each site's tab; this page is the glance.
///
/// The header's site menu keeps the whole page to the sites it names: the strip sums them,
/// the tiles draw them, the feed shows them. Nothing chosen is every site.
struct OverviewScreen: View {
    let model: OverviewModel
    @Bindable var state: OverviewTabState
    let live: LiveStore
    let favicons: FaviconStore
    let onOpenSite: (Site.ID) -> Void
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    /// Nothing loaded yet and nothing to report: the body itself shows a spinner.
    private var isFirstLoad: Bool {
        model.sites.isEmpty && model.errorMessage == nil
    }

    private var siteIDs: [Site.ID] { model.sites.map(\.id) }

    private func isShown(_ siteID: Site.ID) -> Bool {
        state.siteFilter.isEmpty || state.siteFilter.contains(siteID)
    }

    /// The sites the page is kept to. Every site is still polled: the filter is a view.
    private var shownSites: [Site] { model.sites.filter { isShown($0.id) } }

    private var shownOverviews: [SiteOverview] { model.overviews.filter { isShown($0.id) } }

    /// The sites as the header's menu takes them, each under its favicon so the pill's
    /// cluster is the same picture as the tab bar.
    private var siteOptions: [FilterOption<Site.ID>] {
        model.sites.map { site in
            FilterOption(
                id: site.id,
                label: site.name,
                icon: favicons.image(for: site.id).map(FilterIcon.image) ?? .symbol("globe", tint: .secondary)
            )
        }
    }

    /// The feed's rows, kept to the sites and kinds the state names. Fifty is plenty for a
    /// glance and keeps every poll's redraw small.
    private var rows: [LiveFeedRow] {
        LiveFeedRow.rows(feeds: live.feeds, sites: model.sites, only: state.siteFilter, hiding: state.feedKinds.hidden, limit: 50)
    }

    /// When the newest feed answer was fetched, over every site: the footer's figure.
    private var feedFetchedAt: Date? {
        live.feeds.values.compactMap(\.fetchedAt).max()
    }

    private var windowMinutes: Int {
        live.feeds.values.first?.windowMinutes ?? 30
    }

    private var totalOnline: Double {
        shownSites.compactMap { live.reports[$0.id]?.live?.onlineNow }.reduce(0, +)
    }

    var body: some View {
        // The ages in the feed and the footer tick from this timeline, every quarter minute:
        // coarse enough to cost nothing, fine enough for "just now" to turn into "1m ago"
        // when it should. Never SwiftUI's relative date text, which redraws every frame.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            content(now: context.date)
        }
        // Both polls live exactly as long as the real screen is shown: a preview is a still.
        // The site list is the id, so a site added or removed restarts them over the new list.
        .task(id: siteIDs) {
            guard !isPreview, !siteIDs.isEmpty else { return }
            await live.pollAll(siteIDs)
        }
        .task(id: siteIDs) {
            guard !isPreview, !siteIDs.isEmpty else { return }
            await live.pollFeeds(siteIDs)
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        if isFirstLoad {
            ProgressView("Loading sites…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage = model.errorMessage, model.sites.isEmpty {
            ErrorView(message: errorMessage, retry: onRefresh)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            // The same page as a site's tab: one reading column, centred, header at the top,
            // the numbers under it, the cards below, the footer last.
            VStack(alignment: .leading, spacing: 0) {
                header
                    .column()
                    .padding(.top, SiteTabScreen.columnInset)
                    .padding(.bottom, 40)

                OverviewStrip(sites: shownSites, live: live)
                    .column()

                SiteTiles(
                    overviews: shownOverviews,
                    live: live,
                    favicons: favicons,
                    selection: state.selectedSiteID,
                    onSelect: { state.selectedSiteID = $0 },
                    onOpen: onOpenSite
                )
                .column()
                .padding(.top, 36)

                FeedCard(
                    rows: rows,
                    // One site kept means every row is that site's; the name would only
                    // repeat the header.
                    showsSite: shownSites.count != 1,
                    kinds: $state.feedKinds,
                    windowMinutes: windowMinutes,
                    waiting: live.feeds.isEmpty && live.feedErrors.isEmpty,
                    now: now
                )
                .column()
                .padding(.top, 20)

                footer(now: now)
                    .column()
                    .padding(.top, 24)
                    .padding(.bottom, SiteTabScreen.columnInset)
            }
            .readingColumn()
        }
    }

    /// One row, centred, like a site's header: the mark, the name, and the people on the
    /// shown sites now — the one figure on the page that moves on its own. At the trailing
    /// edge, the menu that keeps the page to some sites, beside the refresh button.
    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "square.grid.2x2")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)

            Text("Overview")
                .font(.title3.weight(.semibold))

            HStack(spacing: 6) {
                Circle()
                    .fill(visitsColor)
                    .frame(width: 7, height: 7)
                Text("\(Self.count(totalOnline)) online")
                    .monospacedDigit()
            }
            .foregroundStyle(.secondary)
            .padding(.leading, 6)
            .help("Distinct people on the shown sites in the last few minutes")

            Spacer()

            FilterMenu(
                options: siteOptions,
                selection: $state.siteFilter,
                allLabel: "All sites",
                severalLabel: { "\($0) sites" }
            )
            .accessibilityLabel("Sites")
            .disabled(isPreview)

            HStack(spacing: 14) {
                if model.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                    .labelStyle(.iconOnly)
                    .disabled(model.isRefreshing)
                    .help("Refresh (⌘R)")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
    }

    private func footer(now: Date) -> some View {
        HStack {
            if let error = model.errorMessage ?? live.errors.values.first ?? live.feedErrors.values.first {
                Text(error)
                    .foregroundStyle(Palette.coral)
                    .lineLimit(1)
            }
            Spacer()
            Text("\(model.loadedSiteCount) of \(model.sites.count) sites loaded")
            if model.isCached {
                Text("Cached")
            }
            if let feedFetchedAt {
                Text("Feed updated \(RelativeAge.label(from: feedFetchedAt, to: now) ?? "at \(feedFetchedAt.formatted(date: .omitted, time: .shortened))")")
                    .help(feedFetchedAt.formatted(date: .abbreviated, time: .standard))
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    static func count(_ value: Double?) -> String {
        (value ?? 0).formatted(.number.precision(.fractionLength(0)))
    }
}

// MARK: - Strip

/// All sites' numbers in one row, in the metric strip's place: the people online now and
/// today so far summed over every site, then, beyond the hairline, how many sites there are.
private struct OverviewStrip: View {
    let sites: [Site]
    let live: LiveStore

    private var todays: [TodayVisits] {
        sites.compactMap { live.todays[$0.id]?.today }
    }

    private var withAnalytics: Int {
        sites.filter { live.reports[$0.id]?.analytics != nil }.count
    }

    var body: some View {
        let online = sites.compactMap { live.reports[$0.id]?.live?.onlineNow }.reduce(0, +)
        let visits = todays.compactMap { $0.site?.visits }.reduce(0, +)
        let pageviews = todays.compactMap { $0.site?.pageviews }.reduce(0, +)
        let events = todays.map(\.eventCount).reduce(0, +)
        HStack(alignment: .top, spacing: 0) {
            Metric(title: "Online", value: OverviewScreen.count(online), dot: visitsColor)
            gap
            Metric(title: "Visits today", value: OverviewScreen.count(visits))
            gap
            Metric(title: "Pageviews today", value: OverviewScreen.count(pageviews))
            gap
            Metric(title: "Events today", value: OverviewScreen.count(events))
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            Metric(
                title: "Sites",
                value: String(sites.count),
                footnote: withAnalytics == sites.count ? nil : "\(withAnalytics) with analytics"
            )
        }
    }

    private var gap: some View {
        Spacer(minLength: 28)
    }
}

// MARK: - Sites

/// One tile per shown site, built to be read from across the room when the window is left
/// open: the people online now as a large figure, lilac while there is anyone, and the last
/// half hour as a strip of minutes that deepen with the crowd. A tile lights up while someone
/// is on the site, so a glance at the grid says which sites are alive.
///
/// The grid follows the count: one site fills the width, two share it, three sit in thirds,
/// four are two by two — and so on in twos. Busiest first, so the live sites are at the top
/// left; the quiet ones keep their alphabetical order after them. Double-click opens the
/// site's tab.
private struct SiteTiles: View {
    let overviews: [SiteOverview]
    let live: LiveStore
    let favicons: FaviconStore
    let selection: Site.ID?
    let onSelect: (Site.ID) -> Void
    let onOpen: (Site.ID) -> Void

    private func online(_ siteID: Site.ID) -> Double {
        live.reports[siteID]?.live?.onlineNow ?? -1
    }

    private var ordered: [SiteOverview] {
        overviews.sorted { left, right in
            let leftOnline = online(left.id)
            let rightOnline = online(right.id)
            if leftOnline != rightOnline { return leftOnline > rightOnline }
            return left.site.name.localizedStandardCompare(right.site.name) == .orderedAscending
        }
    }

    /// How many tiles share a row. Three is the one count that is not two: a lone third tile
    /// under a pair would read as an afterthought.
    private var columns: Int {
        switch ordered.count {
        case 0, 1: 1
        case 3: 3
        default: 2
        }
    }

    /// The online figure's size, shrinking as tiles share the width.
    private var heroSize: CGFloat {
        switch ordered.count {
        case 1: 72
        case 2: 56
        default: 44
        }
    }

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: columns),
            alignment: .leading,
            spacing: 16
        ) {
            ForEach(ordered) { overview in
                SiteTile(
                    overview: overview,
                    report: live.reports[overview.id],
                    today: live.todays[overview.id]?.today,
                    icon: favicons.image(for: overview.id),
                    heroSize: heroSize,
                    isSelected: overview.id == selection,
                    onSelect: { onSelect(overview.id) },
                    onOpen: { onOpen(overview.id) }
                )
            }
        }
        .animation(.snappy(duration: 0.3), value: ordered.map(\.id))
    }
}

private struct SiteTile: View {
    let overview: SiteOverview
    let report: LiveReport?
    let today: TodayVisits?
    let icon: Image?
    let heroSize: CGFloat
    let isSelected: Bool
    let onSelect: () -> Void
    let onOpen: () -> Void

    private var live: LiveVisitors? { report?.live }

    /// Someone is on the site: the tile's lit state.
    private var isLit: Bool { (live?.onlineNow ?? 0) > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 8) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                    } else {
                        Image(systemName: "globe").foregroundStyle(.secondary)
                    }
                }
                .frame(width: 16, height: 16)

                Text(overview.site.name)
                    .font(.subheadline.weight(.medium))
                Spacer()
                trailing
                    .font(.subheadline)
                    .monospacedDigit()
            }

            hero

            HeatStrip(values: live?.bars ?? [])
                .frame(height: heroSize > 50 ? 14 : 10)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isLit ? visitsColor.opacity(0.08) : Palette.raised, in: .rect(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(isLit ? visitsColor.opacity(0.35) : Palette.line, lineWidth: isSelected ? 2 : 1)
        )
        .animation(.snappy(duration: 0.3), value: isLit)
        .contentShape(Rectangle())
        // The double-click is declared first so it wins: a single click only selects.
        .onTapGesture(count: 2, perform: onOpen)
        .onTapGesture(perform: onSelect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// Today's visits — or, for a site the overview could not load, the reason.
    @ViewBuilder private var trailing: some View {
        if let error = overview.errorMessage {
            Text(error)
                .foregroundStyle(Palette.coral)
                .lineLimit(1)
                .help(error)
        } else if let today {
            Text("\(OverviewScreen.count(today.site?.visits)) today")
                .foregroundStyle(.secondary)
                .help("\(OverviewScreen.count(today.site?.visits)) visits and \(OverviewScreen.count(today.eventCount)) events today")
        }
    }

    /// The people on the site now. A site whose provider is configured but not ready says
    /// so; one without a provider says that; both in the figure's place, so a quiet tile and
    /// a blind one cannot be confused.
    @ViewBuilder private var hero: some View {
        if let live {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(OverviewScreen.count(live.onlineNow))
                    .font(.system(size: heroSize, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(isLit ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                    .contentTransition(.numericText())
                Text("online")
                    .foregroundStyle(.secondary)
            }
            .help("Distinct people on the site in the last \(live.onlineMinutes) minutes")
        } else {
            let status = report?.analytics
            Text(status.map { $0.ready ? "No analytics" : "Not ready" } ?? "—")
                .font(.system(size: heroSize * 0.5, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(height: heroSize * 1.2, alignment: .center)
                .help(status?.reason ?? "The site has no analytics provider.")
        }
    }
}

/// One cell per minute of the window, oldest on the left. A quiet minute is a stub in the
/// line colour; a busy one is lilac, deeper the more people were there against the window's
/// busiest minute. Not `MinuteBars`: height is what that one varies, and a tile wants a
/// strip of even height that reads as a barcode of activity from a distance.
private struct HeatStrip: View {
    let values: [Double]

    var body: some View {
        let peak = max(values.max() ?? 1, 1)
        let cells = values.isEmpty ? Array(repeating: 0.0, count: 30) : values
        HStack(spacing: 3) {
            ForEach(cells.indices, id: \.self) { index in
                let value = cells[index]
                RoundedRectangle(cornerRadius: 2)
                    .fill(value > 0 ? visitsColor.opacity(0.35 + 0.65 * value / peak) : Palette.line)
            }
        }
        .animation(.snappy(duration: 0.3), value: values)
        .accessibilityHidden(true)
    }
}

// MARK: - Feed

/// What visitors are doing on the shown sites, newest first. The header's words keep it to
/// page loads or events, the way a site tab's period switch works. The feed keeps moving
/// under the pointer: a new row simply appears at the top.
///
/// The rows are a plain stack, drawn in full and never animated. A lazy stack here kept the
/// main thread busy re-phasing its items on every poll, and a layout animation over the rows
/// every five seconds is what turned that into a hang; the rows are capped instead.
private struct FeedCard: View {
    let rows: [LiveFeedRow]
    /// Whether a row names its site: not when the page is kept to one.
    let showsSite: Bool
    @Binding var kinds: FeedKinds
    let windowMinutes: Int
    /// No feed has answered yet, and nothing has failed.
    let waiting: Bool
    /// The moment the ages are measured from; ticks from the screen's timeline.
    let now: Date

    @Environment(\.isTabPreview) private var isPreview
    /// The visitor under the pointer, as site and visitor token, so every row of that
    /// person's visit lights up together: their path through the site.
    @State private var hoveredVisitor: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Text("Feed")
                    .font(.headline)
                Spacer()
                WordSwitch(options: FeedKinds.allCases, selection: $kinds, label: \.label, font: .subheadline)
                    .accessibilityLabel("Kinds")
            }
            .disabled(isPreview)

            if rows.isEmpty {
                Text(waiting ? "Waiting for the provider…" : "Nothing in the last \(windowMinutes) minutes.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        let visitor = Self.visitorKey(row)
                        FeedRow(
                            row: row,
                            age: row.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? row.time,
                            showsSite: showsSite,
                            isHighlighted: hoveredVisitor == visitor,
                            isLast: index == rows.count - 1
                        )
                        .equatable()
                        .onHover { inside in
                            guard !isPreview else { return }
                            if inside {
                                hoveredVisitor = visitor
                            } else if hoveredVisitor == visitor {
                                hoveredVisitor = nil
                            }
                        }
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }

    /// One person on one site. The token is per provider, so it is scoped by site too.
    private static func visitorKey(_ row: LiveFeedRow) -> String {
        "\(row.siteID)|\(row.event.visitor)"
    }
}

/// One row: when, where, what kind, what, and who — as a country, a browser and a device. The
/// words come ready from the row; nothing is formatted here, so an unchanged row is skipped.
private struct FeedRow: View, Equatable {
    let row: LiveFeedRow
    /// "just now", "3m ago", or the clock time once it is an hour old; the exact time is on
    /// hover.
    let age: String
    /// Whether the site's name is shown: not when the feed is kept to one site.
    let showsSite: Bool
    /// Whether the pointer is on one of this visitor's rows.
    let isHighlighted: Bool
    let isLast: Bool

    private var event: LiveEvent { row.event }


    nonisolated static func == (left: FeedRow, right: FeedRow) -> Bool {
        left.row == right.row && left.age == right.age && left.showsSite == right.showsSite
            && left.isHighlighted == right.isHighlighted && left.isLast == right.isLast
    }

    var body: some View {
        HStack(spacing: 12) {
            // The guide's list marker, the tabs' own headband, on every row of the visitor
            // under the pointer. The slot is always there, so the row never shifts.
            Headband()
                .fill(Palette.acid)
                .frame(width: Headband.markerSize.width, height: Headband.markerSize.height)
                .opacity(isHighlighted ? 1 : 0)
                .accessibilityHidden(true)

            Text(age)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
                .help(row.time)

            if showsSite {
                Text(row.siteName)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: 104, alignment: .leading)
            }

            Image(systemName: event.kind.symbol)
                .foregroundStyle(event.kind == .event ? visitsColor : Color.secondary)
                .frame(width: 16)

            HStack(spacing: 6) {
                Text(row.primary)
                    .fontWeight(event.kind == .event ? .semibold : .regular)
                if let detail = row.detail {
                    Text("· \(detail)")
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)

            // How many times this person has been here, all time, on the rows of someone who
            // has been here before. The slot is always there, so no row shifts when one is
            // marked; a first visit is the ordinary case and is left unmarked.
            Group {
                if let visits = row.visits {
                    Text(visits)
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(visitsColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(visitsColor.opacity(0.12), in: .capsule)
                        .help(row.visitsHelp ?? visits)
                }
            }
            .frame(width: 52, alignment: .trailing)

            Text(row.who)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 216, alignment: .trailing)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(event.kind == .event ? visitsColor.opacity(0.08) : Color.clear, in: .rect(cornerRadius: 6))
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1).padding(.horizontal, 12)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct ErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .foregroundStyle(.secondary)
            Text(message)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            Button("Try Again", action: retry)
        }
        .frame(maxWidth: .infinity)
    }
}
