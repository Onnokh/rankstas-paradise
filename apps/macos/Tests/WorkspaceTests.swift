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
