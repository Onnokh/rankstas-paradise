import AppKit
import SwiftUI
import XCTest
@testable import RankstasParadise

/// The proposals list is virtualised, and this is what says so.
///
/// A ratio rather than a duration: an absolute millisecond budget passes or fails on how
/// busy the machine is, while "544 rows cost about what 50 cost" is the property that makes
/// the list safe to hand a whole discovery run.
@MainActor
final class ProposalsListTests: XCTestCase {
    /// Rows enough to hurt: what one shadertown discovery run left behind.
    private static let long = 544
    /// About what fits on screen at once, and what the eager version used to be capped to.
    private static let short = 50

    func testALongListCostsAboutWhatAShortOneCosts() {
        // Warm the font and layout caches, so the first measurement is not the outlier.
        _ = layoutCost(Self.short)

        let short = bestOfThree(Self.short)
        let long = bestOfThree(Self.long)
        let ratio = long / short

        // Measured when this landed: 0.97 lazy, 11.2 eager — 13 ms of layout for the 544
        // rows against 522 ms. Three is clear of both, so this fails on an eager stack
        // and not on a slow machine.
        XCTAssertLessThan(
            ratio, 3,
            """
            Hosting \(Self.long) rows cost \(long * 1000) ms against \(short * 1000) ms for \
            \(Self.short) — a ratio of \(ratio). The list is building rows nobody can see.
            """
        )
    }

    private func bestOfThree(_ count: Int) -> TimeInterval {
        (0..<3).map { _ in layoutCost(count) }.min()!
    }

    /// Hosts the list at a fixed size and lays it out. The layout pass is what forces
    /// SwiftUI to build the rows, and it is the whole harness — each of these was checked
    /// by neutering, against an eager stack rather than against the lazy one, which passes
    /// either way and proves nothing:
    ///
    /// - No `NSWindow` is needed. An eager stack is caught without one.
    /// - `displayIfNeeded()` is not needed either. It forces the build too, so keeping
    ///   both hid which one mattered; the layout pass is the honest thing to time.
    /// - Drop the layout pass as well and nothing is built, so the numbers go to noise and
    ///   the test fails — which is the right way round.
    private func layoutCost(_ count: Int) -> TimeInterval {
        let list = ProposalsList(proposals: proposals(count), reach: 10, onDismiss: { _ in })
        let host = NSHostingView(rootView: ScrollView { list })
        host.frame = CGRect(x: 0, y: 0, width: 700, height: 400)

        let start = Date()
        host.layoutSubtreeIfNeeded()
        return Date().timeIntervalSince(start)
    }

    private func proposals(_ count: Int) -> [KeywordProposal] {
        (0..<count).map {
            KeywordProposal(
                keyword: "keyword \($0)",
                seed: "seed",
                source: "suggestions",
                searchVolume: 100,
                difficulty: 20,
                costPerClick: nil,
                competition: nil,
                intent: nil,
                status: "proposed",
                discoveredAt: "2026-09-08T00:00:00Z"
            )
        }
    }
}
