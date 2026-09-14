import Foundation
import Observation

/// Identifies what the pane shows: the overview, the realtime, or a site's tab.
///
/// Only the sites are tabs. The overview and the realtime are the two screens every server
/// has, reached from the rail beside the pane and never from the tab bar. The overview is
/// the sites compared over a stored period; the realtime is the sites watched — who is on
/// them now, what today has brought, what visitors are doing.
enum TabID: Hashable, Sendable {
    case overview
    case realtime
    case site(Site.ID)
}

/// One of the screens a site tab shows. Peers, not a stack: the rail beside the pane swaps
/// between them, and the dashboard is one of them rather than the way to the others.
enum SiteScreen: String, CaseIterable, Identifiable, Hashable, Sendable {
    case dashboard
    case registry
    case planning
    case log

    var id: String { rawValue }

    var title: String {
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
}

/// Per-site UI state that outlives the tab's view.
///
/// Tab state holds navigation and selections, never data. Data stays in the repository and
/// is shared by every tab, so a tab costs a few bytes whether or not its view is mounted.
@MainActor
@Observable
final class SiteTabState {
    let siteID: Site.ID
    /// The screen the tab is on. Survives a tab switch and an eviction, like every selection.
    var screen: SiteScreen = .dashboard
    /// The span the metric cards and chart cover.
    var period: Period = .d28
    /// The Registry sub-screen: how its list is ranked, what it is narrowed to, and which
    /// page is open. Selections like the period above, so they survive a tab switch.
    var registrySort: RegistrySort = .impressions
    var registryUnindexedOnly = false
    var registrySearch = ""
    var registryOpenPath: String?
    /// The Planning sub-screen: what its list is narrowed to. The difficulty the reader
    /// counts as within reach is NOT here — unlike a search box or a sort, it is a
    /// judgement about the site rather than about where you are, so it outlives the tab
    /// and the launch. See `PlanningPreferences`.
    var planningSearch = ""
    var planningVerdicts: Set<KeywordVerdict> = []
    /// The Log sub-screen: what its timeline is narrowed to. Selections like the ones above,
    /// so they survive a tab switch. No open entry to remember — a Log row shows everything
    /// it holds where it stands.
    var logSearch = ""
    var logKinds: Set<LogKind> = []

    init(siteID: Site.ID) {
        self.siteID = siteID
    }
}

/// UI state of the overview tab.
@MainActor
@Observable
final class OverviewTabState {
    /// The span every site's figures cover, and the span before it they are set against.
    var period: Period = .d28

    /// Which source the page's chart draws, and the projects under it report. Chosen from the
    /// strip, and kept while the tab lives, the way the period is.
    var source: OverviewSource = .clicks

    /// The periods the overview offers: every stored one. Today is left out — it is read
    /// live from the provider and has no stored days to compare, so it belongs to the
    /// Realtime tab, where the sites are watched rather than compared.
    static let periods: [Period] = Period.allCases.filter { $0 != .today }
}

/// UI state of the realtime tab.
@MainActor
@Observable
final class RealtimeTabState {
    /// The sites the page is kept to — its numbers, its Sites card and its feed. Empty keeps
    /// every one. A selection, so it survives a tab switch like the site above.
    var siteFilter: Set<Site.ID> = []
    /// Which kinds the feed shows.
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
