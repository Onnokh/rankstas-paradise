import SwiftUI

/// The active site's screens, one icon each, standing on the canvas beside the pane.
///
/// The rail is window chrome, like the tab bar: it sits on the void, not in the pane, so the
/// pane stays one surface and its rounded corner is kept. It appears only while a site tab is
/// active; the overview has one screen and gets the full width. Choosing a screen is an
/// instant pane swap, the same as choosing a tab.
///
/// Every measure comes from the pane's own inset, so the rail reads as part of the same
/// grid: an icon starts where the pane would have, `PeekLayout.contentInset` from the window
/// edge, and stands the same inset off the pane; the first icon is centred on the pane's
/// header row.
struct ScreenRail: View {
    @Bindable var state: SiteTabState

    static let iconSize: CGFloat = 40
    static let spacing: CGFloat = 8
    /// The strip taken off the pane: an icon and the inset between it and the pane. The inset
    /// on the window side is the pane's own, already in the pane's frame.
    static let width: CGFloat = iconSize + PeekLayout.contentInset

    var body: some View {
        VStack(spacing: Self.spacing) {
            ForEach(SiteScreen.allCases) { screen in
                ScreenRailButton(screen: screen, isActive: state.screen == screen) {
                    state.screen = screen
                }
            }
            Spacer(minLength: 0)
        }
        // The first icon shares the header row's centre line.
        .padding(.top, (SiteTabScreen.headerHeight - Self.iconSize) / 2)
        .frame(width: Self.width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Screens")
    }
}

private struct ScreenRailButton: View {
    let screen: SiteScreen
    let isActive: Bool
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: screen.symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(isActive ? .primary : .secondary)
                .frame(width: ScreenRail.iconSize, height: ScreenRail.iconSize)
                // The active screen is a raised surface with a hairline, like a peek card;
                // a hovered one only hints.
                .background(
                    RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                        .fill(isActive ? Palette.raised : .primary.opacity(isHovering ? 0.06 : 0))
                )
                .overlay {
                    if isActive {
                        RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius)
                            .strokeBorder(Palette.line)
                    }
                }
                // The headband stands in the gap between the window edge and the icon,
                // centred in it, the way it marks the active row in the guide's nav.
                .overlay(alignment: .leading) {
                    Headband()
                        .fill(Palette.acid)
                        .frame(width: Headband.markerSize.height, height: Headband.markerSize.width)
                        .offset(x: -(PeekLayout.contentInset + Headband.markerSize.height) / 2)
                        .opacity(isActive ? 1 : 0)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(screen.title)
        .accessibilityLabel(screen.title)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .animation(.snappy(duration: 0.2), value: isActive)
    }
}
