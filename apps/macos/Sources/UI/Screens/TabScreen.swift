import SwiftUI

/// True inside a scaled, non-interactive copy of a tab's screen (peek previews).
/// Screens use it to drop keyboard shortcuts so the live screen keeps sole ownership.
private struct IsTabPreviewKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var isTabPreview: Bool {
        get { self[IsTabPreviewKey.self] }
        set { self[IsTabPreviewKey.self] = newValue }
    }
}

/// True for the screen a site tab has in front. The tab keeps its other screens mounted
/// behind it, so a screen that fetches for itself waits for this before it asks.
private struct IsScreenShownKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var isScreenShown: Bool {
        get { self[IsScreenShownKey.self] }
        set { self[IsScreenShownKey.self] = newValue }
    }
}

/// A screen's reading column: it scrolls on screen, and does not in a preview or a still.
///
/// `ImageRenderer` draws nothing inside a ScrollView, so a still of a scrolling screen came
/// out as the header and then blank. A preview cannot be scrolled anyway.
struct ReadingColumn: ViewModifier {
    @Environment(\.isTabPreview) private var isPreview

    func body(content: Content) -> some View {
        if isPreview {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .clipped()
        } else {
            ScrollView { content }
        }
    }
}

extension View {
    func readingColumn() -> some View {
        modifier(ReadingColumn())
    }
}

/// What a screen can ask the workspace to do. Previews get no-ops.
struct TabActions {
    var activate: (TabID) -> Void
    /// Fetches everything the tab shows again. The screen's own button and View > Refresh
    /// (⌘R) both land here.
    var refresh: (TabID) -> Void

    @MainActor static let none = TabActions(activate: { _ in }, refresh: { _ in })
}

/// Renders one tab's current screen from its state.
///
/// The same view backs the mounted screen and the peek previews. A site's preview always
/// shows its dashboard: a card is for picking a site, and following the live screen made
/// every rail click build the chosen screen a second time inside a card nobody had open.
struct TabScreen: View, Equatable {
    let tab: TabID
    let workspace: Workspace
    let model: OverviewModel
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let log: LogStore
    let favicons: FaviconStore
    let actions: TabActions

    /// Equal by what the screen is drawn from, ignoring `actions`, whose closures cannot be
    /// compared and only ever act on the tab they were made for. The stores are compared by
    /// identity: the screens observe them directly, so a finished load still invalidates the
    /// rows that read it without passing through here. The same bargain `TabContentStack`
    /// and `ScreenSlot` make — without it, `TabContentStack`'s body re-running for a click
    /// re-evaluated all nine mounted screens, because each got a fresh `actions`.
    nonisolated static func == (lhs: TabScreen, rhs: TabScreen) -> Bool {
        lhs.tab == rhs.tab
            && lhs.workspace === rhs.workspace
            && lhs.model === rhs.model
            && lhs.history === rhs.history
            && lhs.rankings === rhs.rankings
            && lhs.preferences === rhs.preferences
            && lhs.live === rhs.live
            && lhs.log === rhs.log
            && lhs.favicons === rhs.favicons
    }

    @ViewBuilder
    var body: some View {
        switch tab {
        case .overview:
            OverviewScreen(
                model: model,
                state: workspace.overviewState,
                live: live,
                favicons: favicons,
                onOpenSite: { actions.activate(.site($0)) },
                onRefresh: { actions.refresh(.overview) }
            )
        case .site(let siteID):
            if let overview = model.overviews.first(where: { $0.id == siteID }) {
                SiteTabScreen(
                    overview: overview,
                    state: workspace.state(for: siteID),
                    history: history,
                    rankings: rankings,
                    preferences: preferences,
                    live: live,
                    log: log,
                    icon: favicons.image(for: siteID),
                    isRefreshing: model.isRefreshing,
                    onRefresh: { actions.refresh(tab) },
                    paneIsAtRest: { workspace.isPeekAtRest() }
                )
            } else {
                ContentUnavailableView(
                    "Site not available",
                    systemImage: "globe.badge.chevron.backward",
                    description: Text("The server no longer lists this site.")
                )
            }
        }
    }
}

extension TabID {
    @MainActor
    func title(in model: OverviewModel) -> String {
        switch self {
        case .overview:
            "Overview"
        case .site(let siteID):
            model.sites.first { $0.id == siteID }?.name ?? siteID
        }
    }
}
