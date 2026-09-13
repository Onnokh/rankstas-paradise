import Charts
import SwiftUI

/// The period as a line and area in the source's colour, over the period before as a grey
/// line, the same points on the same axis: growth is the gap between the lines. No axes,
/// no legend; the figure above the chart is its caption. An earlier run that is a stand-in
/// (one total spread evenly) is dashed, so it never reads as measured days.
///
/// Hover finds the nearest point and says both values in a label above it; the label is
/// always present and shown by opacity, never inserted, so the hover survives (see
/// `MinuteBars`). Previews and stills get no hover.
struct ComparisonChart: View {
    let run: ComparisonRun
    let color: Color
    /// How a value is written in the label.
    var format: (Double) -> String = { $0.formatted(.number.precision(.fractionLength(0))) }
    /// Whether the floor is zero. A share that moves between 77 and 84 wants its own range.
    var fromZero = true

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: Int?

    var body: some View {
        GeometryReader { geometry in
            let count = max(run.current.count, 1)
            let slot = geometry.size.width / CGFloat(count)
            chart
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    guard !isPreview else { return }
                    switch phase {
                    case .active(let location):
                        hovered = min(max(Int(location.x / slot), 0), count - 1)
                    case .ended:
                        hovered = nil
                    }
                }
                .overlay(alignment: .topLeading) {
                    if !run.current.isEmpty {
                        let index = min(hovered ?? 0, run.current.count - 1)
                        let centre = slot * (CGFloat(index) + 0.5)
                        ComparisonLabel(
                            date: run.current[index].date,
                            now: format(run.current[index].value),
                            was: index < run.previous.count ? format(run.previous[index]) : nil,
                            wasIsAverage: run.previousIsAverage
                        )
                        .fixedSize()
                        .alignmentGuide(.leading) { label in
                            -min(max(centre - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                        }
                        .alignmentGuide(.top) { label in label.height + 6 }
                        .opacity(hovered == nil ? 0 : 1)
                        .allowsHitTesting(false)
                    }
                }
        }
        .accessibilityHidden(true)
    }

    private var chart: some View {
        Chart {
            RuleMark(y: .value("Value", 0))
                .foregroundStyle(Palette.line)
                .lineStyle(StrokeStyle(lineWidth: 1))

            ForEach(Array(run.previous.enumerated()), id: \.offset) { index, value in
                LineMark(x: .value("Point", index), y: .value("Was", value), series: .value("Run", "was"))
                    .foregroundStyle(Color.secondary.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1.25, lineJoin: .round, dash: run.previousIsAverage ? [3, 3] : []))
            }
            .interpolationMethod(.monotone)

            ForEach(Array(run.current.enumerated()), id: \.offset) { index, point in
                AreaMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                    .foregroundStyle(
                        LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom)
                    )
                LineMark(x: .value("Point", index), y: .value("Now", point.value), series: .value("Run", "now"))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineJoin: .round))
            }
            .interpolationMethod(.monotone)

            if let hovered, hovered < run.current.count {
                RuleMark(x: .value("Point", hovered))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .chartYScale(domain: .automatic(includesZero: fromZero))
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartPlotStyle { plot in plot.padding(.top, 2) }
    }
}

/// The point under the pointer: its day, the value now, and the value the period before.
private struct ComparisonLabel: View {
    let date: Date
    let now: String
    let was: String?
    let wasIsAverage: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(date.formatted(.dateTime.day().month(.abbreviated)))
                .foregroundStyle(.secondary)
            Text(now)
                .fontWeight(.semibold)
            if let was {
                Text(wasIsAverage ? "was \(was) on average" : "was \(was)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.separator))
        .shadow(color: .black.opacity(0.25), radius: 6, y: 3)
    }
}
