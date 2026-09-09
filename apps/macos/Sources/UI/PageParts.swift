import SwiftUI

// MARK: - Column

extension View {
    /// Places a view in the reading column: capped at the column width, inset from the pane's
    /// edges, and centred in whatever width the pane has.
    func column() -> some View {
        frame(maxWidth: SiteTabScreen.columnWidth, alignment: .leading)
            .padding(.horizontal, SiteTabScreen.columnInset)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Word switch

/// A choice as a row of words. The chosen one is set in primary and carries the headband
/// under it, the style guide's mark for the active item; the others wait in secondary.
struct WordSwitch<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let label: (Option) -> String
    var font: Font = .callout

    var body: some View {
        HStack(spacing: 14) {
            ForEach(options) { option in
                let isActive = option == selection
                Button {
                    selection = option
                } label: {
                    Text(label(option))
                        .font(font.weight(isActive ? .semibold : .regular))
                        .foregroundStyle(isActive ? .primary : .secondary)
                        .padding(.bottom, 4)
                        .overlay(alignment: .bottom) {
                            Headband()
                                .fill(Palette.acid)
                                .frame(height: 3)
                                .opacity(isActive ? 1 : 0)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isActive ? .isSelected : [])
            }
        }
        .animation(.snappy(duration: 0.2), value: selection)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Metric

struct Metric: View {
    let title: String
    let value: String
    var change: String? = nil
    /// The colour of the change: mint when the move is the good way, coral otherwise.
    var tint: Color? = nil
    /// A series dot before the label, tying the figure to its line in the chart.
    var dot: Color? = nil
    var footnote: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                if let dot {
                    Circle()
                        .fill(dot)
                        .frame(width: 6, height: 6)
                }
                Text(title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(value)
                    .font(.system(size: 28, weight: .medium))
                    .monospacedDigit()
                if let change {
                    Text(change)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(tint ?? .secondary)
                } else if let footnote {
                    Text(footnote)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}
