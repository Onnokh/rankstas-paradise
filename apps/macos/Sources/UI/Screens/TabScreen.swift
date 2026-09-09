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
struct TabScreen: View {
    let tab: TabID
    let workspace: Workspace
    let model: OverviewModel
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let favicons: FaviconStore
    let actions: TabActions

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
                    icon: favicons.image(for: siteID),
                    isRefreshing: model.isRefreshing,
                    onRefresh: { actions.refresh(tab) }
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
