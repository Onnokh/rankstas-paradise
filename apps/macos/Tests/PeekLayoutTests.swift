import XCTest
@testable import RankstasParadise

final class PeekLayoutTests: XCTestCase {
    private let size = CGSize(width: 1100, height: 680)

    func testClosedPeekCardsAreExactlyTheirPillsAndContentStaysInPlace() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: PeekProgress.closed)
        XCTAssertEqual(layout.contentOffset, 0)
        for index in 0..<5 {
            XCTAssertEqual(layout.cardFrame(index), layout.tabFrame(index))
        }
        XCTAssertEqual(layout.tabBarOpacity, 1)
    }

    func testStripCardsGrowDownFromTheirPillsAndPushContentByTheStripHeight() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: PeekProgress.strip)
        for index in 0..<5 {
            let card = layout.cardFrame(index)
            let pill = layout.tabFrame(index)
            XCTAssertEqual(card.minX, pill.minX, accuracy: 0.001)
            XCTAssertEqual(card.minY, pill.minY, accuracy: 0.001)
            XCTAssertEqual(card.width, pill.width, accuracy: 0.001)
            XCTAssertEqual(card.height, layout.cardHeight(forWidth: pill.width), accuracy: 0.001)
        }
        XCTAssertEqual(layout.contentOffset, layout.stripHeight, accuracy: 0.001)
        XCTAssertEqual(layout.cardFrame(0).maxY + PeekLayout.stripPadding, layout.tabBarHeight + layout.stripHeight, accuracy: 0.001)
    }

    func testHalfRevealGrowsTheCardHalfway() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: 0.5)
        let pill = layout.tabFrame(2)
        let full = layout.cardHeight(forWidth: pill.width)
        XCTAssertEqual(layout.cardFrame(2).height, pill.height + (full - pill.height) / 2, accuracy: 0.001)
        XCTAssertEqual(layout.contentOffset, layout.stripHeight / 2, accuracy: 0.001)
    }

    func testGridPushesContentOutOfViewFadesTabsAndCentresTheBlock() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: PeekProgress.grid)
        XCTAssertEqual(layout.contentOffset, size.height - layout.tabBarHeight, accuracy: 0.001)
        XCTAssertEqual(layout.tabBarOpacity, 0)

        let block = CGRect(origin: layout.gridOrigin, size: layout.gridBlockSize)
        XCTAssertEqual(block.midX, size.width / 2, accuracy: 0.001)
        XCTAssertEqual(block.midY, size.height / 2, accuracy: 0.001)
        for index in 0..<5 {
            XCTAssertTrue(block.contains(layout.gridFrame(index)))
            XCTAssertEqual(layout.cardFrame(index), layout.gridFrame(index))
        }
    }

    func testTitleBarGrowsWithTheTrafficLightsAndContentIsInset() {
        let chrome = WindowChrome(tabsLeadingX: 90, buttonsCenterY: 26)
        let layout = PeekLayout(size: size, tabCount: 3, progress: PeekProgress.closed, chrome: chrome)
        XCTAssertEqual(layout.tabBarHeight, 52)
        XCTAssertEqual(layout.contentFrame.minY, 52)
        XCTAssertEqual(layout.contentFrame.minX, PeekLayout.contentInset)
        XCTAssertEqual(layout.contentFrame.maxX, size.width - PeekLayout.contentInset)
        XCTAssertEqual(layout.contentFrame.maxY, size.height - PeekLayout.contentInset)
    }

    func testTabPillsShareTheTrafficLightsRow() {
        let chrome = WindowChrome(tabsLeadingX: 90, buttonsCenterY: 16)
        let layout = PeekLayout(size: size, tabCount: 3, progress: PeekProgress.closed, chrome: chrome)
        XCTAssertEqual(layout.peekButtonFrame.minX, 90)
        XCTAssertEqual(layout.peekButtonFrame.midY, 16, accuracy: 0.001)
        XCTAssertEqual(layout.tabFrame(0).minX, 90 + PeekLayout.peekButtonSize + PeekLayout.tabSpacing, accuracy: 0.001)
        XCTAssertEqual(layout.tabFrame(0).midY, 16, accuracy: 0.001)
        XCTAssertEqual(layout.tabFrame(1).minX, layout.tabFrame(0).minX + layout.tabWidth + PeekLayout.tabSpacing, accuracy: 0.001)
    }

    /// Every tab is a site and fills the two-column grid under the heading; the Overview's
    /// summary card, no tab, stands to the left of them two rows tall.
    func testGridPutsTheOverviewCardLeftSpanningTwoRowsAndEverySiteInTwoColumns() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: PeekProgress.grid)
        let overview = layout.overviewCardFrame
        XCTAssertEqual(overview, layout.overviewGridFrame, "In the grid the card is home.")
        let first = layout.gridFrame(0)
        let second = layout.gridFrame(1)
        let third = layout.gridFrame(2)

        XCTAssertEqual(overview.minX, layout.gridOrigin.x, accuracy: 0.001)
        XCTAssertEqual(overview.height, first.height * 2 + PeekLayout.gridGap, accuracy: 0.001)
        XCTAssertEqual(first.minX, overview.maxX + PeekLayout.gridGap, accuracy: 0.001)
        XCTAssertEqual(first.minY, overview.minY, accuracy: 0.001)
        XCTAssertEqual(second.minX, first.maxX + PeekLayout.gridGap, accuracy: 0.001)
        XCTAssertEqual(second.size, first.size)
        XCTAssertEqual(third.minX, first.minX, accuracy: 0.001)
        XCTAssertEqual(third.minY, first.maxY + PeekLayout.gridGap, accuracy: 0.001)
        XCTAssertEqual(layout.gridRows, 3)
        XCTAssertEqual(layout.gridHeadingFrame.minX, first.minX, accuracy: 0.001)
        XCTAssertEqual(layout.gridHeadingFrame.maxY, first.minY, accuracy: 0.001)
        let block = CGRect(origin: layout.gridOrigin, size: layout.gridBlockSize)
        XCTAssertTrue(block.contains(overview))
    }

    /// The overview card has no pill to grow from, so it waits off the window's left edge
    /// through the bar and the strip, and travels to its place on the morph, the number the
    /// site cards travel on, so the grid arrives as one.
    func testOverviewCardWaitsOffTheLeftEdgeAndTravelsInOnTheMorph() {
        for progress in [PeekProgress.closed, PeekProgress.strip] {
            let layout = PeekLayout(size: size, tabCount: 4, progress: progress)
            XCTAssertLessThanOrEqual(layout.overviewCardFrame.maxX, 0, "Off the window at progress \(progress).")
            XCTAssertEqual(layout.overviewCardOpacity, 0)
        }
        let halfway = 1 + PeekLayout.morphDeadzone + (1 - PeekLayout.morphDeadzone) / 2
        let mid = PeekLayout(size: size, tabCount: 4, progress: halfway)
        let home = mid.overviewGridFrame
        XCTAssertEqual(mid.overviewCardFrame.minX, (-home.width + home.minX) / 2, accuracy: 0.001, "Halfway along its travel.")
        XCTAssertEqual(mid.overviewCardFrame.minY, home.minY, accuracy: 0.001, "It travels level.")
        XCTAssertEqual(mid.overviewCardOpacity, 0.5, accuracy: 0.0001)
        XCTAssertEqual(PeekLayout(size: size, tabCount: 4, progress: PeekProgress.grid).overviewCardOpacity, 1)
    }

    func testOvershootPastTheStripStretchesItWithoutStartingTheMorph() {
        let layout = PeekLayout(size: size, tabCount: 5, progress: 1 + PeekLayout.morphDeadzone / 2)
        XCTAssertEqual(layout.morph, 0)
        XCTAssertGreaterThan(layout.reveal, 1)
        XCTAssertGreaterThan(layout.contentOffset, layout.stripHeight)
    }

    func testHalfwayMorphInterpolatesEveryCardFrame() {
        let halfway = 1 + PeekLayout.morphDeadzone + (1 - PeekLayout.morphDeadzone) / 2
        let layout = PeekLayout(size: size, tabCount: 5, progress: halfway)
        XCTAssertEqual(layout.morph, 0.5, accuracy: 0.0001)
        let strip = layout.stripFrame(3)
        let grid = layout.gridFrame(3)
        let card = layout.cardFrame(3)
        XCTAssertEqual(card.minX, (strip.minX + grid.minX) / 2, accuracy: 0.001)
        XCTAssertEqual(card.width, (strip.width + grid.width) / 2, accuracy: 0.001)
    }
}
