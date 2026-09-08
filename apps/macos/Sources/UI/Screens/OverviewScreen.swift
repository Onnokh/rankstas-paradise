import SwiftUI

/// The overview: every site at once, live, on the same page as a site's own tab. The header
/// and the metric strip say how many people are on all the sites now and what today has
/// brought; the Sites card gives each site its row — online now, the last half hour by the
/// minute, today so far; the Feed card is what visitors are doing on all of them, newest
/// first. Search Console has its figures on each site's tab; this page is the glance.
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

    /// The feed's rows, kept to the site and kinds the state names. Fifty is plenty for a
    /// glance and keeps every poll's redraw small.
    private var rows: [LiveFeedRow] {
        LiveFeedRow.rows(feeds: live.feeds, sites: model.sites, only: state.feedSiteID, hiding: state.feedKinds.hidden, limit: 50)
    }

    /// When the newest feed answer was fetched, over every site: the footer's figure.
    private var feedFetchedAt: Date? {
        live.feeds.values.compactMap(\.fetchedAt).max()
    }

    private var windowMinutes: Int {
        live.feeds.values.first?.windowMinutes ?? 30
    }

    private var totalOnline: Double {
        model.sites.compactMap { live.reports[$0.id]?.live?.onlineNow }.reduce(0, +)
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
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                        .column()
                        .padding(.top, SiteTabScreen.columnInset)
                        .padding(.bottom, 40)

                    OverviewStrip(sites: model.sites, live: live)
                        .column()

                    SitesCard(
                        overviews: model.overviews,
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
                        sites: model.sites,
                        siteFilter: $state.feedSiteID,
                        kinds: $state.feedKinds,
                        paused: $state.feedPaused,
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
            }
            .scrollDisabled(isPreview)
        }
    }

    /// One row, centred, like a site's header: the mark, the name, how many sites, and the
    /// people on all of them now — the one figure on the page that moves on its own.
    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "square.grid.2x2")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)

            Text("Overview")
                .font(.title3.weight(.semibold))

            Text("\(model.sites.count) sites")
                .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                Circle()
                    .fill(visitsColor)
                    .frame(width: 7, height: 7)
                Text("\(Self.count(totalOnline)) online")
                    .monospacedDigit()
            }
            .foregroundStyle(.secondary)
            .padding(.leading, 6)
            .help("Distinct people on all sites in the last few minutes")

            Spacer()

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

/// One row per site: the site, who is online now, the last half hour by the minute, and today
/// so far. Busiest first, so the sites with people on them are at the top; the quiet ones
/// keep their alphabetical order below. Double-click opens the site's tab.
private struct SitesCard: View {
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

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Sites")
                    .font(.headline)
                Spacer()
                Text("Online now, the last 30 minutes, and today")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 0) {
                ForEach(Array(ordered.enumerated()), id: \.element.id) { index, overview in
                    SiteRow(
                        overview: overview,
                        report: live.reports[overview.id],
                        today: live.todays[overview.id]?.today,
                        icon: favicons.image(for: overview.id),
                        isSelected: overview.id == selection,
                        isLast: index == ordered.count - 1,
                        onSelect: { onSelect(overview.id) },
                        onOpen: { onOpen(overview.id) }
                    )
                }
            }
            .animation(.snappy(duration: 0.3), value: ordered.map(\.id))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .cardSurface(cornerRadius: 12)
    }
}

private struct SiteRow: View {
    let overview: SiteOverview
    let report: LiveReport?
    let today: TodayVisits?
    let icon: Image?
    let isSelected: Bool
    let isLast: Bool
    let onSelect: () -> Void
    let onOpen: () -> Void

    private static let iconSize: CGFloat = 18

    var body: some View {
        HStack(spacing: 20) {
            HStack(spacing: 10) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                    } else {
                        Image(systemName: "globe").foregroundStyle(.secondary)
                    }
                }
                .frame(width: Self.iconSize, height: Self.iconSize)

                VStack(alignment: .leading, spacing: 2) {
                    Text(overview.site.name)
                        .fontWeight(.medium)
                    Text(overview.errorMessage ?? overview.site.origin)
                        .font(.caption)
                        .foregroundStyle(overview.errorMessage == nil ? Color.secondary : Palette.coral)
                        .lineLimit(1)
                        .help(overview.errorMessage ?? overview.site.origin)
                }
            }
            .frame(width: 200, alignment: .leading)

            onlineFigure
                .frame(width: 72, alignment: .leading)

            Group {
                if let live = report?.live {
                    MinuteBars(values: live.bars, fetchedAt: Instant.parse(live.fetchedAt))
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 28)

            VStack(alignment: .trailing, spacing: 2) {
                if let today {
                    Text("\(OverviewScreen.count(today.site?.visits)) visits")
                        .monospacedDigit()
                    Text("\(OverviewScreen.count(today.eventCount)) events")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    Text("—")
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(width: 96, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(isSelected ? Color.primary.opacity(0.05) : Color.clear, in: .rect(cornerRadius: 6))
        .overlay(alignment: .bottom) {
            if !isLast {
                Palette.line.frame(height: 1).padding(.horizontal, 12)
            }
        }
        .contentShape(Rectangle())
        // The double-click is declared first so it wins: a single click only selects.
        .onTapGesture(count: 2, perform: onOpen)
        .onTapGesture(perform: onSelect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// The people on the site now, with the lilac dot every live figure carries. A site whose
    /// provider is configured but not ready says so; one without a provider says that.
    @ViewBuilder private var onlineFigure: some View {
        if let live = report?.live {
            HStack(spacing: 7) {
                Circle()
                    .fill(visitsColor)
                    .frame(width: 6, height: 6)
                Text(OverviewScreen.count(live.onlineNow))
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            .help("Distinct people on the site in the last \(live.onlineMinutes) minutes")
        } else if let status = report?.analytics, !status.ready {
            Text("Not ready")
                .font(.callout)
                .foregroundStyle(.secondary)
                .help(status.reason ?? "The analytics provider cannot be read.")
        } else if report != nil {
            Text("No analytics")
                .font(.callout)
                .foregroundStyle(.tertiary)
        } else {
            Text("—")
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Feed

/// What visitors are doing on every site, newest first. The header's words keep it to one
/// site and to page loads or events, the way a site tab's period switch works; hovering holds
/// the rows still so they can be read, as does Pause.
///
/// The rows are a plain stack, drawn in full and never animated. A lazy stack here kept the
/// main thread busy re-phasing its items on every poll, and a layout animation over the rows
/// every five seconds is what turned that into a hang; the rows are capped instead.
private struct FeedCard: View {
    let rows: [LiveFeedRow]
    let sites: [Site]
    @Binding var siteFilter: Site.ID?
    @Binding var kinds: FeedKinds
    @Binding var paused: Bool
    let windowMinutes: Int
    /// No feed has answered yet, and nothing has failed.
    let waiting: Bool
    /// The moment the ages are measured from; ticks from the screen's timeline.
    let now: Date

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovering = false
    /// The rows as they were when the feed was held; nil while it moves.
    @State private var frozen: [LiveFeedRow]?
    /// The visitor under the pointer, as site and visitor token, so every row of that
    /// person's visit lights up together: their path through the site.
    @State private var hoveredVisitor: String?

    private var held: Bool { paused || hovering }
    private var shown: [LiveFeedRow] { frozen ?? rows }

    /// The site choices as the word switch takes them: all first, then each site.
    private var siteChoices: [SiteChoice] {
        [SiteChoice(id: SiteChoice.allID, label: "All sites")] + sites.map { SiteChoice(id: $0.id, label: $0.name) }
    }

    private var siteChoice: Binding<SiteChoice> {
        Binding(
            get: { siteChoices.first { $0.id == (siteFilter ?? SiteChoice.allID) } ?? siteChoices[0] },
            set: { siteFilter = $0.id == SiteChoice.allID ? nil : $0.id }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Text("Feed")
                    .font(.headline)
                if held {
                    Text(paused ? "Paused" : "Held")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }
                Spacer()
                WordSwitch(options: siteChoices, selection: siteChoice, label: \.label, font: .subheadline)
                    .accessibilityLabel("Site")
                Rectangle()
                    .fill(Palette.line)
                    .frame(width: 1, height: 14)
                WordSwitch(options: FeedKinds.allCases, selection: $kinds, label: \.label, font: .subheadline)
                    .accessibilityLabel("Kinds")
                Button(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill") {
                    paused.toggle()
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(paused ? "Let the feed move again" : "Hold the feed still (hovering holds it too)")
            }
            .disabled(isPreview)
            .animation(.snappy(duration: 0.2), value: held)

            if shown.isEmpty {
                Text(waiting ? "Waiting for the provider…" : "Nothing in the last \(windowMinutes) minutes.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, row in
                        let visitor = Self.visitorKey(row)
                        FeedRow(
                            row: row,
                            age: row.event.date.map { RelativeAge.labelOrTime(from: $0, to: now) } ?? row.time,
                            showsSite: siteFilter == nil,
                            isHighlighted: hoveredVisitor == visitor,
                            isLast: index == shown.count - 1
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
        .onHover { inside in
            guard !isPreview else { return }
            hovering = inside
        }
        .onChange(of: held) { _, isHeld in
            frozen = isHeld ? rows : nil
        }
    }

    /// One person on one site. The token is per provider, so it is scoped by site too.
    private static func visitorKey(_ row: LiveFeedRow) -> String {
        "\(row.siteID)|\(row.event.visitor)"
    }
}

/// A site to keep the feed to, or all of them, as the word switch takes its options.
private struct SiteChoice: Hashable, Identifiable {
    static let allID = ""
    let id: String
    let label: String
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
