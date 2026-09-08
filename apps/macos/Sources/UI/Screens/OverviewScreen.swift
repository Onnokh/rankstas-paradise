import SwiftUI

/// The overview: every site at once, live. A strip with one row per site — who is online now,
/// the last half hour by the minute, today so far — over one feed of what visitors are doing
/// on all of them. Search Console has its figures on each site's own tab; this screen is the
/// glance, and the one that can be left open on a second display.
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

    /// The feed's rows and chip counts, kept to the site and kinds the state names.
    private var rows: [LiveFeedRow] {
        LiveFeedRow.rows(feeds: live.feeds, sites: model.sites, only: state.feedSiteID, hiding: state.hiddenKinds)
    }

    private var kindCounts: [LiveEvent.Kind: Int] {
        LiveFeedRow.kindCounts(feeds: live.feeds, sites: model.sites, only: state.feedSiteID)
    }

    /// When the newest feed answer was fetched, over every site: the footer's "updated" figure.
    private var feedFetchedAt: Date? {
        live.feeds.values.compactMap(\.fetchedAt).max()
    }

    private var windowMinutes: Int {
        live.feeds.values.first?.windowMinutes ?? 30
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if isFirstLoad {
                Spacer()
                ProgressView("Loading sites…")
                    .frame(maxWidth: .infinity)
                Spacer()
            } else if let errorMessage = model.errorMessage, model.sites.isEmpty {
                Spacer()
                ErrorView(message: errorMessage, retry: onRefresh)
                Spacer()
            } else {
                ScrollView {
                    VStack(spacing: 16) {
                        SitesStrip(
                            overviews: model.overviews,
                            live: live,
                            favicons: favicons,
                            selection: state.selectedSiteID,
                            onSelect: { state.selectedSiteID = $0 },
                            onOpen: onOpenSite
                        )
                        FeedCard(
                            rows: rows,
                            counts: kindCounts,
                            sites: model.sites,
                            siteFilter: $state.feedSiteID,
                            hiddenKinds: $state.hiddenKinds,
                            paused: $state.feedPaused,
                            windowMinutes: windowMinutes,
                            waiting: live.feeds.isEmpty && live.feedErrors.isEmpty
                        )
                    }
                }
                .scrollIndicators(.never)

                footer
            }
        }
        .padding(24)
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

    private var header: some View {
        HStack {
            VStack(alignment: .leading) {
                Text("Overview")
                    .font(.title)
                Text("Live across all sites")
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if model.isRefreshing, !isFirstLoad {
                ProgressView()
                    .controlSize(.small)
            }

            Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                .disabled(model.isRefreshing)
                .help("Refresh (⌘R)")
        }
    }

    private var footer: some View {
        HStack {
            Text("\(model.loadedSiteCount) of \(model.sites.count) sites loaded")
            if model.isCached {
                Text("Cached")
            }
            if let error = model.errorMessage ?? live.errors.values.first ?? live.feedErrors.values.first {
                Text(error)
                    .foregroundStyle(Palette.coral)
                    .lineLimit(1)
            }
            Spacer()
            Text("Double-click a site to open it")
            if let feedFetchedAt {
                Text("Feed updated ") + Text(feedFetchedAt, style: .relative) + Text(" ago")
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}

// MARK: - Sites strip

/// One row per site: the site, who is online now, the last half hour by the minute, and today
/// so far. Busiest first, so the sites with people on them are at the top; the quiet ones
/// keep their alphabetical order below.
private struct SitesStrip: View {
    let overviews: [SiteOverview]
    let live: LiveStore
    let favicons: FaviconStore
    let selection: Site.ID?
    let onSelect: (Site.ID) -> Void
    let onOpen: (Site.ID) -> Void

    static let onlineWidth: CGFloat = 96
    static let todayWidth: CGFloat = 112
    static let barsMinWidth: CGFloat = 160

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
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Text("Site")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Online")
                    .frame(width: Self.onlineWidth, alignment: .leading)
                Text("Last 30 minutes")
                    .frame(minWidth: Self.barsMinWidth, maxWidth: .infinity, alignment: .leading)
                Text("Today so far")
                    .frame(width: Self.todayWidth, alignment: .trailing)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            ForEach(ordered) { overview in
                Palette.line.frame(height: 1)
                SiteRow(
                    overview: overview,
                    report: live.reports[overview.id],
                    today: live.todays[overview.id]?.today,
                    icon: favicons.image(for: overview.id),
                    isSelected: overview.id == selection,
                    onSelect: { onSelect(overview.id) },
                    onOpen: { onOpen(overview.id) }
                )
            }
        }
        .cardSurface(cornerRadius: 12)
        .animation(.snappy(duration: 0.3), value: ordered.map(\.id))
    }
}

private struct SiteRow: View {
    let overview: SiteOverview
    let report: LiveReport?
    let today: TodayVisits?
    let icon: Image?
    let isSelected: Bool
    let onSelect: () -> Void
    let onOpen: () -> Void

    private static let iconSize: CGFloat = 18

    var body: some View {
        HStack(spacing: 16) {
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
            .frame(maxWidth: .infinity, alignment: .leading)

            onlineFigure
                .frame(width: SitesStrip.onlineWidth, alignment: .leading)

            Group {
                if let live = report?.live {
                    MinuteBars(values: live.bars, fetchedAt: Instant.parse(live.fetchedAt))
                } else {
                    Color.clear
                }
            }
            .frame(minWidth: SitesStrip.barsMinWidth, maxWidth: .infinity)
            .frame(height: 28)

            VStack(alignment: .trailing, spacing: 2) {
                if let today {
                    Text("\(count(today.site?.visits)) visits")
                        .monospacedDigit()
                    Text("\(count(today.eventCount)) events")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    Text("—")
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(width: SitesStrip.todayWidth, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
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
                    .frame(width: 7, height: 7)
                Text(count(live.onlineNow))
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
            }
            .help("Distinct people on the site in the last \(live.onlineMinutes) minutes")
        } else if let status = report?.analytics, !status.ready {
            Text("Not ready")
                .foregroundStyle(.secondary)
                .help(status.reason ?? "The analytics provider cannot be read.")
        } else if report != nil {
            Text("No provider")
                .foregroundStyle(.tertiary)
        } else {
            Text("—")
                .foregroundStyle(.tertiary)
        }
    }

    private func count(_ value: Double?) -> String {
        (value ?? 0).formatted(.number.precision(.fractionLength(0)))
    }
}

// MARK: - Feed

/// What visitors are doing on every site, newest first. Chips keep it to one site and to the
/// kinds worth watching; hovering holds the rows still so they can be read, as does Pause.
private struct FeedCard: View {
    let rows: [LiveFeedRow]
    let counts: [LiveEvent.Kind: Int]
    let sites: [Site]
    @Binding var siteFilter: Site.ID?
    @Binding var hiddenKinds: Set<LiveEvent.Kind>
    @Binding var paused: Bool
    let windowMinutes: Int
    /// No feed has answered yet, and nothing has failed.
    let waiting: Bool

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovering = false
    /// The rows as they were when the feed was held; nil while it moves.
    @State private var frozen: [LiveFeedRow]?

    private var held: Bool { paused || hovering }
    private var shown: [LiveFeedRow] { frozen ?? rows }

    /// Pageviews and events always have a chip; the auto-captured kinds only once seen.
    private var kinds: [LiveEvent.Kind] {
        LiveEvent.Kind.allCases.filter { kind in
            kind == .pageview || kind == .event || (counts[kind] ?? 0) > 0
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            chips
                .padding(16)

            Palette.line.frame(height: 1)

            if shown.isEmpty {
                Text(waiting ? "Waiting for the provider…" : "Nothing in the last \(windowMinutes) minutes.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 96)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(shown) { row in
                        FeedRow(row: row)
                        Palette.line.frame(height: 1)
                    }
                }
            }
        }
        .cardSurface(cornerRadius: 12)
        .onHover { inside in
            guard !isPreview else { return }
            hovering = inside
        }
        .onChange(of: held) { _, isHeld in
            frozen = isHeld ? rows : nil
        }
        .animation(.snappy(duration: 0.3), value: shown.map(\.id))
    }

    private var chips: some View {
        HStack(spacing: 8) {
            Text("Feed")
                .font(.headline)
                .padding(.trailing, 8)

            Chip(title: "All sites", isOn: siteFilter == nil) { siteFilter = nil }
            ForEach(sites) { site in
                Chip(title: site.name, isOn: siteFilter == site.id) { siteFilter = site.id }
            }

            Palette.line.frame(width: 1, height: 18)
                .padding(.horizontal, 4)

            ForEach(kinds, id: \.self) { kind in
                Chip(title: kind.label, count: counts[kind] ?? 0, isOn: !hiddenKinds.contains(kind)) {
                    if hiddenKinds.contains(kind) {
                        hiddenKinds.remove(kind)
                    } else {
                        hiddenKinds.insert(kind)
                    }
                }
            }

            Spacer(minLength: 0)

            Chip(
                title: held ? "Paused" : "Pause",
                symbol: held ? "play.fill" : "pause.fill",
                isOn: paused
            ) {
                paused.toggle()
            }
            .help(paused ? "Let the feed move again" : "Hold the feed still (hovering holds it too)")
        }
        .disabled(isPreview)
    }
}

/// One row: when, where, what kind, what, and who — as a country, a browser and a device.
private struct FeedRow: View {
    let row: LiveFeedRow

    private var event: LiveEvent { row.event }

    var body: some View {
        HStack(spacing: 12) {
            Text(time)
                .font(.callout.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)

            Text(row.siteName)
                .font(.caption)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Palette.panel, in: .rect(cornerRadius: 4))
                .frame(width: 112, alignment: .leading)

            Image(systemName: event.kind.symbol)
                .foregroundStyle(event.kind == .event ? visitsColor : Color.secondary)
                .frame(width: 18)

            HStack(spacing: 6) {
                Text(primary)
                    .fontWeight(event.kind == .event ? .semibold : .regular)
                if let detail {
                    Text("· \(detail)")
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(who)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 200, alignment: .trailing)
        }
        .font(.callout)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(event.kind == .event ? visitsColor.opacity(0.08) : Color.clear)
        .accessibilityElement(children: .combine)
    }

    private var time: String {
        event.date?.formatted(date: .omitted, time: .standard) ?? "—"
    }

    /// The row's subject: the page for a pageview, the name for an event, the link for an
    /// outbound click, the control's text for the rest.
    private var primary: String {
        switch event.kind {
        case .pageview:
            event.page
        case .event:
            event.name ?? "event"
        case .outbound:
            event.properties["url"].map(Self.shortURL) ?? event.name ?? "Outbound link"
        case .buttonClick, .copy, .formSubmit, .inputChange:
            event.properties["text"] ?? event.name ?? event.kind.label
        }
    }

    /// What goes with it: where a pageview came from, an event's data, the page the rest
    /// happened on.
    private var detail: String? {
        switch event.kind {
        case .pageview:
            event.referrer.flatMap(Self.host).map { "from \($0)" }
        case .event:
            Self.data(event.properties)
        case .outbound, .buttonClick, .copy, .formSubmit, .inputChange:
            "on \(event.page)"
        }
    }

    private var who: String {
        [event.country.map(Self.place), event.browser, event.device?.capitalized]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// "🇪🇸 Spain" from an ISO code: the flag is two regional indicator symbols.
    static func place(_ code: String) -> String {
        let upper = code.uppercased()
        let flag = upper.unicodeScalars
            .compactMap { UnicodeScalar(0x1F1E6 + $0.value - 0x41) }
            .map { String(Character($0)) }
            .joined()
        let name = Locale.current.localizedString(forRegionCode: upper) ?? upper
        return upper.count == 2 ? "\(flag) \(name)" : name
    }

    static func host(_ urlString: String) -> String? {
        URL(string: urlString)?.host()?.replacingOccurrences(of: "www.", with: "")
    }

    /// "github.com/onnokh/sleevy": the host and path, without the scheme and query.
    static func shortURL(_ urlString: String) -> String {
        guard let url = URL(string: urlString), let host = url.host() else { return urlString }
        let path = url.path().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return path.isEmpty ? host : "\(host)/\(path)"
    }

    /// The first few properties as "key value" pairs; nil when there are none.
    static func data(_ properties: [String: String]) -> String? {
        let pairs = properties.keys.sorted().prefix(3).map { "\($0) \(properties[$0] ?? "")" }
        return pairs.isEmpty ? nil : pairs.joined(separator: ", ")
    }
}

/// A filter, on or off. On carries the headband's acid, faintly, the way the guide marks the
/// active row.
private struct Chip: View {
    let title: String
    var count: Int? = nil
    var symbol: String? = nil
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.caption2)
                }
                Text(title)
                if let count {
                    Text(count.formatted())
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(isOn ? Palette.acid.opacity(0.16) : Color.clear, in: Capsule())
            .overlay(Capsule().strokeBorder(isOn ? Palette.acid.opacity(0.7) : Palette.line))
            .foregroundStyle(isOn ? Color.primary : Color.secondary)
        }
        .buttonStyle(.plain)
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
