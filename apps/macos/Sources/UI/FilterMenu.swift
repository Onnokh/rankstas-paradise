import SwiftUI

/// One of the things a `FilterMenu` can keep a list to: a site, a Log kind, a verdict.
struct FilterOption<ID: Hashable>: Identifiable {
    let id: ID
    let label: String
    let icon: FilterIcon
    /// How many rows the option holds. Nil for an option that is not a tally of one kind.
    var count: Int? = nil
    /// The tooltip on the option's row.
    var help: String? = nil
}

/// The picture beside an option: a site's favicon, or an SF Symbol in a tinted disc.
enum FilterIcon {
    case image(Image)
    case symbol(String, tint: Color)
}

/// A list narrowed by kind, as one control: a pill naming what is kept, and a menu of the
/// kinds under it with a check beside each.
///
/// The pill carries the choice three ways. Nothing chosen reads "All sites" over a cluster
/// of every icon; one choice reads its own name over its own icon; several read "2 sites"
/// over the two icons. The cluster is the part that says it without words: one disc, a
/// pair, a grid.
///
/// An empty selection means every option — the honest default, since the reader has not
/// said what they are looking for yet — and the menu's first row, "All", is that default
/// made visible. Choosing every option collapses back to it: "all four" and "all" are the
/// same list, and the pill should say so.
///
/// An option whose count is zero stays in the menu, disabled: "no title changes at all" is
/// itself worth reading off the screen, and a row that left would ask the reader to notice
/// an absence.
struct FilterMenu<ID: Hashable>: View {
    let options: [FilterOption<ID>]
    /// The options kept. Empty keeps every one.
    @Binding var selection: Set<ID>
    /// The pill's word when nothing is chosen: "All sites".
    let allLabel: String
    /// The pill's word for several choices, from their number: "2 sites".
    let severalLabel: (Int) -> String
    var font: Font = .subheadline

    @State private var isOpen = false
    @State private var isHovering = false

    /// The chosen options, in the menu's order. A selection can name an option that has
    /// since left the list — a removed site — and that name is not shown.
    private var chosen: [FilterOption<ID>] {
        options.filter { selection.contains($0.id) }
    }

    /// The options the cluster draws: the chosen ones, or every one when nothing is chosen.
    private var clustered: [FilterOption<ID>] {
        chosen.isEmpty ? options : chosen
    }

    private var title: String {
        switch chosen.count {
        case 0: allLabel
        case 1: chosen[0].label
        default: severalLabel(chosen.count)
        }
    }

    /// The sum of the option counts, for the All row. Nil when the options are not tallies.
    private var total: Int? {
        let counts = options.compactMap(\.count)
        return counts.count == options.count ? counts.reduce(0, +) : nil
    }

    /// Every option that holds a row, so can be picked.
    private var pickable: Set<ID> {
        Set(options.filter { $0.count != 0 }.map(\.id))
    }

    var body: some View {
        Button {
            isOpen.toggle()
        } label: {
            // The pill is roomy on purpose: the cluster is small, and the air around it is
            // what lets a pair of 9-point icons read as a picture rather than as noise.
            HStack(spacing: 10) {
                IconCluster(options: clustered, size: 20)
                Text(title)
                    .font(font.weight(.medium))
                    .lineLimit(1)
                    // "2 sites" to "3 sites" rolls the digit rather than swapping the word.
                    .contentTransition(.numericText())
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.leading, 2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.primary.opacity(isHovering || isOpen ? 0.12 : 0.08), in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .popover(isPresented: $isOpen, arrowEdge: .bottom) {
            menu
                .presentationBackground(Palette.raised)
        }
        .animation(.snappy(duration: 0.28), value: selection)
        .accessibilityValue(title)
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 2) {
            MenuRow(
                label: allLabel,
                count: total,
                isOn: chosen.isEmpty,
                isEmpty: false,
                action: { selection.removeAll() }
            ) {
                IconCluster(options: options, size: 20)
            }

            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
                .padding(.vertical, 6)

            ForEach(options) { option in
                MenuRow(
                    label: option.label,
                    count: option.count,
                    isOn: selection.contains(option.id),
                    isEmpty: option.count == 0,
                    action: { toggle(option.id) }
                ) {
                    OptionIcon(icon: option.icon, size: 20)
                }
                .help(option.help ?? "")
            }
        }
        .padding(8)
        .frame(minWidth: 240)
    }

    private func toggle(_ id: ID) {
        var next = selection
        if next.contains(id) {
            next.remove(id)
        } else {
            next.insert(id)
        }
        // Every option a reader can pick is picked: that is "All", so say "All".
        if next.isSuperset(of: pickable) {
            next.removeAll()
        }
        selection = next
    }
}

// MARK: - Rows

/// One line of the menu: a check disc, the option's picture, its name and its count.
private struct MenuRow<Icon: View>: View {
    let label: String
    let count: Int?
    let isOn: Bool
    /// A kind the list holds none of. Drawn, and not clickable: selecting it would leave an
    /// empty list, which is not a question anybody is asking.
    let isEmpty: Bool
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                CheckDisc(isOn: isOn)
                icon()
                Text(label)
                    .font(.callout)
                    .lineLimit(1)
                Spacer(minLength: 16)
                if let count {
                    Text(count.formatted())
                        .font(.callout)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(isOn ? .primary : .secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.primary.opacity(isHovering ? 0.07 : 0), in: .rect(cornerRadius: 8))
            .contentShape(.rect(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .disabled(isEmpty)
        .opacity(isEmpty ? 0.4 : 1)
        .animation(.snappy(duration: 0.15), value: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// The mark beside a chosen row: a filled acid disc with a tick, or an empty ring waiting.
private struct CheckDisc: View {
    let isOn: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(isOn ? Palette.acid : .clear)
            Circle()
                .strokeBorder(.primary.opacity(isOn ? 0 : 0.25), lineWidth: 1.5)
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.black)
                .scaleEffect(isOn ? 1 : 0.4)
                .opacity(isOn ? 1 : 0)
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

// MARK: - Icons

/// An option's picture at a given size. A favicon keeps its own colours inside a rounded
/// square, the way the tab bar draws it; a symbol sits in a disc of its own tint.
private struct OptionIcon: View {
    let icon: FilterIcon
    let size: CGFloat

    var body: some View {
        switch icon {
        case .image(let image):
            image
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: size, height: size)
                .clipShape(.rect(cornerRadius: size * 0.28))
        case .symbol(let name, let tint):
            ZStack {
                Circle().fill(tint.opacity(0.22))
                Image(systemName: name)
                    .font(.system(size: size * 0.5, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .frame(width: size, height: size)
        }
    }
}

/// The chosen options as one picture in a square: one icon fills it, two overlap corner to
/// corner with the front one cut out of the one behind, three or four sit in a grid — the
/// third's missing corner drawn as a faint disc, so three reads as "three of a set" and not
/// as a smaller picture. More than four shows the first four; the word beside it carries the
/// number.
///
/// Each icon is placed by offset rather than by layout, and keyed by its option, so a choice
/// added or taken away glides the others into their new corners instead of redrawing them.
private struct IconCluster<ID: Hashable>: View {
    let options: [FilterOption<ID>]
    let size: CGFloat

    private static var ring: CGFloat { 1.5 }

    private var shown: [FilterOption<ID>] { Array(options.prefix(4)) }

    /// The diameter of one icon at this count.
    private var diameter: CGFloat {
        switch shown.count {
        case 0, 1: size
        case 2: size * 0.68
        default: (size - 2) / 2
        }
    }

    /// Where the icon at `index` sits, relative to the square's centre.
    private func offset(_ index: Int) -> CGSize {
        let reach = (size - diameter) / 2
        switch shown.count {
        case 0, 1: return .zero
        case 2: return index == 0 ? CGSize(width: -reach, height: -reach) : CGSize(width: reach, height: reach)
        default:
            let x: CGFloat = index % 2 == 0 ? -reach : reach
            let y: CGFloat = index < 2 ? -reach : reach
            return CGSize(width: x, height: y)
        }
    }

    var body: some View {
        ZStack {
            if shown.count == 3 {
                Circle()
                    .fill(.primary.opacity(0.08))
                    .frame(width: diameter, height: diameter)
                    .offset(offset(3))
                    .transition(.opacity)
            }
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, option in
                OptionIcon(icon: option.icon, size: diameter)
                    .mask {
                        // The front icon of a pair is cut out of the one behind, with a
                        // hairline of air between them, whatever surface the pill sits on.
                        if shown.count == 2, index == 0 {
                            ZStack {
                                Rectangle()
                                Circle()
                                    .frame(width: diameter + Self.ring * 2, height: diameter + Self.ring * 2)
                                    .offset(
                                        x: offset(1).width - offset(0).width,
                                        y: offset(1).height - offset(0).height
                                    )
                                    .blendMode(.destinationOut)
                            }
                            .compositingGroup()
                        } else {
                            Rectangle()
                        }
                    }
                    .offset(offset(index))
                    .transition(.scale(scale: 0.5).combined(with: .opacity))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
