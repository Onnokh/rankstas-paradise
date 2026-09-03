import SwiftUI

/// The title bar area behind the tabs. The pills themselves are drawn by `PeekOverlay`,
/// because a peek card is a pill that has grown; keeping them one view means nothing is
/// swapped or redrawn when a drag begins.
struct TabBar: View {
    let layout: PeekLayout

    var body: some View {
        Color(nsColor: .underPageBackgroundColor)
            .frame(width: layout.size.width, height: layout.tabBarHeight)
            .modifier(WindowDragArea())
    }
}

/// Icon and title of a tab. Shared by the bar's pills and the peek cards' headers, so a card
/// starts out pixel-identical to the pill it grows from.
struct TabPillLabel: View {
    let title: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "globe")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 0)
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
