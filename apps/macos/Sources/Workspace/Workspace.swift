import Foundation
import Observation

/// Owns the tabs, which one is active, which few keep a live view, and the peek progress.
///
/// Every known site has a tab and a state object at all times. Only the `mountedLimit` most
/// recently activated tabs keep a view in the hierarchy; the others are rebuilt from their
/// state when activated again, so memory stays flat as sites are added. The view mounts
/// every tab it can in the idle moments after launch (see `mount`), so the first visit to a
/// tab is a swap and not a build.
///
/// The limit has to cover the tab bar, because a rebuild is not free. Building a site tab
/// costs about 31 ms of update and layout in a Release build, against 6 ms to bring a
/// mounted one to the front. A limit under the number of tabs turns ⌘← and ⌘→ into a walk
/// that rebuilds nearly every step: with a fourth site the bar holds five tabs, three were
/// mounted, and stepping along it stopped being instant. See `mountedLimit`.
@MainActor
@Observable
final class Workspace {
    let overviewState = OverviewTabState()
    /// How many tabs keep a view. Nine, the range ⌘1…⌘9 addresses: a tab the reader can
    /// reach in one keystroke is a tab that has to swap instantly, and above the bar's own
    /// count nothing is ever evicted. It stays a bound rather than "every tab" because a
    /// mounted site tab holds its four screens — about 35 MB measured — so a server with
    /// dozens of sites still stops growing here.
    let mountedLimit: Int

    private(set) var tabs: [TabID] = [.overview]
    private(set) var siteStates: [Site.ID: SiteTabState] = [:]
    private(set) var activeTabID: TabID = .overview

    /// Most recently activated first.
    private(set) var recency: [TabID] = [.overview]

    /// See `PeekProgress`. The gesture writes it directly; the view animates it when settling.
    var peekProgress: Double = PeekProgress.closed {
        didSet { peekMovedAt = .now }
    }

    /// When the peek was last moved. Not observed: it is read by work waiting for the pane
    /// to stand still, never by a view.
    @ObservationIgnored private var peekMovedAt = ContinuousClock.now

    /// How long after its last move the peek is taken to have landed. Its animations are
    /// springs of 0.4-0.55 s (see `RootView`), and a spring's tail runs a little past that.
    static let peekSettleTime: Duration = .milliseconds(750)

    init(mountedLimit: Int = 9) {
        precondition(mountedLimit >= 1, "At least the active tab must be mounted.")
        self.mountedLimit = mountedLimit
    }

    var isPeeking: Bool {
        peekProgress > 0.001
    }

    /// True once the peek is closed and its closing animation has had time to land.
    ///
    /// `peekProgress` is the value the view animates towards, so it reads closed the moment
    /// a close begins, while the pane is still travelling for another half second. Work
    /// that must not land in a moving frame — a still being drawn, a tab warming its
    /// screens — asks this instead, and asks again a beat later when the answer is no.
    func isPeekAtRest(at now: ContinuousClock.Instant = .now) -> Bool {
        !isPeeking && peekMovedAt.duration(to: now) > Self.peekSettleTime
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

    /// Gives a tab a view without bringing it to the front: it joins the mounted set behind
    /// every tab used so far, so nothing the reader has been to is evicted for it. Nothing
    /// changes if the tab is mounted already, or if the mounted set is full.
    ///
    /// This is what makes the first visit to a project a swap. A tab built on the click
    /// cost 60-100 ms on the frame of the click and two more late frames as its charts and
    /// lists filled in; brought to the front already mounted, the same click costs 25-45 ms.
    func mount(_ tab: TabID) {
        guard tabs.contains(tab), !recency.contains(tab) else { return }
        recency.append(tab)
    }

    func activateTab(at index: Int) {
        guard tabs.indices.contains(index) else { return }
        activate(tabs[index])
    }

    /// The tab `step` places along from the active one, wrapping at both ends: ⌘→ is +1,
    /// ⌘← is −1. Nil when there is no tab to move to.
    func neighbourTab(_ step: Int) -> TabID? {
        guard !tabs.isEmpty, let index = tabs.firstIndex(of: activeTabID) else { return tabs.first }
        let count = tabs.count
        return tabs[((index + step) % count + count) % count]
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
