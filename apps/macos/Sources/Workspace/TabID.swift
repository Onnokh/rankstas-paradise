import Foundation
import Observation

/// Identifies one tab: the overview or a site.
enum TabID: Hashable, Sendable {
    case overview
    case site(Site.ID)
}

/// A sub-screen inside a site tab.
enum SiteScreen: Hashable, Sendable {
    case opportunities
    case registry
    case log
}

/// Per-site UI state that outlives the tab's view.
///
/// Tab state holds navigation and selections, never data. Data stays in the repository and
/// is shared by every tab, so a tab costs a few bytes whether or not its view is mounted.
@MainActor
@Observable
final class SiteTabState {
    let siteID: Site.ID
    var path: [SiteScreen] = []
    /// The span the metric cards and chart cover.
    var period: Period = .d28

    init(siteID: Site.ID) {
        self.siteID = siteID
    }
}

/// UI state of the overview tab.
@MainActor
@Observable
final class OverviewTabState {
    var selectedSiteID: Site.ID?
}
