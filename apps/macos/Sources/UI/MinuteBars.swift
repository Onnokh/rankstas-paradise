import SwiftUI

/// The colour of everything that comes from the analytics provider: a site's live dot, the
/// visits dot in a metric strip, the realtime bars, the visits chart and the feed's events.
let visitsColor = Palette.lilac

/// One rounded bar per minute, oldest on the left. A quiet minute keeps a stub in the line
/// colour, so the row always reads as the whole window and not as however many minutes had
/// someone on the site.
struct MinuteBars: View {
    let values: [Double]
    /// When the newest bar was read. Each bar is one minute; the last is the minute running
    /// then, so a bar's time is that instant less the minutes between them.
    let fetchedAt: Date?

    @Environment(\.isTabPreview) private var isPreview
    @State private var hovered: Int?

    private static let stub: CGFloat = 6

    var body: some View {
        GeometryReader { geometry in
            let peak = max(values.max() ?? 0, 1)
            let count = max(values.count, 1)
            let slot = geometry.size.width / CGFloat(count)

            HStack(alignment: .bottom, spacing: 3) {
                ForEach(values.indices, id: \.self) { index in
                    let value = values[index]
                    RoundedRectangle(cornerRadius: 2)
                        .fill(value > 0 ? visitsColor : Palette.line)
                        .opacity(hovered == nil || hovered == index ? 1 : 0.4)
                        .frame(height: value > 0 ? max(Self.stub, geometry.size.height * value / peak) : Self.stub)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .bottom)
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
            // Always present and toggled by opacity, never inserted: a sibling appearing
            // beside the tracking view would end the hover (see VisitsCard).
            .overlay(alignment: .topLeading) {
                if !values.isEmpty {
                    let index = min(hovered ?? 0, values.count - 1)
                    // Above the bar, kept inside the card's width at both ends.
                    let centre = slot * (CGFloat(index) + 0.5)
                    MinuteLabel(count: values[index], minute: minute(index))
                        .fixedSize()
                        .alignmentGuide(.leading) { label in
                            -min(max(centre - label.width / 2, 0), max(geometry.size.width - label.width, 0))
                        }
                        .alignmentGuide(.top) { label in label.height + 8 }
                        .opacity(hovered == nil ? 0 : 1)
                        .allowsHitTesting(false)
                }
            }
        }
        .animation(.snappy(duration: 0.3), value: values)
        .accessibilityHidden(true)
    }

    private func minute(_ index: Int) -> Date? {
        fetchedAt?.addingTimeInterval(-Double(values.count - 1 - index) * 60)
    }
}

/// The minute under the pointer: how many people, at what time.
private struct MinuteLabel: View {
    let count: Double
    let minute: Date?

    var body: some View {
        HStack(spacing: 6) {
            if let minute {
                Text(minute.formatted(date: .omitted, time: .shortened))
                    .foregroundStyle(.secondary)
            }
            Text("\(count.formatted(.number.precision(.fractionLength(0)))) \(count == 1 ? "person" : "people")")
                .fontWeight(.semibold)
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
