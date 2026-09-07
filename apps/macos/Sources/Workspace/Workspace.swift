import Foundation
import Observation

/// Owns the tabs, which one is active, which few keep a live view, and the peek progress.
///
/// Every known site has a tab and a state object at all times. Only the `mountedLimit` most
/// recently activated tabs keep a view in the hierarchy; the others are rebuilt from their
/// state when activated again, so memory stays flat as sites are added.
@MainActor
@Observable
final class Workspace {
    let overviewState = OverviewTabState()
    let mountedLimit: Int

    private(set) var tabs: [TabID] = [.overview]
    private(set) var siteStates: [Site.ID: SiteTabState] = [:]
    private(set) var activeTabID: TabID = .overview

    /// Most recently activated first.
    private(set) var recency: [TabID] = [.overview]

    /// See `PeekProgress`. The gesture writes it directly; the view animates it when settling.
    var peekProgress: Double = PeekProgress.closed

    init(mountedLimit: Int = 3) {
        precondition(mountedLimit >= 1, "At least the active tab must be mounted.")
        self.mountedLimit = mountedLimit
    }

    var isPeeking: Bool {
        peekProgress > 0.001
    }

    /// The tabs that keep a live view. The active tab is always first.
    var mountedTabIDs: [TabID] {
        Array(recency.prefix(mountedLimit))
    }

    /// The state for a site. Sites unknown to `reconcile` get a detached, default state.
    func state(for siteID: Site.ID) -> SiteTabState {
        siteStates[siteID] ?? SiteTabState(siteID: siteID)
    }

    func activate(_ tab: TabID) {
        recency.removeAll { $0 == tab }
        recency.insert(tab, at: 0)
        activeTabID = tab
    }

    func activateTab(at index: Int) {
        guard tabs.indices.contains(index) else { return }
        activate(tabs[index])
    }

    /// Rebuilds the tab list from the server's sites, keeping state for sites that remain.
    func reconcile(siteIDs: [Site.ID]) {
        tabs = [.overview] + siteIDs.map(TabID.site)
        let known = Set(siteIDs)
        for siteID in siteIDs where siteStates[siteID] == nil {
            siteStates[siteID] = SiteTabState(siteID: siteID)
        }
        siteStates = siteStates.filter { known.contains($0.key) }
        recency.removeAll { tab in
            if case .site(let siteID) = tab { return !known.contains(siteID) }
            return false
        }
        if case .site(let siteID) = activeTabID, !known.contains(siteID) {
            activate(.overview)
        }
    }
}
