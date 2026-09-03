import SwiftUI

/// The title bar area behind the tabs. The pills themselves are drawn by `PeekOverlay`,
/// because a peek card is a pill that has grown; keeping them one view means nothing is
/// swapped or redrawn when a drag begins.
struct TabBar: View {
    let layout: PeekLayout
    let onPeek: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(nsColor: .underPageBackgroundColor)
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
    /// Shown at the trailing edge while Command is held, e.g. "⌘2".
    var shortcut: String? = nil
    var showsShortcut = false

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let icon {
                    icon
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .clipShape(.rect(cornerRadius: 3))
                } else {
                    Image(systemName: "globe")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 16, height: 16)
            Text(title)
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let shortcut {
                // A key cap: legible at pill size, quiet enough not to compete with the title.
                Text(shortcut)
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(.primary.opacity(0.8))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(.primary.opacity(0.1), in: .rect(cornerRadius: 4))
                    .opacity(showsShortcut ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: showsShortcut)
            }
        }
        .padding(.horizontal, 12)
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
