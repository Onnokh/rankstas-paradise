import SwiftUI

/// The mounted tab screens. The active one sits in place; the others wait below the bottom
/// edge, parked without animation. Swapping the active tab is instant. Any motion the user
/// sees comes from the container: the peek offset retracting, or the whole pane travelling
/// back up after the grid pushed it out.
///
/// The pane is exactly the size it is given. A screen that wants more width than the pane
/// has — a mounted one behind the active one counts too — is centred in it and cut at its
/// edges, never allowed to widen the pane: a wider pane would sit over the rail on one side
/// and under the window's edge on the other.
struct TabContentStack: View {
    let workspace: Workspace
    let model: OverviewModel
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let log: LogStore
    let favicons: FaviconStore
    let actions: TabActions
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        ZStack(alignment: .top) {
            ForEach(workspace.mountedTabIDs, id: \.self) { tab in
                let isActive = tab == workspace.activeTabID

                TabScreen(tab: tab, workspace: workspace, model: model, history: history, rankings: rankings, preferences: preferences, live: live, log: log, favicons: favicons, actions: actions)
                    .frame(width: width, height: height, alignment: .top)
                    .background(Palette.panel)
                    .allowsHitTesting(isActive)
                    .accessibilityHidden(!isActive)
                    .geometryGroup()
                    .offset(y: isActive ? 0 : height)
                    // The swap itself never animates; only the container moves.
                    .animation(nil, value: isActive)
                    .zIndex(isActive ? 1 : 0)
                    .transition(.identity)
            }
        }
        .frame(width: width, height: height)
        .clipShape(.rect(cornerRadius: PeekLayout.contentCornerRadius))
    }
}
