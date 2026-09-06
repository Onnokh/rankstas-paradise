import SwiftUI

/// The title bar area behind the tabs. The pills themselves are drawn by `PeekOverlay`,
/// because a peek card is a pill that has grown; keeping them one view means nothing is
/// swapped or redrawn when a drag begins.
struct TabBar: View {
    let layout: PeekLayout
    let onPeek: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Palette.void
                .modifier(WindowDragArea())

            let button = layout.peekButtonFrame
            PeekButton(action: onPeek)
                .frame(width: button.width, height: button.height)
                .position(x: button.midX, y: button.midY)
                .opacity(layout.tabBarOpacity)
                .allowsHitTesting(layout.tabBarOpacity > 0.5)
        }
        .frame(width: layout.size.width, height: layout.tabBarHeight)
    }
}

/// Steps the peek through its stages, the same as ⌘⇧P.
private struct PeekButton: View {
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(.primary.opacity(isHovering ? 0.08 : 0))
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help("Peek at all projects (⌘⇧P)")
        .accessibilityLabel("Peek at projects")
    }
}

/// Icon and title of a tab. Shared by the bar's pills and the peek cards' headers, so a card
/// starts out pixel-identical to the pill it grows from.
struct TabPillLabel: View {
    let title: String
    /// The site's favicon; falls back to a globe.
    var icon: Image? = nil
    /// The tab's ⌘-number, shown at the trailing edge while Command is held.
    var shortcut: Int? = nil
    var showsShortcut = false
    /// Carries the guide's acid headband, the way its nav marks the active row.
    var isActive = false
    let height: CGFloat
    /// The favicon's distance from the pill's leading edge, and the cap's from the trailing
    /// one: `PeekLayout.cardInset`, so a card's header lines up with the preview below it.
    let inset: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let icon {
                    icon
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        // Concentric with the pill's corner: the icon sits close enough to it
                        // now that a mismatched radius would show.
                        .clipShape(.rect(cornerRadius: max(PeekLayout.cardCornerRadius - inset, 3)))
                } else {
                    Image(systemName: "globe")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: PeekLayout.tabIconSize, height: PeekLayout.tabIconSize)
            Text(title)
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 0)

            HeadbandMarker(isActive: isActive)

            if let shortcut, showsShortcut {
                // A key cap. The symbol image aligns to cap height, unlike the "⌘" glyph,
                // so the pair sits centred in its box. It claims its width only while
                // Command is held, which is what nudges the band along beside it.
                HStack(spacing: 1) {
                    Image(systemName: "command")
                    Text(String(shortcut))
                        .monospacedDigit()
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.primary.opacity(0.8))
                .padding(.horizontal, 5)
                .frame(height: 18)
                .background(.primary.opacity(0.1), in: .rect(cornerRadius: 4))
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
        }
        .padding(.horizontal, inset)
        .frame(height: height)
        // Both on the label rather than on the band or the cap: each one's width is what
        // moves its neighbours, so they only glide if the whole row's layout is inside the
        // same animation.
        .animation(.snappy(duration: 0.24), value: isActive)
        .animation(.snappy(duration: 0.18), value: showsShortcut)
    }
}

/// Lets the empty tab bar area move the window, as a title bar would.
private struct WindowDragArea: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.gesture(WindowDragGesture())
        } else {
            content
        }
    }
}
