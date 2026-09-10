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
struct TabContentStack: View, Equatable {


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

    /// Equal by what a pane is drawn from, ignoring `actions`, whose closures cannot be
    /// compared and only ever act on the tab they were made for. The stores are compared by
    /// identity: the screens observe them directly, so a finished load still invalidates the
    /// rows that read it without passing through here. This is the same bargain `ScreenSlot`
    /// makes, for the same reason — see `RootView`, whose body re-runs on every frame of the
    /// peek because it reads `peekProgress`. Without this, one peek frame re-evaluated every
    /// mounted tab's screen.
    nonisolated static func == (lhs: TabContentStack, rhs: TabContentStack) -> Bool {
        lhs.workspace === rhs.workspace
            && lhs.model === rhs.model
            && lhs.history === rhs.history
            && lhs.rankings === rhs.rankings
            && lhs.preferences === rhs.preferences
            && lhs.live === rhs.live
            && lhs.log === rhs.log
            && lhs.favicons === rhs.favicons
            && lhs.width == rhs.width
            && lhs.height == rhs.height
    }

    /// The mounted tabs in tab-bar order, not in the order they were last used.
    ///
    /// `Workspace.mountedTabIDs` is ordered by recency, so activating a tab reordered this
    /// ForEach and moved nine hosted screens in the layer tree on the one frame that has to
    /// be cheap: the frame a tab is chosen. Which tabs are mounted is the same set either
    /// way, and the active one is raised by `zIndex`, so nothing about the result changes.
    private var mountedTabs: [TabID] {
        let mounted = Set(workspace.mountedTabIDs)
        return workspace.tabs.filter(mounted.contains)
    }

    var body: some View {
        ZStack(alignment: .top) {
            ForEach(mountedTabs, id: \.self) { tab in
                let isActive = tab == workspace.activeTabID

                TabScreen(tab: tab, workspace: workspace, model: model, history: history, rankings: rankings, preferences: preferences, live: live, log: log, favicons: favicons, actions: actions)
                    .equatable()
                    .frame(width: width, height: height, alignment: .top)
                    .background(Palette.panel)
                    // A tab behind the active one is laid out but never drawn. It used to be
                    // drawn and then translated off the pane, so every switch paid to
                    // rasterise eight screens nobody can see: clicking a card in the grid
                    // measured 28.9 ms of layout, drawing and accessibility against 19.
                    // The `.animation(nil, value:)` below keeps this from fading, and a tab
                    // switched to draws in full — checked by photographing one.
                    .opacity(isActive ? 1 : 0)
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
