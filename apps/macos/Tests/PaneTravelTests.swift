import SwiftUI
import XCTest
@testable import RankstasParadise

/// The pane's travel: how far it goes, and that it goes as a transform.
@MainActor
final class PaneTravelTests: XCTestCase {
    /// The grid puts the pane fully below the window, so choosing a project there means the
    /// swap happens off screen and the pane carries the chosen tab back up.
    func testTheGridPutsThePaneFullyOutOfTheWindow() {
        let size = CGSize(width: 1200, height: 800)
        let layout = PeekLayout(size: size, tabCount: 5, progress: PeekProgress.grid)
        let pane = layout.contentFrame

        XCTAssertEqual(
            pane.minY + layout.contentOffset,
            size.height,
            accuracy: 0.001,
            "The pane's top reaches the window's bottom edge: nothing of it is left on screen."
        )
    }

    /// The travel is one transform on the pane, not a position change SwiftUI pushes down to
    /// every row in it. Checked by neutering: a plain animated `.offset` instead of this cost
    /// 180-350 ms of over-budget frames per click. See `RootView.select`.
    func testTheTravelIsAPureVerticalTranslation() {
        let transform = SlideY(y: 240).effectValue(size: CGSize(width: 1000, height: 600))

        XCTAssertEqual(transform, ProjectionTransform(CGAffineTransform(translationX: 0, y: 240)))
    }

    /// The animation drives `y` through `animatableData`, so the pane is interpolated by the
    /// same spring that retracts the cards and the two move as one.
    func testTheAnimationDrivesTheTravel() {
        var effect = SlideY(y: 0)
        effect.animatableData = 120

        XCTAssertEqual(effect.y, 120)
        XCTAssertEqual(effect.animatableData, 120)
    }
}
