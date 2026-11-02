import SwiftUI

/// A run drawn small: the period as a line over a faint fill, the period before as a grey line
/// behind it. No axes and no hover — a spark is a shape, and the figure above it is the
/// number. Drawn as a path rather than with Charts, because a page can hold one per project.
struct Spark: View {
    let run: ComparisonRun
    let color: Color
    /// Whether the shape stands on a floor of zero. A rate wants its own range: a
    /// click-through rate between 8 and 9 percent drawn from nothing is a flat line.
    var fromZero = true
    /// Whether the line is drawn over a fill. See `OverviewSource.fills`.
    var fills = true

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let now = run.current.map(\.value)
            let was = run.previous
            let top = max((now + was).max() ?? 0, 0.0001)
            let floor = fromZero ? 0 : ((now + was).min() ?? 0)
            ZStack {
                if was.count > 1 {
                    Self.line(was, in: size, top: top, floor: floor)
                        .stroke(Color.secondary.opacity(0.55), style: StrokeStyle(lineWidth: 1, lineJoin: .round))
                }
                if now.count > 1 {
                    if fills {
                        Self.area(now, in: size, top: top, floor: floor)
                            .fill(LinearGradient(colors: [color.opacity(0.18), color.opacity(0.01)], startPoint: .top, endPoint: .bottom))
                    }
                    Self.line(now, in: size, top: top, floor: floor)
                        .stroke(color, style: StrokeStyle(lineWidth: 1.4, lineJoin: .round))
                }
            }
        }
        .accessibilityHidden(true)
    }

    private static func points(_ values: [Double], in size: CGSize, top: Double, floor: Double) -> [CGPoint] {
        let step = values.count > 1 ? size.width / CGFloat(values.count - 1) : size.width
        let span = max(top - floor, 0.0001)
        return values.enumerated().map { index, value in
            CGPoint(
                x: CGFloat(index) * step,
                y: size.height - CGFloat((value - floor) / span) * (size.height - 1) - 0.5
            )
        }
    }

    private static func line(_ values: [Double], in size: CGSize, top: Double, floor: Double) -> Path {
        Path { path in path.addLines(points(values, in: size, top: top, floor: floor)) }
    }

    /// Built point by point: `addLines` starts a subpath of its own, which would close the
    /// fill from the last point straight back to the first and draw a wedge.
    private static func area(_ values: [Double], in size: CGSize, top: Double, floor: Double) -> Path {
        let marks = points(values, in: size, top: top, floor: floor)
        return Path { path in
            guard let first = marks.first, let last = marks.last else { return }
            path.move(to: CGPoint(x: first.x, y: size.height))
            for mark in marks {
                path.addLine(to: mark)
            }
            path.addLine(to: CGPoint(x: last.x, y: size.height))
            path.closeSubpath()
        }
    }
}
