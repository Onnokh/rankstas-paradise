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
    /// The Registry sub-screen: how its list is ranked, what it is narrowed to, and which
    /// page is open. Selections like the period above, so they survive a tab switch.
    var registrySort: RegistrySort = .impressions
    var registryUnindexedOnly = false
    var registrySearch = ""
    var registryOpenPath: String?

    init(siteID: Site.ID) {
        self.siteID = siteID
    }
}

/// UI state of the overview tab.
@MainActor
@Observable
final class OverviewTabState {
    var selectedSiteID: Site.ID?
    /// The feed's filters: one site or all, and which kinds. Selections, so they survive a
    /// tab switch like the site above.
    var feedSiteID: Site.ID?
    var feedKinds: FeedKinds = .all
}

/// Which kinds the feed shows: a single choice, like the site page's period.
enum FeedKinds: String, CaseIterable, Identifiable, Sendable {
    case all
    case pageviews
    case events

    var id: Self { self }

    var label: String {
        switch self {
        case .all: "All"
        case .pageviews: "Pageviews"
        case .events: "Events"
        }
    }

    /// The kinds this choice hides. Events are everything that is not a page load.
    var hidden: Set<LiveEvent.Kind> {
        switch self {
        case .all: []
        case .pageviews: Set(LiveEvent.Kind.allCases).subtracting([.pageview])
        case .events: [.pageview]
        }
    }
}
