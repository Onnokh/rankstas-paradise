import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// Question: how should a site tab move between its pages (dashboard, registry, planning, log)?
// Today the dashboard pushes a sub-screen with a back button, like a NavigationStack. The
// header changes shape on the way (one-line header with controls → back chevron plus large
// title), and the pages are not peers: every move is push or pop.
//
// Three variants of the site tab's navigation, switchable from the floating bar at the bottom
// of the window (⌘⌥← / ⌘⌥→), on the existing site tab, with real data. The current shell is
// kept in the cycle as the baseline.
//
//   Current — push and back (as shipped)
//   A — pinned site header with a section word switch; the pages are peers below it
//   B — a sidebar rail inside the pane: identity on top, sections as rows, master–detail
//   C — sections hoisted into the title bar beside the tab pills, like a toolbar
//
// The sub-screens keep their own bodies. They read `siteSectionsHosted` from the environment
// and drop their back rows, large titles and push motion when an outer shell hosts them.

// MARK: - Sections

/// The pages a site tab has. The dashboard is the empty path; the others map to one pushed
/// `SiteScreen`, so the shipped screens and the tab's stored state are reused as they are.
enum SiteSection: String, CaseIterable, Identifiable {
    case dashboard, registry, planning, log

    var id: String { rawValue }

    var label: String {
        switch self {
        case .dashboard: "Dashboard"
        case .registry: "Registry"
        case .planning: "Planning"
        case .log: "Log"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "chart.xyaxis.line"
        case .registry: "list.bullet.rectangle"
        case .planning: "calendar"
        case .log: "clock"
        }
    }

    var screen: SiteScreen? {
        switch self {
        case .dashboard: nil
        case .registry: .registry
        case .planning: .planning
        case .log: .log
        }
    }

    init(screen: SiteScreen?) {
        switch screen {
        case .registry: self = .registry
        case .planning: self = .planning
        case .log: self = .log
        case .opportunities, nil: self = .dashboard
        }
    }
}

extension SiteTabState {
    /// The section as a flat choice over the stored path.
    var section: SiteSection {
        get { SiteSection(screen: path.last) }
        set { path = newValue.screen.map { [$0] } ?? [] }
    }
}

// MARK: - Variant

/// Which shell the site tab is drawn in. Held once, in the environment; remembered across
/// launches so a variant can be judged after a restart.
@MainActor
@Observable
final class NavigationPrototype {
    enum Variant: String, CaseIterable, Identifiable {
        case current, sectionBar, sidebar, titleBar
        case globalSidebar, pageFirst, columns, breadcrumb, bottomBar, stacked, split, rail, twoAxis, drawer
        case pageRail, pageRailCaptions, pageRailVoid

        var id: String { rawValue }

        var key: String {
            switch self {
            case .current: "Current"
            case .sectionBar: "A"
            case .sidebar: "B"
            case .titleBar: "C"
            case .globalSidebar: "D"
            case .pageFirst: "E"
            case .columns: "F"
            case .breadcrumb: "G"
            case .bottomBar: "H"
            case .stacked: "I"
            case .split: "J"
            case .rail: "K"
            case .twoAxis: "L"
            case .drawer: "M"
            case .pageRail: "N"
            case .pageRailCaptions: "O"
            case .pageRailVoid: "P"
            }
        }

        var name: String {
            switch self {
            case .current: "Push and back (as shipped)"
            case .sectionBar: "Pinned header with section switch"
            case .sidebar: "Sidebar rail in the pane"
            case .titleBar: "Sections in the title bar"
            case .globalSidebar: "One sidebar for everything, no tabs"
            case .pageFirst: "Pages are the tabs, site is the switch"
            case .columns: "Miller columns: sites › pages › content"
            case .breadcrumb: "Breadcrumb menus + ⌘K jump palette"
            case .bottomBar: "Page bar at the foot of the pane"
            case .stacked: "All pages stacked, index to jump"
            case .split: "Two pages side by side"
            case .rail: "Icon rail: sites above, pages below"
            case .twoAxis: "One header row: sites × pages"
            case .drawer: "Dashboard stays, pages open in a drawer"
            case .pageRail: "Icon rail for the pages, tabs as shipped"
            case .pageRailCaptions: "Icon rail with captions, tabs as shipped"
            case .pageRailVoid: "Dark rail beside the pane, pages only"
            }
        }

        /// The shells that replace the title-bar tabs and the peek, not just the site pane.
        var isWholeWindow: Bool {
            switch self {
            case .globalSidebar, .pageFirst, .columns, .breadcrumb, .rail, .twoAxis: true
            default: false
            }
        }
    }

    private static let defaultsKey = "prototype.siteNavigation.variant"

    var variant: Variant {
        didSet { UserDefaults.standard.set(variant.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        variant = stored.flatMap(Variant.init(rawValue:)) ?? .sectionBar
    }

    /// Opens a site tab on a page at launch, for screenshots without a hand on the keyboard:
    /// `defaults write com.rankstasparadise.mac prototype.startSite printfeest` and
    /// `... prototype.startSection registry`. Read once, then cleared.
    func openStartTab(in workspace: Workspace, siteIDs: [Site.ID]) {
        let defaults = UserDefaults.standard
        guard let siteID = defaults.string(forKey: "prototype.startSite"), siteIDs.contains(siteID) else { return }
        defaults.removeObject(forKey: "prototype.startSite")
        workspace.activate(.site(siteID))
        if let raw = defaults.string(forKey: "prototype.startSection"), let section = SiteSection(rawValue: raw) {
            workspace.state(for: siteID).section = section
        }
    }

    func cycle(_ step: Int) {
        let all = Variant.allCases
        let index = all.firstIndex(of: variant) ?? 0
        let count = all.count
        variant = all[((index + step) % count + count) % count]
    }
}

/// True when an outer shell draws the site's header and section controls. Screens then drop
/// their own back rows, large titles and push motion.
private struct SiteSectionsHostedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var siteSectionsHosted: Bool {
        get { self[SiteSectionsHostedKey.self] }
        set { self[SiteSectionsHostedKey.self] = newValue }
    }
}

// MARK: - Host

/// Draws one site tab in the chosen variant. Same inputs as `SiteTabScreen`; without a
/// prototype in the environment it is exactly `SiteTabScreen`.
struct SiteNavigationHost: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let icon: Image?
    let isRefreshing: Bool
    let onRefresh: () -> Void

    @Environment(NavigationPrototype.self) private var prototype: NavigationPrototype?
    @Environment(\.isTabPreview) private var isPreview

    private var screen: SiteTabScreen {
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
    }

    private var refreshing: Bool {
        isRefreshing || history.refreshing.contains(overview.id) || rankings.loading.contains(overview.id)
    }

    var body: some View {
        shell
            .background {
                // ⌘⌥1…⌘⌥4 jump straight to a page, in every variant but the shipped one.
                if !isPreview, let prototype, prototype.variant != .current {
                    ForEach(Array(SiteSection.allCases.enumerated()), id: \.element) { index, section in
                        Button(section.label) { state.section = section }
                            .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .option])
                    }
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
                }
            }
    }

    @ViewBuilder
    private var shell: some View {
        switch prototype?.variant ?? .current {
        case .current:
            screen
        case .sectionBar:
            VStack(spacing: 0) {
                PrototypeSiteHeader(
                    overview: overview,
                    state: state,
                    live: live,
                    icon: icon,
                    showsSections: true,
                    refreshing: refreshing,
                    onRefresh: onRefresh
                )
                hairline
                hosted
            }
        case .sidebar:
            HStack(spacing: 0) {
                PrototypeSectionRail(overview: overview, state: state, rankings: rankings, live: live, icon: icon)
                Rectangle().fill(Palette.line).frame(width: 1)
                VStack(spacing: 0) {
                    HStack(spacing: 20) {
                        Text(state.section.label)
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
                    hairline
                    hosted
                }
            }
        case .titleBar, .pageFirst, .rail, .pageRailVoid:
            VStack(spacing: 0) {
                PrototypeSiteHeader(
                    overview: overview,
                    state: state,
                    live: live,
                    icon: icon,
                    showsSections: false,
                    refreshing: refreshing,
                    onRefresh: onRefresh
                )
                hairline
                hosted
            }
        case .globalSidebar, .columns, .breadcrumb:
            // The shell names the site; the pane names the page.
            VStack(spacing: 0) {
                PrototypeSlimHeader(title: state.section.label, state: state, refreshing: refreshing, onRefresh: onRefresh)
                hairline
                hosted
            }
        case .twoAxis:
            hosted
        case .bottomBar:
            PrototypeBottomBarPane(overview: overview, state: state, rankings: rankings, live: live, icon: icon, refreshing: refreshing, onRefresh: onRefresh) { hosted }
        case .stacked:
            PrototypeStackedPane(overview: overview, state: state, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
        case .split:
            PrototypeSplitPane(overview: overview, state: state, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
        case .pageRail, .pageRailCaptions:
            PrototypePageRailPane(overview: overview, state: state, rankings: rankings, live: live, icon: icon, captions: prototype?.variant == .pageRailCaptions, refreshing: refreshing, onRefresh: onRefresh) { hosted }
        case .drawer:
            PrototypeDrawerPane(overview: overview, state: state, history: history, rankings: rankings, preferences: preferences, live: live, icon: icon, isRefreshing: isRefreshing, onRefresh: onRefresh)
        }
    }

    /// The shipped screen, told an outer shell owns its header.
    private var hosted: some View {
        screen
            .environment(\.siteSectionsHosted, true)
            // A section swap is a pane swap, like a tab: nothing slides.
            .id(state.section)
    }

    private var hairline: some View {
        Rectangle().fill(Palette.line).frame(height: 1)
    }
}

// MARK: - Variant A / C header

/// One pinned row: the site's identity, then the controls. With `showsSections` the pages
/// sit here as a word switch (variant A); without it they are the title bar's (variant C).
struct PrototypeSiteHeader: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let live: LiveStore
    let icon: Image?
    let showsSections: Bool
    let refreshing: Bool
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    var body: some View {
        HStack(spacing: 10) {
            PrototypeSiteIdentity(overview: overview, live: live, icon: icon)
            Spacer()
            HStack(spacing: 24) {
                // The period only means something on the dashboard; the other pages have
                // their own windows. It leaves rather than lying.
                if state.section == .dashboard {
                    WordSwitch(options: Period.allCases, selection: $state.period, label: \.label)
                        .disabled(isPreview)
                }
                if showsSections {
                    WordSwitch(options: SiteSection.allCases, selection: $state.section, label: \.label)
                        .disabled(isPreview)
                }
                PrototypeRefreshButton(refreshing: refreshing, action: onRefresh)
            }
            .animation(.snappy(duration: 0.2), value: state.section)
        }
        .column()
        .frame(height: 56)
    }
}

/// The favicon, the name, the origin and the people online: the identity every variant keeps.
struct PrototypeSiteIdentity: View {
    let overview: SiteOverview
    let live: LiveStore
    let icon: Image?

    private var online: LiveVisitors? { live.reports[overview.id]?.live }

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let icon {
                    icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 4))
                } else {
                    Image(systemName: "globe").font(.title3).foregroundStyle(.secondary)
                }
            }
            .frame(width: 20, height: 20)

            Text(overview.site.name)
                .font(.title3.weight(.semibold))

            Text(overview.site.origin)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            if let online {
                HStack(spacing: 6) {
                    Circle().fill(Palette.lilac).frame(width: 7, height: 7)
                    Text("\(online.onlineNow.formatted(.number.precision(.fractionLength(0)))) online")
                        .monospacedDigit()
                }
                .foregroundStyle(.secondary)
                .padding(.leading, 6)
            }
        }
    }
}

struct PrototypeRefreshButton: View {
    let refreshing: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            if refreshing {
                ProgressView().controlSize(.small)
            }
            Button("Refresh", systemImage: "arrow.clockwise", action: action)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(refreshing)
                .help("Refresh (⌘R)")
        }
    }
}

// MARK: - Variant B rail

/// A source list inside the pane: the site on top, one row per page with what it holds, the
/// active row marked by the headband the tab pills use.
struct PrototypeSectionRail: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let live: LiveStore
    let icon: Image?

    static let width: CGFloat = 220

    private var online: LiveVisitors? { live.reports[overview.id]?.live }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            identity
                .padding(.horizontal, 16)
                .padding(.top, 22)
                .padding(.bottom, 24)

            VStack(spacing: 2) {
                ForEach(SiteSection.allCases) { section in
                    PrototypeRailRow(
                        section: section,
                        count: count(for: section),
                        isActive: state.section == section
                    ) {
                        state.section = section
                    }
                }
            }
            .padding(.horizontal, 8)

            Spacer()
        }
        .frame(width: Self.width)
        .background(Palette.panel)
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Group {
                    if let icon {
                        icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: 5))
                    } else {
                        Image(systemName: "globe").font(.title3).foregroundStyle(.secondary)
                    }
                }
                .frame(width: 22, height: 22)
                Text(overview.site.name)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
            }
            Text(overview.site.origin)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let online {
                HStack(spacing: 6) {
                    Circle().fill(Palette.lilac).frame(width: 7, height: 7)
                    Text("\(online.onlineNow.formatted(.number.precision(.fractionLength(0)))) online")
                        .monospacedDigit()
                }
                .font(.callout)
                .foregroundStyle(.secondary)
            }
        }
    }

    /// What the page holds, so the rail says something before it is opened.
    private func count(for section: SiteSection) -> Int? {
        switch section {
        case .registry: rankings.registry[overview.id]?.count
        case .planning: rankings.health[overview.id]?.keywords.count
        case .dashboard, .log: nil
        }
    }
}

struct PrototypeRailRow: View {
    let section: SiteSection
    let count: Int?
    let isActive: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: section.symbol)
                    .font(.callout)
                    .frame(width: 18)
                    .foregroundStyle(isActive ? .primary : .secondary)
                Text(section.label)
                    .font(.callout.weight(isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? .primary : .secondary)
                Spacer(minLength: 0)
                if let count {
                    Text(count.formatted())
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                HeadbandMarker(isActive: isActive)
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(.primary.opacity(isActive ? 0.08 : isHovering ? 0.04 : 0))
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(.snappy(duration: 0.2), value: isActive)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

// MARK: - Variant C title bar

/// The active site's pages as a word switch at the trailing end of the title bar, beside the
/// tab pills. Drawn by `RootView`; hidden while the peek is open, like the pills' row.
struct PrototypeTitleBarSections: View {
    @Bindable var state: SiteTabState

    var body: some View {
        WordSwitch(options: SiteSection.allCases, selection: $state.section, label: \.label)
    }
}

// MARK: - Switcher

/// The floating bar that flips variants. Obviously not part of the design being judged.
struct PrototypeSwitcher: View {
    let prototype: NavigationPrototype

    var body: some View {
        HStack(spacing: 12) {
            Text("PROTOTYPE")
                .font(.caption2.weight(.heavy))
                .tracking(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.black, in: .rect(cornerRadius: 3))
                .foregroundStyle(.yellow)

            Button { prototype.cycle(-1) } label: {
                Image(systemName: "chevron.left")
            }
            .keyboardShortcut(.leftArrow, modifiers: [.command, .option])

            Text("\(prototype.variant.key) — \(prototype.variant.name)")
                .font(.callout.weight(.semibold))
                .frame(minWidth: 260)

            Button { prototype.cycle(1) } label: {
                Image(systemName: "chevron.right")
            }
            .keyboardShortcut(.rightArrow, modifiers: [.command, .option])

            Text("⌘⌥← ⌘⌥→")
                .font(.caption)
                .opacity(0.6)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.black)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(.yellow, in: .capsule)
        .overlay(Capsule().strokeBorder(.black.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        .animation(.snappy(duration: 0.2), value: prototype.variant)
    }
}
