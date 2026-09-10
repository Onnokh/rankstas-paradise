import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

@MainActor
final class PeekOverlayTests: XCTestCase {
    /// A card holds a still, never a live screen. A live screen is laid out again on every
    /// frame of the peek — 13 ms of main thread per frame against 8 with stills, and 2-8
    /// dropped frames per run against none. An NSScrollView in the tree is the tell, since
    /// every screen scrolls and a still does not. Checked by neutering: put a `TabScreen`
    /// back in the card and this fails.
    func testACardHoldsAStillAndNotALiveScreen() {
        let model = OverviewModel.preview
        let workspace = Workspace()
        workspace.reconcile(siteIDs: model.sites.map(\.id))

        let overlay = PeekOverlay(
            layout: PeekLayout(
                size: CGSize(width: 1400, height: 900),
                tabCount: workspace.tabs.count,
                progress: PeekProgress.grid
            ),
            workspace: workspace,
            model: model,
            favicons: FaviconStore(),
            snapshots: TabSnapshots(),
            showsShortcuts: false,
            onSelect: { _ in }
        )

        let host = NSHostingView(rootView: overlay)
        host.frame = CGRect(x: 0, y: 0, width: 1400, height: 900)
        host.layoutSubtreeIfNeeded()

        XCTAssertEqual(scrollViews(in: host), 0, "A peek card mounted a live, scrollable screen.")
    }

    private func scrollViews(in view: NSView) -> Int {
        (view is NSScrollView ? 1 : 0) + view.subviews.reduce(0) { $0 + scrollViews(in: $1) }
    }
}
