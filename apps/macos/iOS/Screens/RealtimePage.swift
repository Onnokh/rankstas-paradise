import SwiftUI

/// The sites watched: who is on each site now, then the feed of what visitors are doing.
///
/// The one page that polls, as on the Mac, and only while it is in front: the task ends when
/// the tab is left or the phone goes to the background, and a count is never kept to be shown
/// stale later (see `LiveStore`).
struct RealtimePage: View {
    @Environment(OverviewModel.self) private var model
    @Environment(LiveStore.self) private var live
    @Environment(\.scenePhase) private var scenePhase

    /// The feed row opened to its steps: the tap that stands in for the Mac's tooltip.
    @State private var opened: LiveFeedRow.ID?

    private struct PollKey: Equatable {
        let siteIDs: [Site.ID]
        let isActive: Bool
    }

    var body: some View {
        NavigationStack {
            PhonePage(symbol: PhoneTab.realtime.symbol, title: "Realtime") {
                EmptyView()
            } content: {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        tiles
                            .pageColumn()
                            .padding(.top, 20)
                        SectionHead(title: "Feed")
                        feed
                    }
                    .padding(.bottom, 32)
                }
                .refreshable {
                    let siteIDs = model.sites.map(\.id)
                    async let counts: Void = live.refreshAll(siteIDs)
                    async let feeds: Void = live.refreshFeeds(siteIDs)
                    _ = await (counts, feeds)
                }
            }
            .navigationDestination(for: SiteRoute.self) { route in
                SitePage(siteID: route.siteID)
            }
        }
        .task(id: PollKey(siteIDs: model.sites.map(\.id), isActive: scenePhase == .active)) {
            guard scenePhase == .active else { return }
            let siteIDs = model.sites.map(\.id)
            async let counts: Void = live.pollAll(siteIDs)
            async let feeds: Void = live.pollFeeds(siteIDs)
            _ = await (counts, feeds)
        }
    }

    /// The sites two across on a phone, more with room, the busiest first, as on the Mac.
    private var tiles: some View {
        let ordered = model.overviews.sorted { left, right in
            let leftOnline = live.reports[left.id]?.live?.onlineNow ?? -1
            let rightOnline = live.reports[right.id]?.live?.onlineNow ?? -1
            if leftOnline != rightOnline { return leftOnline > rightOnline }
            return left.site.name.localizedStandardCompare(right.site.name) == .orderedAscending
        }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12, alignment: .top)], spacing: 12) {
            ForEach(ordered) { overview in
                NavigationLink(value: SiteRoute(siteID: overview.id)) {
                    SiteTile(overview: overview)
                }
                .buttonStyle(PressedSurface())
            }
        }
        .animation(.snappy(duration: 0.3), value: ordered.map(\.id))
    }

    /// One row per person, newest first. Ages come from a coarse clock, never from a relative
    /// date text, which asks for a frame every second.
    private var feed: some View {
        let rows = LiveFeedRow.rows(feeds: live.feeds, sites: model.sites, limit: 60)
        return TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(spacing: 0) {
                if rows.isEmpty {
                    QuietNote(text: model.sites.isEmpty ? "No sites yet." : "Nothing in the last half hour.")
                }
                ForEach(rows) { row in
                    let isOpen = opened == row.id
                    Button {
                        withAnimation(.snappy(duration: 0.25)) { opened = isOpen ? nil : row.id }
                    } label: {
                        FeedRow(row: row, age: RelativeAge.compact(from: row.newestAt, to: context.date), isOpen: isOpen, now: context.date)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// A site now: its mark and name, today's visits, the people on it as the one large figure,
/// and the half hour as a strip. Lit in the one colour while someone is there.
private struct SiteTile: View {
    let overview: SiteOverview

    @Environment(LiveStore.self) private var live

    var body: some View {
        let report = live.reports[overview.id]
        let visitors = report?.live
        let isLit = (visitors?.onlineNow ?? 0) > 0
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                SiteIcon(site: overview.site, size: 16)
                Text(overview.site.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }

            if let visitors {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(GlanceFigure.count(visitors.onlineNow))
                        .font(.system(size: 40, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(isLit ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary))
                        .contentTransition(.numericText())
                    Text("online")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(report?.analytics.map { $0.ready ? "No analytics" : "Not ready" } ?? "—")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .frame(height: 48, alignment: .center)
            }

            HeatStrip(values: visitors?.bars ?? [])
                .frame(height: 10)

            Text(caption)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(live.errors[overview.id] == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Palette.coral))
                .lineLimit(1)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isLit ? visitsColor.opacity(0.08) : Palette.raised, in: .rect(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(isLit ? visitsColor.opacity(0.35) : Palette.line, lineWidth: 1)
        )
        .animation(.snappy(duration: 0.3), value: isLit)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var caption: String {
        if let error = live.errors[overview.id] ?? overview.errorMessage { return error }
        guard let visits = live.todays[overview.id]?.today?.site?.visits else { return " " }
        return "\(GlanceFigure.count(visits)) today"
    }
}

/// One person: the age in its gutter, the site's mark, the newest step — in acid when it was
/// an action — and the flag at the end. A tap opens the steps under it, oldest first, which
/// is what the Mac's tooltip shows under the pointer.
private struct FeedRow: View {
    let row: LiveFeedRow
    let age: String
    let isOpen: Bool
    let now: Date

    private static let gutter: CGFloat = 34
    private static let limit = 8

    @Environment(FaviconStore.self) private var favicons

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Text(age)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .frame(width: Self.gutter, alignment: .leading)

                favicon

                VStack(alignment: .leading, spacing: 2) {
                    Text(row.headline)
                        .font(.subheadline)
                        .fontWeight(row.isAction ? .medium : .regular)
                        .foregroundStyle(row.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(row.caption.isEmpty ? row.siteName : row.caption)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 8) {
                    Text(row.visits ?? "")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .frame(width: 22, alignment: .trailing)
                    Text(row.flag)
                        .font(.body)
                        .frame(width: 20, alignment: .trailing)
                }
            }
            .frame(height: 52)

            if isOpen {
                steps
                    .padding(.leading, Self.gutter + 12)
                    .padding(.bottom, 12)
                    .transition(.opacity)
            }

            Rectangle().fill(Palette.line).frame(height: 1)
        }
        .pageColumn()
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var favicon: some View {
        if let image = favicons.image(for: row.siteID) {
            image.resizable().interpolation(.high).scaledToFit()
                .frame(width: 16, height: 16)
                .clipShape(.rect(cornerRadius: 3))
        } else {
            Color.clear.frame(width: 16, height: 16)
        }
    }

    private var steps: some View {
        let shown = Array(row.steps.suffix(Self.limit))
        return VStack(alignment: .leading, spacing: 6) {
            Text([row.who.isEmpty ? "Unknown visitor" : row.who, row.visitsHelp ?? "first visit"].joined(separator: " · "))
                .foregroundStyle(.secondary)
            if row.steps.count > shown.count {
                Text("\(row.steps.count - shown.count) earlier steps")
                    .foregroundStyle(.quaternary)
            }
            ForEach(shown) { step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(RelativeAge.labelOrTime(from: step.at, to: now))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .frame(width: 52, alignment: .leading)
                    Text(step.primary)
                        .fontWeight(step.isAction ? .medium : .regular)
                        .foregroundStyle(step.isAction ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.primary))
                        .truncationMode(.middle)
                    if step.repeats > 1 {
                        Text("×\(step.repeats)").monospacedDigit().foregroundStyle(.tertiary)
                    }
                }
                .lineLimit(1)
            }
        }
        .font(.caption)
    }
}
