import XCTest
@testable import RankstasParadise

@MainActor
final class WorkspaceTests: XCTestCase {
    func testReconcileBuildsTabsWithOverviewFirst() {
        let workspace = Workspace()
        workspace.reconcile(siteIDs: ["a", "b"])
        XCTAssertEqual(workspace.tabs, [.overview, .site("a"), .site("b")])
    }

    func testNeighbourTabStepsAlongTheBarAndWraps() {
        let workspace = Workspace()
        workspace.reconcile(siteIDs: ["a", "b"])

        XCTAssertEqual(workspace.neighbourTab(1), .site("a"))
        XCTAssertEqual(workspace.neighbourTab(-1), .site("b"), "Left from the first tab wraps to the last.")

        workspace.activate(.site("b"))
        XCTAssertEqual(workspace.neighbourTab(1), .overview, "Right from the last tab wraps to the first.")
        XCTAssertEqual(workspace.neighbourTab(-1), .site("a"))
    }

    func testActiveTabIsMountedFirstAndMountedSetIsBounded() {
        let workspace = Workspace(mountedLimit: 2)
        workspace.reconcile(siteIDs: ["a", "b", "c"])

        workspace.activate(.site("a"))
        workspace.activate(.site("b"))
        workspace.activate(.site("c"))

        XCTAssertEqual(workspace.activeTabID, .site("c"))
        XCTAssertEqual(workspace.mountedTabIDs, [.site("c"), .site("b")])
        XCTAssertEqual(workspace.siteStates.count, 3, "Every known site keeps a state object.")
    }

    /// The property that makes ⌘← and ⌘→ instant: once the bar has been walked, every tab
    /// it holds still keeps a view, so each further step is a visibility flip and not a
    /// build. Four sites, because that is what the account has and what took the bar past
    /// the old limit of three. Checked by neutering: at that limit this fails on the first
    /// step of the second walk, which is where the hang was.
    func testSteppingAlongTheWholeBarStopsRebuildingOnceEachTabHasBeenSeen() {
        let workspace = Workspace()
        workspace.reconcile(siteIDs: ["a", "b", "c", "d"])
        XCTAssertEqual(workspace.tabs.count, 5)

        // The first walk builds each tab once. It is every walk after it that has to be free.
        for _ in workspace.tabs.indices {
            workspace.activate(workspace.neighbourTab(1)!)
        }

        for _ in workspace.tabs.indices {
            let next = workspace.neighbourTab(1)!
            XCTAssertTrue(
                workspace.mountedTabIDs.contains(next),
                "Stepping to \(next) rebuilds it: the bar holds \(workspace.tabs.count) tabs and only \(workspace.mountedLimit) keep a view."
            )
            workspace.activate(next)
        }
    }

    /// The peek reads closed the moment a close begins, because the view animates towards
    /// the value the model already holds. Work that must not land in a moving frame waits
    /// for the pane to have landed, not for the value to read closed.
    func testPeekIsNotAtRestUntilItsCloseHasHadTimeToLand() {
        let workspace = Workspace()
        let start = ContinuousClock.now
        workspace.peekProgress = PeekProgress.grid
        XCTAssertFalse(workspace.isPeekAtRest(at: start + .seconds(5)), "An open peek is never at rest.")

        workspace.peekProgress = PeekProgress.closed
        let closed = ContinuousClock.now
        XCTAssertFalse(workspace.isPeekAtRest(at: closed), "The close has only just begun.")
        XCTAssertFalse(
            workspace.isPeekAtRest(at: closed + .milliseconds(400)),
            "The settle animation is 0.4 s and its spring tail runs past that."
        )
        XCTAssertTrue(workspace.isPeekAtRest(at: closed + Workspace.peekSettleTime + .milliseconds(1)))
    }

    /// Mounting at idle gives a tab a view behind the ones the reader has used, so its first
    /// visit is a swap. It never brings the tab to the front, and it never pushes out a tab
    /// the reader has been to.
    func testMountGivesATabAViewBehindTheOnesInUse() {
        let workspace = Workspace(mountedLimit: 3)
        workspace.reconcile(siteIDs: ["a", "b", "c"])
        workspace.activate(.site("a"))

        workspace.mount(.site("b"))
        workspace.mount(.site("b"))
        XCTAssertEqual(workspace.activeTabID, .site("a"), "Mounting does not change what is in front.")
        XCTAssertEqual(workspace.mountedTabIDs, [.site("a"), .overview, .site("b")], "Once, and behind the tabs in use.")

        workspace.mount(.site("c"))
        XCTAssertEqual(workspace.mountedTabIDs, [.site("a"), .overview, .site("b")], "A full set evicts nothing for an idle mount.")

        workspace.mount(.site("zzz"))
        XCTAssertFalse(workspace.recency.contains(.site("zzz")), "Only a known tab gets a view.")
    }

    func testEvictedTabKeepsItsNavigationState() {
        let workspace = Workspace(mountedLimit: 1)
        workspace.reconcile(siteIDs: ["a", "b"])

        workspace.activate(.site("a"))
        workspace.state(for: "a").screen = .registry
        workspace.activate(.site("b"))

        XCTAssertFalse(workspace.mountedTabIDs.contains(.site("a")))
        XCTAssertEqual(workspace.state(for: "a").screen, .registry)
    }

    func testActivateTabAtIndexFollowsTabOrder() {
        let workspace = Workspace()
        workspace.reconcile(siteIDs: ["a", "b"])

        workspace.activateTab(at: 2)
        XCTAssertEqual(workspace.activeTabID, .site("b"))

        workspace.activateTab(at: 9)
        XCTAssertEqual(workspace.activeTabID, .site("b"), "Out-of-range indexes are ignored.")
    }

    func testReconcileDropsRemovedSitesAndFallsBackToOverview() {
        let workspace = Workspace()
        workspace.reconcile(siteIDs: ["a", "b"])
        workspace.activate(.site("a"))

        workspace.reconcile(siteIDs: ["b"])

        XCTAssertNil(workspace.siteStates["a"])
        XCTAssertEqual(workspace.activeTabID, .overview)
        XCTAssertFalse(workspace.recency.contains(.site("a")))
    }
}
