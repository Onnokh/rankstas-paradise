import Foundation

/// The peek is one continuous value: 0 is closed, 1 shows the preview strip under the tabs,
/// 2 is the full grid.
///
/// A gesture does not drive the value linearly. It teases the next stage with resistance,
/// commits once the fingers cross a threshold, and springs back if they lift early. One gesture
/// moves at most one stage.
enum PeekProgress {
    static let closed: Double = 0
    static let strip: Double = 1
    static let grid: Double = 2
    static let maximum: Double = 2

    /// Normalised trackpad travel (1 is the full pad height) that commits a stage change.
    static let commitTravel: Double = 0.10

    /// How far, in stages, the tease may move before the commit. Asymptotic, never reached.
    static let teaseLimit: Double = 0.25

    /// Flick speed, in normalised travel per second, that commits even before the threshold.
    static let flickVelocity: Double = 0.6

    /// The stages one gesture can reach from where it started: at most one stage either way.
    static func reach(from start: Double) -> ClosedRange<Double> {
        let stage = min(max(start.rounded(), closed), maximum)
        return max(stage - 1, closed)...min(stage + 1, maximum)
    }

    /// The stage a gesture is heading for. `direction` is positive for a downward swipe.
    static func target(from start: Double, direction: Double) -> Double {
        let range = reach(from: start)
        let next = start.rounded() + (direction >= 0 ? 1 : -1)
        return min(max(next, range.lowerBound), range.upperBound)
    }

    /// Resisted movement towards the target before the commit: quick at first, then it
    /// stiffens and levels off, so the finger feels the detent.
    static func tease(travel: Double) -> Double {
        teaseLimit * (1 - exp(-abs(travel) / (commitTravel * 0.5)))
    }

    /// Whether the fingers have gone far or fast enough to commit the stage change.
    static func commits(travel: Double, velocity: Double) -> Bool {
        abs(travel) >= commitTravel || (abs(velocity) >= flickVelocity && travel.sign == velocity.sign)
    }
}
