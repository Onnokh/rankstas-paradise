import XCTest
@testable import RankstasParadise

final class PeekProgressTests: XCTestCase {
    func testOneGestureReachesAtMostOneStage() {
        XCTAssertEqual(PeekProgress.reach(from: PeekProgress.closed), 0...1)
        XCTAssertEqual(PeekProgress.reach(from: PeekProgress.strip), 0...2)
        XCTAssertEqual(PeekProgress.reach(from: PeekProgress.grid), 1...2)
    }

    func testTargetIsTheNextStageInTheSwipeDirectionWithinReach() {
        XCTAssertEqual(PeekProgress.target(from: PeekProgress.closed, direction: 1), PeekProgress.strip)
        XCTAssertEqual(PeekProgress.target(from: PeekProgress.strip, direction: 1), PeekProgress.grid)
        XCTAssertEqual(PeekProgress.target(from: PeekProgress.strip, direction: -1), PeekProgress.closed)
        XCTAssertEqual(PeekProgress.target(from: PeekProgress.grid, direction: 1), PeekProgress.grid, "Nothing above the grid.")
        XCTAssertEqual(PeekProgress.target(from: PeekProgress.closed, direction: -1), PeekProgress.closed, "Nothing below closed.")
    }

    func testTeaseIsResistedAndNeverReachesTheLimit() {
        XCTAssertEqual(PeekProgress.tease(travel: 0), 0)
        let early = PeekProgress.tease(travel: PeekProgress.commitTravel * 0.25)
        let late = PeekProgress.tease(travel: PeekProgress.commitTravel)
        XCTAssertGreaterThan(early, 0)
        XCTAssertGreaterThan(late, early)
        XCTAssertLessThan(late, PeekProgress.teaseLimit)
        XCTAssertLessThanOrEqual(PeekProgress.tease(travel: 10), PeekProgress.teaseLimit)
    }

    func testCommitNeedsTheThresholdOrAFlickInTheSameDirection() {
        XCTAssertFalse(PeekProgress.commits(travel: PeekProgress.commitTravel * 0.9, velocity: 0))
        XCTAssertTrue(PeekProgress.commits(travel: PeekProgress.commitTravel, velocity: 0))
        XCTAssertTrue(PeekProgress.commits(travel: 0.01, velocity: PeekProgress.flickVelocity))
        XCTAssertFalse(PeekProgress.commits(travel: 0.01, velocity: -PeekProgress.flickVelocity), "A flick the other way does not commit.")
    }
}
