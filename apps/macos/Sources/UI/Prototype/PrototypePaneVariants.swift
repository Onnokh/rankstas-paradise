import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// The in-pane variants: the title-bar tabs and the peek stay as shipped; only the site pane
// changes. H puts the pages at the foot of the pane, I stacks all four with an index, J shows
// two pages side by side, M keeps the dashboard and opens the other pages in a drawer.

// MARK: - Shared

/// A one-line pane header: a title, the period when the dashboard is showing, refresh.
struct PrototypeSlimHeader: View {
    let title: String
    @Bindable var state: SiteTabState
    let refreshing: Bool
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        HStack(spacing: 20) {
            Text(title)
                .font(.title3.weight(.semibold))
            Spacer()
            if state.section == .dashboard {
                WordSwitch(options: Period.allCases, selection: $state.period, label: \.label)
                    .disabled(isPreview)
            }
            PrototypeRefreshButton(refreshing: refreshing, action: onRefresh)
        }
        .padding(.horizontal, SiteTabScreen.columnInset)
        .frame(height: 52)
    }
}

private struct Hairline: View {
    var vertical = false
    var body: some View {
        Rectangle()
            .fill(Palette.line)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

/// The shipped site screen with its header dropped, drawn from any state.
private struct HostedSite: View {
    let overview: SiteOverview
    let state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        SiteTabScreen(
            overview: overview,
            state: state,
            history: history,
            rankings: rankings,
            preferences: preferences,
            live: live,
            icon: icon,
            isRefreshing: isRefreshing,
            onRefresh: onRefresh
        )
        .environment(\.siteSectionsHosted, true)
        .id(state.section)
    }
}

// MARK: - H: page bar at the foot

/// Like sheet tabs in Numbers: the pages sit in a strip along the bottom of the pane, where
/// the eye lands after the content, and the header is only the site.
struct PrototypeBottomBarPane<Content: View>: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let live: LiveStore
    let icon: Image?
    let refreshing: Bool
    let onRefresh: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        VStack(spacing: 0) {
            PrototypeSiteHeader(overview: overview, state: state, live: live, icon: icon, showsSections: false, refreshing: refreshing, onRefresh: onRefresh)
            Hairline()
            content()
            Hairline()
            bar
        }
    }

    private var bar: some View {
        HStack(spacing: 0) {
            ForEach(SiteSection.allCases) { section in
                let isActive = state.section == section
                Button {
                    state.section = section
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: section.symbol)
                            .font(.callout)
                        Text(section.label)
                            .font(.callout.weight(isActive ? .semibold : .regular))
                        if let count = count(for: section) {
                            Text(count.formatted())
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .overlay(alignment: .top) {
                        Headband()
                            .fill(Palette.acid)
                            .frame(width: 28, height: 3)
                            .opacity(isActive ? 1 : 0)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(isPreview)
                if section != SiteSection.allCases.last {
                    Hairline(vertical: true).frame(height: 20)
                }
            }
        }
        .background(Palette.raised)
        .animation(.snappy(duration: 0.2), value: state.section)
    }

    private func count(for section: SiteSection) -> Int? {
        switch section {
        case .registry: rankings.registry[overview.id]?.count
        case .planning: rankings.health[overview.id]?.keywords.count
        case .dashboard, .log: nil
        }
    }
}

// MARK: - I: all pages stacked

/// No navigation: the four pages are one long page, each the height of the pane, with a
/// small index on the right that jumps between them. The wheel scrolls the page under the
/// pointer; the index moves the stack.
struct PrototypeStackedPane: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    /// One state per stacked page; the dashboard is the tab's own so its period is kept.
    @State private var pageStates: [SiteSection: SiteTabState]
    @State private var current: SiteSection = .dashboard

    init(overview: SiteOverview, state: SiteTabState, history: HistoryStore, rankings: RankingStore, preferences: PlanningPreferences, live: LiveStore, icon: Image?, isRefreshing: Bool, onRefresh: @escaping () -> Void) {
        self.overview = overview
        self.state = state
        self.history = history
        self.rankings = rankings
        self.preferences = preferences
        self.live = live
        self.icon = icon
        self.isRefreshing = isRefreshing
        self.onRefresh = onRefresh
        var states: [SiteSection: SiteTabState] = [:]
        for section in SiteSection.allCases where section != .dashboard {
            let pageState = SiteTabState(siteID: overview.id)
            pageState.section = section
            states[section] = pageState
        }
        _pageStates = State(initialValue: states)
    }

    private func pageState(_ section: SiteSection) -> SiteTabState {
        if section == .dashboard { return state }
        return pageStates[section] ?? state
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(SiteSection.allCases) { section in
                            VStack(spacing: 0) {
                                PrototypeSlimHeader(
                                    title: section == .dashboard ? overview.site.name : section.label,
                                    state: pageState(section),
                                    refreshing: isRefreshing,
                                    onRefresh: onRefresh
                                )
                                Hairline()
                                HostedSite(overview: overview, state: pageState(section), history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
                            }
                            .frame(height: proxy.size.height)
                            .id(section)
                            if section != SiteSection.allCases.last {
                                Rectangle().fill(Palette.void).frame(height: 8)
                            }
                        }
                    }
                }
                .scrollDisabled(true)
                .overlay(alignment: .trailing) {
                    index { section in
                        current = section
                        withAnimation(.snappy(duration: 0.35)) {
                            scroller.scrollTo(section, anchor: .top)
                        }
                    }
                    .padding(.trailing, 14)
                }
                // ⌘⌥1…4 write the tab's section; follow it.
                .onChange(of: state.section) { _, section in
                    state.path = []
                    current = section
                    withAnimation(.snappy(duration: 0.35)) {
                        scroller.scrollTo(section, anchor: .top)
                    }
                }
            }
        }
    }

    private func index(jump: @escaping (SiteSection) -> Void) -> some View {
        VStack(alignment: .trailing, spacing: 10) {
            ForEach(SiteSection.allCases) { section in
                let isActive = current == section
                Button { jump(section) } label: {
                    HStack(spacing: 8) {
                        Text(section.label)
                            .font(.caption.weight(isActive ? .semibold : .regular))
                            .foregroundStyle(isActive ? .primary : .secondary)
                        Headband()
                            .fill(isActive ? Palette.acid : Palette.line)
                            .frame(width: 14, height: 4)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.line))
        .animation(.snappy(duration: 0.2), value: current)
    }
}

// MARK: - J: two pages side by side

/// Two panes, each with its own page switch, so the registry can sit beside the dashboard
/// or the planning beside the registry. Like an editor split.
struct PrototypeSplitPane: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    @State private var rightState: SiteTabState

    init(overview: SiteOverview, state: SiteTabState, history: HistoryStore, rankings: RankingStore, preferences: PlanningPreferences, live: LiveStore, icon: Image?, isRefreshing: Bool, onRefresh: @escaping () -> Void) {
        self.overview = overview
        self.state = state
        self.history = history
        self.rankings = rankings
        self.preferences = preferences
        self.live = live
        self.icon = icon
        self.isRefreshing = isRefreshing
        self.onRefresh = onRefresh
        let right = SiteTabState(siteID: overview.id)
        right.section = .registry
        _rightState = State(initialValue: right)
    }

    var body: some View {
        VStack(spacing: 0) {
            PrototypeSiteHeader(overview: overview, state: state, live: live, icon: icon, showsSections: false, refreshing: isRefreshing, onRefresh: onRefresh)
            Hairline()
            HSplitView {
                column(state)
                    .frame(minWidth: 360)
                column(rightState)
                    .frame(minWidth: 360)
            }
        }
    }

    private func column(_ pageState: SiteTabState) -> some View {
        @Bindable var pageState = pageState
        return VStack(spacing: 0) {
            HStack(spacing: 20) {
                WordSwitch(options: SiteSection.allCases, selection: $pageState.section, label: \.label)
                Spacer()
                if pageState.section == .dashboard {
                    WordSwitch(options: Period.allCases, selection: $pageState.period, label: \.label, font: .subheadline)
                }
            }
            .padding(.horizontal, SiteTabScreen.columnInset)
            .frame(height: 44)
            .background(Palette.raised)
            Hairline()
            HostedSite(overview: overview, state: pageState, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
        }
    }
}

// MARK: - M: dashboard stays, pages in a drawer

/// The dashboard is the site; the registry, planning and log are things you open beside it,
/// like an inspector. The drawer closes with its ✕ or by choosing its page again.
struct PrototypeDrawerPane: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    @State private var drawerState: SiteTabState
    @State private var open: SiteSection?

    @Environment(\.isTabPreview) private var isPreview

    init(overview: SiteOverview, state: SiteTabState, history: HistoryStore, rankings: RankingStore, preferences: PlanningPreferences, live: LiveStore, icon: Image?, isRefreshing: Bool, onRefresh: @escaping () -> Void) {
        self.overview = overview
        self.state = state
        self.history = history
        self.rankings = rankings
        self.preferences = preferences
        self.live = live
        self.icon = icon
        self.isRefreshing = isRefreshing
        self.onRefresh = onRefresh
        _drawerState = State(initialValue: SiteTabState(siteID: overview.id))
    }

    private static let drawerWidth: CGFloat = 600

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                Hairline()
                HostedSite(overview: overview, state: state, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
            }
            .frame(maxWidth: .infinity)

            if let open {
                Hairline(vertical: true)
                VStack(spacing: 0) {
                    HStack {
                        Label(open.label, systemImage: open.symbol)
                            .font(.title3.weight(.semibold))
                        Spacer()
                        Button("Close", systemImage: "xmark") { toggle(open) }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .keyboardShortcut(.cancelAction)
                    }
                    .padding(.horizontal, SiteTabScreen.columnInset)
                    .frame(height: 52)
                    Hairline()
                    HostedSite(overview: overview, state: drawerState, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
                }
                .frame(width: Self.drawerWidth)
                .background(Palette.raised)
                .transition(.move(edge: .trailing))
            }
        }
        .clipped()
        .animation(.snappy(duration: 0.3), value: open)
        // The dashboard always shows the dashboard; ⌘⌥2…4 open the drawer instead.
        .onChange(of: state.section, initial: true) { _, section in
            if section != .dashboard {
                state.path = []
                toggle(section)
            }
        }
    }

    private func toggle(_ section: SiteSection) {
        if open == section {
            open = nil
        } else {
            drawerState.section = section
            open = section
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            PrototypeSiteIdentity(overview: overview, live: live, icon: icon)
            Spacer()
            HStack(spacing: 24) {
                WordSwitch(options: Period.allCases, selection: $state.period, label: \.label)
                    .disabled(isPreview)
                HStack(spacing: 14) {
                    ForEach(SiteSection.allCases.filter { $0 != .dashboard }) { section in
                        let isActive = open == section
                        Button {
                            toggle(section)
                        } label: {
                            Label(section.label, systemImage: section.symbol)
                                .font(.callout.weight(isActive ? .semibold : .regular))
                                .foregroundStyle(isActive ? .primary : .secondary)
                                .padding(.horizontal, 8)
                                .frame(height: 26)
                                .background(.primary.opacity(isActive ? 0.1 : 0), in: .rect(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                    }
                }
                PrototypeRefreshButton(refreshing: isRefreshing, action: onRefresh)
            }
        }
        .padding(.horizontal, SiteTabScreen.columnInset)
        .frame(height: 56)
    }
}

// MARK: - N / O: icon rail for the pages

/// K's rail, kept to the pages: the sites stay in the title bar as pills, and the pane grows a
/// spine down its left edge with one icon per page. The header above the content names the
/// site. With `captions` each icon carries its word underneath, the way Finder's toolbar can.
struct PrototypePageRailPane<Content: View>: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let live: LiveStore
    let icon: Image?
    let captions: Bool
    let refreshing: Bool
    let onRefresh: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.isTabPreview) private var isPreview

    private var railWidth: CGFloat { captions ? 76 : 56 }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: captions ? 10 : 6) {
                ForEach(SiteSection.allCases) { section in
                    PageRailIcon(
                        section: section,
                        isActive: state.section == section,
                        caption: captions,
                        badge: count(for: section)
                    ) {
                        state.section = section
                    }
                    .disabled(isPreview)
                }
                Spacer()
            }
            .padding(.top, 14)
            .frame(width: railWidth)

            Hairline(vertical: true)

            VStack(spacing: 0) {
                PrototypeSiteHeader(overview: overview, state: state, live: live, icon: icon, showsSections: false, refreshing: refreshing, onRefresh: onRefresh)
                Hairline()
                content()
            }
        }
    }

    private func count(for section: SiteSection) -> Int? {
        switch section {
        case .registry: rankings.registry[overview.id]?.count
        case .planning: rankings.health[overview.id]?.keywords.count
        case .dashboard, .log: nil
        }
    }
}

private struct PageRailIcon: View {
    let section: SiteSection
    let isActive: Bool
    let caption: Bool
    let badge: Int?
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: section.symbol)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .frame(width: 40, height: caption ? 30 : 40)
                if caption {
                    Text(section.label)
                        .font(.caption2.weight(isActive ? .semibold : .regular))
                        .foregroundStyle(isActive ? .primary : .secondary)
                        .lineLimit(1)
                }
            }
            .frame(width: caption ? 64 : 40)
            .padding(.vertical, caption ? 6 : 0)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isActive ? Palette.raised : .primary.opacity(isHovering ? 0.06 : 0))
            )
            .overlay {
                if isActive { RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line) }
            }
            .overlay(alignment: .leading) {
                // The headband stands on the rail's edge beside the active icon.
                Headband()
                    .fill(Palette.acid)
                    .frame(width: 4, height: 14)
                    .offset(x: caption ? -6 : -8)
                    .opacity(isActive ? 1 : 0)
            }
            .overlay(alignment: .topTrailing) {
                if let badge, !caption {
                    Text(badge.formatted())
                        .font(.system(size: 9, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .frame(height: 14)
                        .background(Palette.panel, in: .capsule)
                        .overlay(Capsule().strokeBorder(Palette.line))
                        .offset(x: 4, y: -3)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(badge.map { "\(section.label) · \($0)" } ?? section.label)
        .animation(.snappy(duration: 0.2), value: isActive)
    }
}

// MARK: - P: dark rail beside the pane

/// K's rail on the window canvas, kept to the pages. Drawn by `RootView` in the strip it
/// takes off the pane's leading edge while a site tab is active; the overview has no rail.
struct PrototypeVoidPageRail: View {
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let siteID: Site.ID

    static let width: CGFloat = 60

    var body: some View {
        VStack(spacing: 8) {
            ForEach(SiteSection.allCases) { section in
                PageRailIcon(section: section, isActive: state.section == section, caption: false, badge: nil) {
                    state.section = section
                }
            }
            Spacer()
        }
        .padding(.top, 6)
        .frame(width: Self.width)
    }
}
