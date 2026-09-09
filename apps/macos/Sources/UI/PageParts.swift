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

// MARK: - Filter chip

/// One filter as a chip carrying its own count: what it would keep, and how many rows it
/// holds. The chosen ones take the accent; the rest wait inside a hairline, so the row reads
/// as a set of choices rather than a row of filled buttons.
///
/// Shared by every screen that narrows a list by kind, so those screens cannot drift into
/// two looks for one control. A chip whose count is zero is shown, disabled, rather than
/// dropped: "no title changes at all" and "nothing aimed at nothing" are both worth reading
/// off a screen, and a chip that left would ask the reader to notice an absence.
struct FilterChip: View {
    let label: String
    /// How many rows this chip holds. Nil for a chip that is not a tally of one kind.
    var count: Int? = nil
    /// An SF Symbol before the label, for a kind that carries one.
    var symbol: String? = nil
    let isOn: Bool
    let action: () -> Void

    /// A kind the list holds none of. Still drawn, and not clickable: selecting it would
    /// leave an empty list, which is not a question anybody is asking.
    private var isEmpty: Bool { count == 0 }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.caption2)
                }
                Text(label)
                    .font(.caption.weight(isOn ? .semibold : .regular))
                if let count {
                    Text(count.formatted())
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(isOn ? .secondary : .tertiary)
                }
            }
            .foregroundStyle(isOn ? .primary : .secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(isOn ? Palette.acid.opacity(0.16) : .clear, in: .capsule)
            .overlay(
                Capsule().strokeBorder(isOn ? Palette.acid.opacity(0.55) : Palette.line)
            )
        }
        .buttonStyle(.plain)
        .disabled(isEmpty)
        .opacity(isEmpty ? 0.4 : 1)
        .animation(.snappy(duration: 0.15), value: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
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
